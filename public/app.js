'use strict';

const API = '';
let token = localStorage.getItem('pulse_token') || '';
let me = null;
let chats = [];
let activeChatId = null;
let eventSource = null;
let typingTimeout = null;
let searchMode = false;
let audioCtx = null;

const notifPrefs = {
  sound: localStorage.getItem('pulse_sound') !== '0',
  desktop: localStorage.getItem('pulse_desktop') !== '0',
  toast: localStorage.getItem('pulse_toast') !== '0',
};

const $ = (id) => document.getElementById(id);

let mediaRecorder = null;
let recordStream = null;
let recordChunks = [];
let recordStart = 0;
let recordTimerIv = null;
let recordMime = 'audio/webm';

function messagePreview(msg) {
  if (!msg) return '';
  if (msg.type === 'voice') {
    const sec = Math.round(msg.duration || 0);
    return `🎤 Голосовое${sec ? ` (${sec}с)` : ''}`;
  }
  return msg.content || '';
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function getChatTitle(chat) {
  if (!chat) return 'Pulse Chat';
  if (chat.title) return chat.title;
  if (chat.type === 'private') {
    const other = chat.members?.find((m) => m.id !== me?.id);
    return other?.displayName || 'Чат';
  }
  return chat.name || 'Группа';
}

function getTotalUnread() {
  return chats.reduce((n, c) => n + (c.unread || 0), 0);
}

function updateDocumentTitle() {
  const n = getTotalUnread();
  document.title = n > 0 ? `(${n}) Pulse Chat` : 'Pulse Chat';
}

function saveNotifPrefs() {
  localStorage.setItem('pulse_sound', notifPrefs.sound ? '1' : '0');
  localStorage.setItem('pulse_desktop', notifPrefs.desktop ? '1' : '0');
  localStorage.setItem('pulse_toast', notifPrefs.toast ? '1' : '0');
}

function updateNotifPermissionStatus() {
  const el = $('notif-permission-status');
  if (!el) return;
  if (!('Notification' in window)) {
    el.textContent = 'Браузер не поддерживает системные уведомления';
    return;
  }
  const map = {
    granted: '✓ Системные уведомления включены',
    denied: '✗ Уведомления заблокированы — разрешите в настройках браузера',
    default: 'Разрешите уведомления, чтобы видеть их вне вкладки',
  };
  el.textContent = map[Notification.permission] || '';
}

function showNotifBanner() {
  const banner = $('notif-banner');
  if (!banner || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  const perm = await Notification.requestPermission();
  updateNotifPermissionStatus();
  showNotifBanner();
  return perm === 'granted';
}

function playNotificationSound() {
  if (!notifPrefs.sound) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(520, audioCtx.currentTime + 0.12);
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.35);
  } catch {
    /* ignore */
  }
}

function showDesktopNotification(title, body, chatId) {
  if (!notifPrefs.desktop || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon: '/favicon.svg',
      tag: 'pulse-' + chatId,
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      openChat(chatId);
      n.close();
    };
    setTimeout(() => n.close(), 8000);
  } catch {
    /* ignore */
  }
}

function showToast(title, body, chatId) {
  if (!notifPrefs.toast) return;
  const stack = $('toast-stack');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-body">${escapeHtml(body)}</div>`;
  el.addEventListener('click', () => {
    openChat(chatId);
    el.remove();
  });
  stack.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function shouldNotifyForMessage(chatId) {
  if (document.hidden) return true;
  return chatId !== activeChatId;
}

function notifyIncomingMessage(message, chat) {
  if (!message || message.senderId === me?.id) return;
  if (!shouldNotifyForMessage(chat.id)) return;

  const title = getChatTitle(chat);
  const sender = message.sender?.displayName || 'Новое сообщение';
  const previewText = messagePreview(message);
  const preview = previewText.length > 120 ? previewText.slice(0, 117) + '…' : previewText;
  const body = chat.type === 'group' ? `${sender}: ${preview}` : preview;

  playNotificationSound();
  showToast(title, body, chat.id);
  showDesktopNotification(title, body, chat.id);

  const bell = $('btn-notif-settings');
  if (bell) {
    bell.classList.add('has-unread');
    setTimeout(() => bell.classList.remove('has-unread'), 600);
  }
}

function upsertChat(chat) {
  if (!chat?.id) return;
  const i = chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) chats[i] = { ...chats[i], ...chat };
  else chats.unshift(chat);
  chats.sort((a, b) => {
    const ta = a.lastMessage?.createdAt || a.createdAt;
    const tb = b.lastMessage?.createdAt || b.createdAt;
    return tb - ta;
  });
}

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function formatLastSeen(u) {
  if (!u) return '';
  if (u.online) return 'в сети';
  if (!u.lastSeen) return 'был(а) давно';
  const d = new Date(u.lastSeen);
  return 'был(а) ' + d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function setAuthError(msg) {
  $('auth-error').textContent = msg || '';
}

function showApp() {
  $('auth-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
}

function showAuth() {
  $('auth-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  PulseCalls?.cleanup?.();
  disconnectEvents();
}

function renderMyProfile() {
  if (!me) return;
  const av = $('my-avatar');
  av.textContent = initials(me.displayName);
  av.style.background = me.avatarColor;
  $('my-name').textContent = me.displayName;
}

function renderAvatar(el, user) {
  if (!user) return;
  el.textContent = initials(user.displayName);
  el.style.background = user.avatarColor;
  let dot = el.querySelector('.dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'dot';
    el.appendChild(dot);
  }
  dot.classList.toggle('online', !!user.online);
}

function renderChatList() {
  const list = $('chat-list');
  list.innerHTML = '';
  for (const chat of chats) {
    const item = document.createElement('div');
    item.className =
      'chat-item' +
      (chat.id === activeChatId ? ' active' : '') +
      (chat.unread > 0 ? ' has-unread' : '');
    item.dataset.id = chat.id;

    const other =
      chat.type === 'private' ? chat.members.find((m) => m.id !== me.id) : chat.members.find((m) => m.id !== me.id);
    const avUser = chat.type === 'private' ? other : { displayName: chat.title, avatarColor: '#5288c1' };

    const av = document.createElement('div');
    av.className = 'avatar';
    if (chat.type === 'private' && other) renderAvatar(av, other);
    else {
      av.textContent = chat.type === 'group' ? '👥' : initials(chat.title);
      av.style.background = '#3d5a80';
    }

    const info = document.createElement('div');
    info.className = 'info';
    const preview = chat.lastMessage
      ? (chat.lastMessage.senderId === me.id ? 'Вы: ' : '') + messagePreview(chat.lastMessage)
      : 'Нет сообщений';

    info.innerHTML = `
      <div class="title-row">
        <span class="title">${escapeHtml(chat.title)}</span>
        <span class="time">${chat.lastMessage ? formatTime(chat.lastMessage.createdAt) : ''}</span>
      </div>
      <div class="preview">${escapeHtml(preview)}</div>
    `;

    item.appendChild(av);
    item.appendChild(info);
    if (chat.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = chat.unread > 99 ? '99+' : chat.unread;
      item.appendChild(badge);
    }

    item.addEventListener('click', () => openChat(chat.id));
    list.appendChild(item);
  }
  updateDocumentTitle();
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function loadChats() {
  const data = await api('/api/chats');
  chats = data.chats;
  renderChatList();
}

function updateChatInList(chatId, patch) {
  const i = chats.findIndex((c) => c.id === chatId);
  if (i >= 0) chats[i] = { ...chats[i], ...patch };
  else if (patch.id) chats.unshift(patch);
  chats.sort((a, b) => {
    const ta = a.lastMessage?.createdAt || a.createdAt;
    const tb = b.lastMessage?.createdAt || b.createdAt;
    return tb - ta;
  });
  renderChatList();
}

async function openChat(chatId) {
  activeChatId = chatId;
  MessageUI?.clearReply?.();
  searchMode = false;
  $('search-results').classList.add('hidden');
  $('chat-list').classList.remove('hidden');
  $('search-users').value = '';

  const data = await api('/api/chats/' + chatId);
  const chat = data.chat;
  updateChatInList(chatId, chat);

  $('empty-state').classList.add('hidden');
  const view = $('chat-view');
  view.classList.remove('hidden');
  view.style.display = 'flex';

  $('chat-title').textContent = chat.title;
  const other = chat.type === 'private' ? chat.members.find((m) => m.id !== me.id) : null;
  $('chat-subtitle').textContent =
    chat.type === 'group'
      ? chat.members.length + ' участников'
      : other
        ? formatLastSeen(other)
        : '';

  if (chat.type === 'private' && other) renderAvatar($('chat-avatar'), other);
  else {
    $('chat-avatar').textContent = '👥';
    $('chat-avatar').style.background = '#3d5a80';
    $('chat-avatar').querySelector('.dot')?.remove();
  }

  await loadMessages(chatId);
  await api('/api/chats/' + chatId + '/read', { method: 'POST' });
  const c = chats.find((x) => x.id === chatId);
  if (c) c.unread = 0;
  renderChatList();
  $('message-input').focus();
  PulseCalls?.updateCallButtons?.();
}

function getActiveChatPeer() {
  if (!activeChatId) return null;
  const chat = chats.find((c) => c.id === activeChatId);
  if (!chat || chat.type !== 'private') return null;
  return chat.members?.find((m) => m.id !== me?.id) || null;
}

async function loadMessages(chatId) {
  const data = await api('/api/chats/' + chatId + '/messages?limit=80');
  const box = $('messages');
  box.innerHTML = '';
  const chat = chats.find((c) => c.id === chatId);
  for (const msg of data.messages) {
    MessageUI.appendMessageBubble(box, msg, chat?.type === 'group');
  }
  box.scrollTop = box.scrollHeight;
}

async function sendMessage(text) {
  if (!activeChatId || !text.trim()) return;
  const content = text.trim();
  const reply = MessageUI.getReplyTo();
  const body = { content };
  if (reply?.id) body.replyToId = reply.id;
  $('message-input').value = '';
  MessageUI.clearReply();
  const res = await api('/api/chats/' + activeChatId + '/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.message && activeChatId) {
    const box = $('messages');
    if (box && !box.querySelector('[data-id="' + res.message.id + '"]')) {
      const chat = chats.find((c) => c.id === activeChatId);
      MessageUI.appendMessageBubble(box, res.message, chat?.type === 'group');
      box.scrollTop = box.scrollHeight;
    }
  }
  sendTyping(false);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function sendVoiceMessage(blob, durationSec) {
  if (!activeChatId || !blob.size) return;
  const audio = await blobToBase64(blob);
  await api('/api/chats/' + activeChatId + '/voice', {
    method: 'POST',
    body: JSON.stringify({ audio, duration: durationSec, mimeType: recordMime }),
  });
}

function updateRecordTimer() {
  const el = $('recording-timer');
  if (el) el.textContent = formatDuration((Date.now() - recordStart) / 1000);
}

function showRecordingUI(on) {
  $('recording-bar')?.classList.toggle('hidden', !on);
  $('composer-form')?.classList.toggle('hidden', on);
  $('btn-voice')?.classList.toggle('recording', on);
}

function releaseMic() {
  if (recordStream) {
    recordStream.getTracks().forEach((t) => t.stop());
    recordStream = null;
  }
}

function endRecordingSession() {
  clearInterval(recordTimerIv);
  showRecordingUI(false);
  releaseMic();
}

async function startRecording() {
  if (!activeChatId) {
    alert('Сначала выберите чат');
    return;
  }
  if (mediaRecorder?.state === 'recording') return;
  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    mediaRecorder = new MediaRecorder(recordStream, { mimeType: recordMime });
    recordChunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) recordChunks.push(e.data);
    };
    mediaRecorder.start(200);
    recordStart = Date.now();
    showRecordingUI(true);
    clearInterval(recordTimerIv);
    recordTimerIv = setInterval(updateRecordTimer, 200);
    updateRecordTimer();
  } catch {
    alert('Нет доступа к микрофону. Разрешите запись в браузере.');
  }
}

function stopMediaRecorder() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      resolve(null);
      return;
    }
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordChunks, { type: recordMime.split(';')[0] });
      resolve(blob);
    };
    mediaRecorder.stop();
  });
}

async function cancelRecording() {
  await stopMediaRecorder();
  recordChunks = [];
  endRecordingSession();
}

async function finishRecording() {
  const duration = (Date.now() - recordStart) / 1000;
  const blob = await stopMediaRecorder();
  endRecordingSession();
  if (!blob || blob.size < 100 || duration < 0.4) return;
  try {
    await sendVoiceMessage(blob, duration);
  } catch (e) {
    alert(e.message || 'Не удалось отправить');
  }
}

function applyProfileToUI(user) {
  if (user.id === me?.id) {
    me = user;
    renderMyProfile();
  }
  for (const chat of chats) {
    for (const m of chat.members || []) {
      if (m.id === user.id) {
        m.displayName = user.displayName;
        m.username = user.username;
        m.avatarColor = user.avatarColor;
      }
    }
    if (chat.type === 'private') {
      const other = chat.members?.find((m) => m.id === user.id);
      if (other && other.id !== me?.id) chat.title = other.displayName;
    }
  }
  renderChatList();
  if (activeChatId) {
    const chat = chats.find((c) => c.id === activeChatId);
    if (chat) {
      $('chat-title').textContent = getChatTitle(chat);
      const other = chat.type === 'private' ? chat.members.find((m) => m.id !== me.id) : null;
      if (other?.id === user.id) renderAvatar($('chat-avatar'), other);
    }
  }
}

function openProfileModal() {
  if (!me) return;
  $('profile-displayName').value = me.displayName;
  $('profile-username').value = me.username;
  $('profile-error').textContent = '';
  const av = $('profile-avatar-preview');
  av.textContent = initials(me.displayName);
  av.style.background = me.avatarColor;
  $('profile-username-preview').textContent = '@' + me.username;
  $('modal-profile').classList.remove('hidden');
}

async function saveProfile() {
  const displayName = $('profile-displayName').value.trim();
  const username = $('profile-username').value.trim();
  $('profile-error').textContent = '';
  try {
    const data = await api('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ displayName, username }),
    });
    me = data.user;
    applyProfileToUI(me);
    $('modal-profile').classList.add('hidden');
  } catch (e) {
    $('profile-error').textContent = e.message;
  }
}

function sendTyping(typing) {
  if (!activeChatId) return;
  api('/api/chats/' + activeChatId + '/typing', {
    method: 'POST',
    body: JSON.stringify({ typing }),
  }).catch(() => {});
}

function connectEvents() {
  disconnectEvents();
  if (!token) return;
  eventSource = new EventSource('/api/events?token=' + encodeURIComponent(token));
  eventSource.onmessage = (e) => {
    try {
      const { event, payload } = JSON.parse(e.data);
      handleEvent(event, payload);
    } catch {
      /* ping */
    }
  };
  eventSource.onerror = () => {
    setTimeout(connectEvents, 3000);
  };
}

function disconnectEvents() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function handleEvent(event, payload) {
  if (typeof PulseCalls !== 'undefined' && PulseCalls.handleEvent(event, payload)) return;
  if (event === 'message_update') {
    if (payload.chat) upsertChat(payload.chat);
    renderChatList();
    MessageUI?.handleEvent?.(event, payload);
    return;
  }

  if (typeof MessageUI !== 'undefined' && MessageUI.handleEvent(event, payload)) return;

  if (event === 'message') {
    const { message, chatId, chat: chatPayload } = payload;

    if (chatPayload) upsertChat(chatPayload);
    else {
      updateChatInList(chatId, {
        lastMessage: {
          id: message.id,
          type: message.type,
          content: messagePreview(message),
          senderId: message.senderId,
          createdAt: message.createdAt,
          duration: message.duration,
        },
      });
    }

    const chat = chats.find((c) => c.id === chatId) || chatPayload;

    if (chatId === activeChatId && !document.hidden) {
      const box = $('messages');
      if (!box.querySelector('[data-id="' + message.id + '"]')) {
        MessageUI.appendMessageBubble(box, message, chat?.type === 'group');
        box.scrollTop = box.scrollHeight;
      }
      if (message.senderId !== me.id) {
        api('/api/chats/' + chatId + '/read', { method: 'POST' }).catch(() => {});
        const c = chats.find((x) => x.id === chatId);
        if (c) c.unread = 0;
      }
    } else if (message.senderId !== me.id) {
      const c = chats.find((x) => x.id === chatId);
      if (c) {
        c.unread = chatPayload?.unread != null ? chatPayload.unread : (c.unread || 0) + 1;
      }
      if (chat) notifyIncomingMessage(message, chat);
    }

    renderChatList();
  }

  if (event === 'chat_new') {
    upsertChat(payload.chat);
    renderChatList();
  }

  if (event === 'typing' && payload.chatId === activeChatId && payload.userId !== me.id) {
    const sub = $('chat-subtitle');
    if (payload.typing) sub.textContent = payload.displayName + ' печатает…';
    else {
      const chat = chats.find((c) => c.id === activeChatId);
      const other = chat?.members?.find((m) => m.id === payload.userId);
      sub.textContent = other ? formatLastSeen(other) : '';
    }
  }

  if (event === 'profile_update') {
    applyProfileToUI(payload.user);
  }

  if (event === 'presence') {
    for (const chat of chats) {
      for (const m of chat.members || []) {
        if (m.id === payload.userId) m.online = payload.online;
      }
    }
    if (activeChatId) {
      const chat = chats.find((c) => c.id === activeChatId);
      const other = chat?.type === 'private' ? chat.members.find((m) => m.id !== me.id) : null;
      if (other && other.id === payload.userId) {
        $('chat-subtitle').textContent = formatLastSeen(other);
        renderAvatar($('chat-avatar'), other);
      }
    }
    renderChatList();
  }
}

async function searchUsers(q) {
  if (!q.trim()) {
    searchMode = false;
    $('search-results').classList.add('hidden');
    $('chat-list').classList.remove('hidden');
    return;
  }
  searchMode = true;
  const data = await api('/api/users/search?q=' + encodeURIComponent(q));
  const box = $('search-results');
  box.innerHTML = '';
  $('chat-list').classList.add('hidden');
  box.classList.remove('hidden');

  for (const user of data.users) {
    const row = document.createElement('div');
    row.className = 'chat-item';
    const av = document.createElement('div');
    av.className = 'avatar';
    renderAvatar(av, user);
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="title">@${escapeHtml(user.username)}</div><div class="preview">${escapeHtml(user.displayName)} · ${formatLastSeen(user)}</div>`;
    row.appendChild(av);
    row.appendChild(info);
    row.addEventListener('click', async () => {
      const res = await api('/api/chats/private', { method: 'POST', body: JSON.stringify({ userId: user.id }) });
      const exists = chats.some((c) => c.id === res.chat.id);
      if (!exists) chats.unshift(res.chat);
      searchMode = false;
      $('search-results').classList.add('hidden');
      $('chat-list').classList.remove('hidden');
      $('search-users').value = '';
      renderChatList();
      openChat(res.chat.id);
    });
    box.appendChild(row);
  }
  if (!data.users.length) {
    box.innerHTML = '<p style="padding:16px;color:var(--text-muted)">Никого не найдено</p>';
  }
}

let authMode = 'login';

$('tab-login').addEventListener('click', () => {
  authMode = 'login';
  $('tab-login').classList.add('active');
  $('tab-register').classList.remove('active');
  $('field-display').style.display = 'none';
  $('auth-submit').textContent = 'Войти';
  setAuthError('');
});

$('tab-register').addEventListener('click', () => {
  authMode = 'register';
  $('tab-register').classList.add('active');
  $('tab-login').classList.remove('active');
  $('field-display').style.display = 'block';
  $('auth-submit').textContent = 'Создать аккаунт';
  setAuthError('');
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setAuthError('');
  const username = $('username').value;
  const password = $('password').value;
  const displayName = $('displayName').value;
  try {
    const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body =
      authMode === 'register' ? { username, password, displayName } : { username, password };
    const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
    token = data.token;
    me = data.user;
    localStorage.setItem('pulse_token', token);
    await initApp();
  } catch (err) {
    setAuthError(err.message);
  }
});

$('btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  token = '';
  me = null;
  localStorage.removeItem('pulse_token');
  showAuth();
});

let searchDebounce;
$('search-users').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => searchUsers(e.target.value), 280);
});

$('composer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('message-input').value;
  await sendMessage(text);
});

$('message-input').addEventListener('input', () => {
  clearTimeout(typingTimeout);
  sendTyping(true);
  typingTimeout = setTimeout(() => sendTyping(false), 2000);
  const ta = $('message-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
});

$('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer-form').requestSubmit();
  }
});

$('btn-voice')?.addEventListener('click', async () => {
  if (mediaRecorder?.state === 'recording') return;
  await startRecording();
});

$('btn-rec-cancel')?.addEventListener('click', () => cancelRecording());
$('btn-rec-send')?.addEventListener('click', () => finishRecording());

$('open-profile')?.addEventListener('click', () => openProfileModal());
$('modal-profile-close')?.addEventListener('click', () => $('modal-profile').classList.add('hidden'));
$('btn-save-profile')?.addEventListener('click', () => saveProfile());

async function initApp() {
  const data = await api('/api/auth/me');
  me = data.user;
  showApp();
  renderMyProfile();
  PulseCalls?.init?.({
    api,
    $,
    getMe: () => me,
    getPeer: getActiveChatPeer,
    getChats: () => chats,
  });
  MessageUI?.init?.({
    api,
    $,
    getMe: () => me,
    getActiveChatId: () => activeChatId,
    getChats: () => chats,
    openChat,
    escapeHtml,
    formatTime,
    formatDuration,
  });
  await loadChats();
  connectEvents();
  updateDocumentTitle();
  showNotifBanner();
  updateNotifPermissionStatus();
  if ($('pref-sound')) $('pref-sound').checked = notifPrefs.sound;
  if ($('pref-desktop')) $('pref-desktop').checked = notifPrefs.desktop;
  if ($('pref-toast')) $('pref-toast').checked = notifPrefs.toast;
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => requestNotificationPermission(), 800);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateDocumentTitle();
});

$('btn-enable-notif')?.addEventListener('click', () => requestNotificationPermission());

$('btn-notif-settings')?.addEventListener('click', () => {
  $('modal-notif').classList.remove('hidden');
  updateNotifPermissionStatus();
});

$('modal-notif-close')?.addEventListener('click', () => $('modal-notif').classList.add('hidden'));

$('btn-request-notif')?.addEventListener('click', () => requestNotificationPermission());

['pref-sound', 'pref-desktop', 'pref-toast'].forEach((id) => {
  $(id)?.addEventListener('change', (e) => {
    const key = id.replace('pref-', '');
    notifPrefs[key] = e.target.checked;
    saveNotifPrefs();
  });
});

async function boot() {
  if (token) {
    try {
      await initApp();
      return;
    } catch {
      token = '';
      localStorage.removeItem('pulse_token');
    }
  }
  showAuth();
}

boot();
