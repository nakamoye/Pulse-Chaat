'use strict';

const PulseCalls = (() => {
  const ICE = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
  };

  let api = null;
  let $ = null;
  let getMe = null;
  let getPeer = null;
  let getChats = null;

  let callId = null;
  let callType = 'audio';
  let callMembers = [];
  let localStream = null;
  let peers = new Map();
  let callTimerIv = null;
  let callStart = 0;
  let ringOsc = null;
  let ringIv = null;
  let muted = false;
  let listenOnly = false;
  let pendingIncoming = null;

  function init(deps) {
    api = deps.api;
    $ = deps.$;
    getMe = deps.getMe;
    getPeer = deps.getPeer;
    getChats = deps.getChats;
    bindUi();
  }

  function bindUi() {
    $('btn-call-audio')?.addEventListener('click', () => startOutgoing('audio'));
    $('btn-call-video')?.addEventListener('click', () => startOutgoing('video'));
    $('btn-incoming-accept')?.addEventListener('click', () => acceptIncoming());
    $('btn-incoming-reject')?.addEventListener('click', () => rejectIncoming());
    $('btn-call-hangup')?.addEventListener('click', () => hangup());
    $('btn-call-mute')?.addEventListener('click', () => toggleMute());
    $('btn-call-add')?.addEventListener('click', () => openAddParticipantModal());
    $('btn-unlock-audio')?.addEventListener('click', () => unlockAllAudio());
    $('call-hear-self')?.addEventListener('change', () => updateLocalMonitor());
    $('call-noise-pro')?.addEventListener('change', async () => {
      if (!localStream || listenOnly) return;
      localStream = await PulseAudio.toggleProcessing($('call-noise-pro').checked);
      attachLocalTile();
      await replaceAudioOnAllPeers();
    });
    $('modal-call-add-close')?.addEventListener('click', () => $('modal-call-add').classList.add('hidden'));
    document.addEventListener('click', (e) => {
      if (e.target.closest('#modal-call-add, #call-add-list')) return;
    });
  }

  function isActive() {
    return !!callId;
  }

  function myId() {
    return getMe()?.id;
  }

  function updateCallButtons() {
    const wrap = $('chat-call-actions');
    if (!wrap) return;
    wrap.classList.toggle('hidden', !getPeer?.() || isActive());
  }

  function setStatus(text) {
    const st = $('call-overlay-status');
    if (st) st.textContent = text;
  }

  function isListenOnly() {
    return !!$('call-listen-only')?.checked;
  }

  function playRing() {
    stopRing();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ringOsc = ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = 440;
      g.gain.value = 0.06;
      o.start();
      ringIv = setInterval(() => o.frequency.setValueAtTime(o.frequency.value === 440 ? 480 : 440, ctx.currentTime), 500);
      ringOsc._osc = o;
    } catch {
      /* ignore */
    }
  }

  function stopRing() {
    clearInterval(ringIv);
    ringIv = null;
    try {
      ringOsc?._osc?.stop();
      ringOsc?.close?.();
    } catch {
      /* ignore */
    }
    ringOsc = null;
  }

  function callTitle() {
    const n = callMembers.filter((m) => m.id !== myId()).length;
    if (n === 0) return 'Звонок';
    if (n === 1) return callMembers.find((m) => m.id !== myId())?.displayName || 'Звонок';
    return 'Групповой звонок · ' + (callMembers.length) + ' уч.';
  }

  function showOverlay(mode) {
    const ov = $('call-overlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    ov.dataset.mode = mode;
    $('call-overlay-name').textContent = callTitle();
    $('incoming-actions')?.classList.toggle('hidden', mode !== 'incoming');
    $('active-call-actions')?.classList.toggle('hidden', mode !== 'active' && mode !== 'outgoing');
    const addBtn = $('btn-call-add');
    if (addBtn) {
      addBtn.classList.toggle('hidden', mode !== 'active');
      addBtn.disabled = mode !== 'active';
    }
    $('btn-call-mute')?.classList.toggle('hidden', mode !== 'active' || listenOnly);
    $('call-timer')?.classList.toggle('hidden', mode !== 'active');
    $('call-test-options')?.classList.toggle('hidden', mode === 'active');
    $('call-audio-options')?.classList.toggle('hidden', listenOnly);
    $('call-video-wrap')?.classList.toggle('hidden', true);
    $('call-single-avatar')?.classList.toggle('hidden', mode === 'active');
    $('call-participants')?.classList.toggle('hidden', mode !== 'active');
    if (mode === 'incoming') setStatus(callType === 'video' ? 'Входящий видеозвонок' : 'Входящий звонок');
    else if (mode === 'outgoing') setStatus('Вызов…');
    else {
      const ns = typeof PulseAudio !== 'undefined' && PulseAudio.isEnabled() ? ' · шумоподавление вкл' : '';
      setStatus('На линии · ' + Math.max(0, callMembers.length - 1) + ' собесед.' + ns);
    }
  }

  function hideOverlay() {
    $('call-overlay')?.classList.add('hidden');
  }

  function startCallTimer() {
    clearInterval(callTimerIv);
    callStart = Date.now();
    const el = $('call-timer');
    callTimerIv = setInterval(() => {
      if (el) {
        const s = Math.floor((Date.now() - callStart) / 1000);
        el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      }
    }, 500);
  }

  async function setupLocalMedia(type) {
    listenOnly = isListenOnly();
    if (listenOnly) {
      localStream = null;
      return;
    }
    if (typeof PulseAudio !== 'undefined') {
      const pro = $('call-noise-pro');
      if (pro) PulseAudio.setEnabled(pro.checked);
      localStream = await PulseAudio.capture(type === 'video');
    } else {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: type === 'video',
      });
    }
  }

  async function replaceAudioOnAllPeers() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    for (const { pc } of peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function attachLocalTile() {
    const grid = $('call-participants');
    if (!grid) return;
    let tile = grid.querySelector('[data-user-id="local"]');
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'call-tile local';
      tile.dataset.userId = 'local';
      tile.innerHTML =
        '<video autoplay playsinline muted></video><span class="call-tile-name">Вы</span>';
      grid.prepend(tile);
    }
    const v = tile.querySelector('video');
    if (v && localStream) v.srcObject = localStream;
    updateLocalMonitor();
  }

  function updateLocalMonitor() {
    const el = $('call-local-monitor');
    const on = $('call-hear-self')?.checked;
    if (!el) return;
    if (on && localStream) {
      el.srcObject = localStream;
      el.volume = 0.35;
      el.play().catch(() => {});
    } else el.srcObject = null;
  }

  function getOrCreatePeer(userId) {
    if (peers.has(userId)) return peers.get(userId);
    const entry = { pc: new RTCPeerConnection(ICE), iceQueue: [] };
    const pc = entry.pc;

    pc.ontrack = (e) => {
      const stream = e.streams?.[0] || new MediaStream([e.track]);
      setRemoteTile(userId, stream);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && callId) {
        sendSignalTo(userId, {
          type: 'ice',
          candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') removePeer(userId);
    };

    if (localStream) {
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    } else if (listenOnly) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      if (callType === 'video') pc.addTransceiver('video', { direction: 'recvonly' });
    }

    peers.set(userId, entry);
    return entry;
  }

  function setRemoteTile(userId, stream) {
    const grid = $('call-participants');
    if (!grid) return;
    let tile = grid.querySelector('[data-user-id="' + userId + '"]');
    const user = callMembers.find((m) => m.id === userId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'call-tile';
      tile.dataset.userId = userId;
      tile.innerHTML =
        '<video autoplay playsinline></video><audio autoplay playsinline></audio><span class="call-tile-name"></span>';
      grid.appendChild(tile);
    }
    tile.querySelector('.call-tile-name').textContent = user?.displayName || 'Участник';
    const v = tile.querySelector('video');
    const a = tile.querySelector('audio');
    if (callType === 'video' && v) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
    if (a) {
      const audioOnly = new MediaStream(stream.getAudioTracks());
      a.srcObject = audioOnly.getAudioTracks().length ? audioOnly : stream;
      a.play().catch(() => {});
    }
    $('call-participants')?.classList.remove('hidden');
    $('call-single-avatar')?.classList.add('hidden');
  }

  function removePeer(userId) {
    const entry = peers.get(userId);
    if (entry?.pc) entry.pc.close();
    peers.delete(userId);
    $('call-participants')?.querySelector('[data-user-id="' + userId + '"]')?.remove();
  }

  async function sendSignalTo(userId, signal) {
    await api('/api/calls/' + callId + '/signal', {
      method: 'POST',
      body: JSON.stringify({ signal, toUserId: userId }),
    });
  }

  async function flushIce(entry) {
    if (!entry.pc.remoteDescription) return;
    while (entry.iceQueue.length) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(entry.iceQueue.shift()));
      } catch {
        /* skip */
      }
    }
  }

  async function handlePeerSignal(fromUserId, signal) {
    if (!signal || fromUserId === myId()) return;
    const entry = getOrCreatePeer(fromUserId);
    const pc = entry.pc;

    if (signal.type === 'ice' && signal.candidate) {
      if (!pc.remoteDescription) entry.iceQueue.push(signal.candidate);
      else {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch {
          entry.iceQueue.push(signal.candidate);
        }
      }
      return;
    }

    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      await flushIce(entry);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignalTo(fromUserId, { type: 'answer', sdp: answer });
      return;
    }

    if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      await flushIce(entry);
    }
  }

  async function createOfferTo(userId) {
    if (userId === myId()) return;
    const entry = getOrCreatePeer(userId);
    const offer = await entry.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: callType === 'video',
    });
    await entry.pc.setLocalDescription(offer);
    await sendSignalTo(userId, { type: 'offer', sdp: offer });
  }

  async function onPeerJoined(userId) {
    if (userId === myId()) return;
    await createOfferTo(userId);
  }

  async function connectToAllPeers() {
    for (const m of callMembers) {
      if (m.id !== myId()) await onPeerJoined(m.id);
    }
  }

  function isCallLive(call) {
    if (!call) return false;
    return call.status === 'active' || (call.joinedIds && call.joinedIds.length >= 2);
  }

  function syncMembersFromCall(call) {
    callMembers = call.members || [];
    const av = $('call-overlay-avatar');
    if (av && call.caller) {
      const first = callMembers.find((m) => m.id !== myId()) || call.caller;
      av.textContent = (first.displayName || '?')
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
      av.style.background = first.avatarColor || '#5288c1';
    }
  }

  async function openAddParticipantModal() {
    const modal = $('modal-call-add');
    const list = $('call-add-list');
    if (!modal || !list || !callId) return;
    list.innerHTML = '<p class="forward-loading">Загрузка…</p>';
    modal.classList.remove('hidden');

    try {
      const data = await api('/api/users/search?q=');
      const me = getMe();
      const inCall = new Set(callMembers.map((m) => m.id));
      list.innerHTML = '';

      for (const user of data.users || []) {
        if (user.id === me?.id || inCall.has(user.id)) continue;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'forward-chat-item';
        row.textContent = user.displayName + ' (@' + user.username + ')';
        row.addEventListener('click', async () => {
          modal.classList.add('hidden');
          try {
            const res = await api('/api/calls/' + callId + '/invite', {
              method: 'POST',
              body: JSON.stringify({ userId: user.id }),
            });
            if (res.call) syncMembersFromCall(res.call);
            $('call-overlay-name').textContent = callTitle();
          } catch (e) {
            alert(e.message || 'Не удалось пригласить');
          }
        });
        list.appendChild(row);
      }
      if (!list.children.length) list.innerHTML = '<p class="forward-empty">Нет доступных пользователей</p>';
    } catch (e) {
      list.innerHTML = '<p class="forward-empty">' + (e.message || 'Ошибка') + '</p>';
    }
  }

  function unlockAllAudio() {
    document.querySelectorAll('#call-participants audio').forEach((a) => a.play().catch(() => {}));
    $('btn-unlock-audio')?.classList.add('hidden');
  }

  async function cleanup() {
    stopRing();
    clearInterval(callTimerIv);
    hideOverlay();
    for (const uid of [...peers.keys()]) removePeer(uid);
    peers = new Map();
    if (typeof PulseAudio !== 'undefined') PulseAudio.stop();
    else if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    const grid = $('call-participants');
    if (grid) grid.innerHTML = '';
    callId = null;
    callMembers = [];
    pendingIncoming = null;
    muted = false;
    listenOnly = false;
    if ($('call-listen-only')) $('call-listen-only').checked = false;
    if ($('call-hear-self')) $('call-hear-self').checked = false;
    $('btn-call-mute')?.classList.remove('active');
    updateCallButtons();
  }

  async function hangup() {
    const id = callId;
    await cleanup();
    if (id) {
      try {
        await api('/api/calls/' + id + '/hangup', { method: 'POST', body: '{}' });
      } catch {
        /* ignore */
      }
    }
  }

  async function startOutgoing(type) {
    const peer = getPeer?.();
    if (!peer) {
      alert('Звонки доступны только в личных чатах');
      return;
    }
    if (isActive()) return;
    try {
      callType = type;
      const res = await api('/api/calls', {
        method: 'POST',
        body: JSON.stringify({ calleeId: peer.id, type }),
      });
      callId = res.call.id;
      syncMembersFromCall(res.call);
      await setupLocalMedia(type);
      attachLocalTile();
      showOverlay('outgoing');
      playRing();
      updateCallButtons();
    } catch (e) {
      await cleanup();
      alert(e.message || 'Не удалось позвонить');
    }
  }

  function showIncoming(call) {
    pendingIncoming = call;
    callId = call.id;
    callType = call.type;
    syncMembersFromCall(call);
    showOverlay('incoming');
    playRing();
    updateCallButtons();
  }

  async function acceptIncoming() {
    if (!callId) return;
    stopRing();
    try {
      const res = await api('/api/calls/' + callId + '/accept', { method: 'POST', body: '{}' });
      if (res.call) syncMembersFromCall(res.call);
      await setupLocalMedia(callType);
      attachLocalTile();
      showOverlay('active');
      startCallTimer();
      pendingIncoming = null;
      await connectToAllPeers();
      unlockAllAudio();
    } catch (e) {
      await rejectIncoming();
      alert(e.message || 'Не удалось принять');
    }
  }

  async function rejectIncoming() {
    stopRing();
    const id = callId;
    pendingIncoming = null;
    await cleanup();
    if (id) {
      try {
        await api('/api/calls/' + id + '/reject', { method: 'POST', body: '{}' });
      } catch {
        /* ignore */
      }
    }
  }

  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    if (typeof PulseAudio !== 'undefined') PulseAudio.setMicMuted(muted);
    else localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    $('btn-call-mute')?.classList.toggle('active', muted);
  }

  function handleEvent(event, payload) {
    if (event === 'call_incoming') {
      if (isActive()) {
        api('/api/calls/' + payload.call.id + '/reject', { method: 'POST', body: '{}' }).catch(() => {});
        return true;
      }
      showIncoming(payload.call);
      return true;
    }

    if (event === 'call_member_joined' && payload.callId === callId) {
      if (payload.call) syncMembersFromCall(payload.call);
      $('call-overlay-name').textContent = callTitle();
      const mode = $('call-overlay')?.dataset.mode;
      if (isCallLive(payload.call) && mode === 'outgoing') {
        showOverlay('active');
        startCallTimer();
        stopRing();
      }
      if (payload.userId && payload.userId !== myId() && $('call-overlay')?.dataset.mode === 'active') {
        onPeerJoined(payload.userId).catch(console.error);
      }
      return true;
    }

    if (event === 'call_member_invited' && payload.callId === callId) {
      if (payload.call) syncMembersFromCall(payload.call);
      $('call-overlay-name').textContent = callTitle();
      setStatus('Приглашён ' + (payload.user?.displayName || 'участник') + '…');
      return true;
    }

    if (event === 'call_member_left' && payload.callId === callId) {
      removePeer(payload.userId);
      callMembers = callMembers.filter((m) => m.id !== payload.userId);
      $('call-overlay-name').textContent = callTitle();
      return true;
    }

    if (event === 'call_signal' && payload.callId === callId) {
      handlePeerSignal(payload.fromUserId, payload.signal).catch(console.error);
      return true;
    }

    if (event === 'call_ended' && payload.callId === callId) {
      cleanup();
      return true;
    }

    return false;
  }

  return {
    init,
    handleEvent,
    hangup,
    isActive,
    updateCallButtons,
    cleanup,
  };
})();
