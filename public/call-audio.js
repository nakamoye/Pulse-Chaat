'use strict';

/** Усиленное шумоподавление для звонков: браузер + Web Audio цепочка */
const PulseAudio = (() => {
  const LS_KEY = 'pulse_noise_pro';

  let audioCtx = null;
  let rawStream = null;
  let outStream = null;
  let nodes = null;
  let gateFrame = null;
  let enabled = localStorage.getItem(LS_KEY) !== '0';

  function isEnabled() {
    return enabled;
  }

  function setEnabled(on) {
    enabled = !!on;
    localStorage.setItem(LS_KEY, enabled ? '1' : '0');
  }

  function getAudioConstraints() {
    const base = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      latency: { ideal: 0 },
      voiceIsolation: { ideal: true },
    };
    const chrome = {
      googEchoCancellation: { ideal: true },
      googAutoGainControl: { ideal: true },
      googNoiseSuppression: { ideal: true },
      googHighpassFilter: { ideal: true },
      googTypingNoiseDetection: { ideal: true },
      googAudioMirroring: { ideal: false },
    };
    return { ...base, ...chrome };
  }

  function stopGate() {
    if (gateFrame) cancelAnimationFrame(gateFrame);
    gateFrame = null;
  }

  function stop() {
    stopGate();
    try {
      nodes?.source?.disconnect();
      nodes?.highpass?.disconnect();
      nodes?.lowpass?.disconnect();
      nodes?.compressor?.disconnect();
      nodes?.presence?.disconnect();
      nodes?.gateGain?.disconnect();
      nodes?.dest?.disconnect();
    } catch {
      /* ignore */
    }
    nodes = null;
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => {});
    }
    audioCtx = null;
    rawStream?.getTracks().forEach((t) => {
      if (t.readyState !== 'ended') t.stop();
    });
    rawStream = null;
    outStream = null;
  }

  function buildGraph(stream) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 48000,
    });

    const source = audioCtx.createMediaStreamSource(stream);
    const dest = audioCtx.createMediaStreamDestination();

    const highpass = audioCtx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 95;
    highpass.Q.value = 0.7;

    const lowpass = audioCtx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 11000;
    lowpass.Q.value = 0.6;

    const presence = audioCtx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2800;
    presence.gain.value = 2.2;
    presence.Q.value = 1;

    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 18;
    compressor.ratio.value = 10;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.12;

    const gateGain = audioCtx.createGain();
    gateGain.gain.value = 1;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.45;

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(presence);
    presence.connect(gateGain);
    presence.connect(analyser);
    gateGain.connect(dest);

    nodes = { source, highpass, lowpass, compressor, presence, gateGain, analyser, dest };

    const buf = new Uint8Array(analyser.fftSize);
    let level = 1;
    const openThresh = 0.018;
    const closeThresh = 0.01;
    const floor = 0.04;

    function gateTick() {
      if (!nodes) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const target = rms > (level > 0.5 ? closeThresh : openThresh) ? 1 : floor;
      level += (target - level) * (target > level ? 0.42 : 0.1);
      gateGain.gain.setTargetAtTime(level, audioCtx.currentTime, target > level ? 0.01 : 0.06);
      gateFrame = requestAnimationFrame(gateTick);
    }
    gateTick();

    if (audioCtx.state === 'suspended') audioCtx.resume();

    return dest.stream;
  }

  async function processStream(micStream) {
    rawStream = micStream;
    if (!enabled) {
      outStream = micStream;
      return outStream;
    }
    try {
      const audioOnly = new MediaStream(micStream.getAudioTracks());
      const processed = buildGraph(audioOnly);
      const videoTracks = micStream.getVideoTracks();
      outStream =
        videoTracks.length > 0
          ? new MediaStream([...processed.getAudioTracks(), ...videoTracks])
          : processed;
      return outStream;
    } catch (e) {
      console.warn('PulseAudio fallback', e);
      outStream = micStream;
      return outStream;
    }
  }

  async function capture(withVideo) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: getAudioConstraints(),
      video: withVideo
        ? {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 24 },
          }
        : false,
    });
    return processStream(stream);
  }

  async function toggleProcessing(on) {
    setEnabled(on);
    if (!rawStream) return null;
    stopGate();
    try {
      nodes?.source?.disconnect();
    } catch {
      /* ignore */
    }
    nodes = null;
    if (audioCtx && audioCtx.state !== 'closed') {
      await audioCtx.close().catch(() => {});
    }
    audioCtx = null;
    return processStream(rawStream);
  }

  function getStream() {
    return outStream || rawStream;
  }

  function setMicMuted(muted) {
    const s = getStream();
    s?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  return {
    isEnabled,
    setEnabled,
    capture,
    processStream,
    toggleProcessing,
    getStream,
    setMicMuted,
    stop,
  };
})();
