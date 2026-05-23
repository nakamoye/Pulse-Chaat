'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3847;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_VOICE_BYTES = 5 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.mp4': 'audio/mp4',
};

/** @type {Map<string, { res: import('http').ServerResponse, userId: string }>} */
const sseClients = new Map();
/** @type {Map<string, number>} */
const onlineUsers = new Map();
/** @type {Map<string, { chatId: string, until: number }>} */
const typingUsers = new Map();
/** @type {Map<string, { id: string, callerId: string, calleeId: string, type: string, status: string, createdAt: number }>} */
const activeCalls = new Map();

let store = loadStore();
let saveTimer = null;

function defaultStore() {
  return { users: [], chats: [], messages: [], sessions: [] };
}

function loadStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(STORE_PATH)) {
      const s = defaultStore();
      fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
      return s;
    }
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return defaultStore();
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STORE_PATH);
  }, 120);
}

function uid() {
  return crypto.randomBytes(12).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

function sanitizeUsername(u) {
  return String(u || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 32);
}

function getUser(id) {
  return store.users.find((u) => u.id === id) || null;
}

function publicUser(u) {
  if (!u) return null;
  const online = onlineUsers.has(u.id);
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarColor: u.avatarColor,
    online,
    lastSeen: u.lastSeen || null,
  };
}

function getSession(token) {
  if (!token) return null;
  const s = store.sessions.find((x) => x.token === token && x.expires > Date.now());
  return s || null;
}

function authUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const session = getSession(token);
  if (!session) return null;
  return getUser(session.userId);
}

function chatForUser(chatId, userId) {
  const chat = store.chats.find((c) => c.id === chatId);
  if (!chat || !chat.memberIds.includes(userId)) return null;
  return chat;
}

function privateChatId(a, b) {
  const ids = [a, b].sort();
  const existing = store.chats.find(
    (c) => c.type === 'private' && c.memberIds.length === 2 && c.memberIds.slice().sort().join() === ids.join()
  );
  return existing ? existing.id : null;
}

function lastMessage(chatId) {
  const msgs = store.messages.filter((m) => m.chatId === chatId);
  if (!msgs.length) return null;
  return msgs.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
}

const ALLOWED_REACTIONS = ['👍', '❤️', '❤', '😂', '😮', '😢', '🔥', '👏'];

function normalizeReaction(emoji) {
  const e = String(emoji || '').trim();
  if (ALLOWED_REACTIONS.includes(e)) return e === '❤' ? '❤️' : e;
  if (e.includes('❤')) return '❤️';
  return null;
}

function messagePreview(m) {
  if (!m) return '';
  if (m.deleted) return 'Сообщение удалено';
  if (m.type === 'voice') {
    const sec = Math.round(m.duration || 0);
    return `🎤 Голосовое (${sec}с)`;
  }
  return m.content || '';
}

function formatMessage(m) {
  const sender = publicUser(getUser(m.senderId));
  const base = {
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    type: m.type || 'text',
    content: m.deleted ? 'Сообщение удалено' : m.type === 'voice' ? messagePreview(m) : m.content,
    createdAt: m.createdAt,
    sender,
    deleted: !!m.deleted,
    reactions: m.reactions || {},
  };
  if (m.deleted) return base;
  if (m.type === 'voice' && m.audioFile) {
    base.audioUrl = '/uploads/' + m.audioFile;
    base.duration = m.duration || 0;
  }
  if (m.replyToId) {
    const orig = store.messages.find((x) => x.id === m.replyToId);
    if (orig) {
      base.replyTo = {
        id: orig.id,
        senderId: orig.senderId,
        senderName: getUser(orig.senderId)?.displayName || 'Пользователь',
        content: messagePreview(orig),
      };
    }
  }
  if (m.forwardedFrom) base.forwardedFrom = m.forwardedFrom;
  return base;
}

function notifyMessageUpdate(chat, msg) {
  scheduleSave();
  const message = formatMessage(msg);
  for (const mid of chat.memberIds) {
    notifyUser(mid, 'message_update', {
      message,
      chatId: chat.id,
      chat: enrichChat(chat, mid),
    });
  }
  return message;
}

function messageById(msgId) {
  return store.messages.find((m) => m.id === msgId) || null;
}

function formatLastMessage(m) {
  return {
    id: m.id,
    type: m.type || 'text',
    content: messagePreview(m),
    senderId: m.senderId,
    createdAt: m.createdAt,
    duration: m.duration,
  };
}

const MAX_CALL_MEMBERS = 8;

function normalizeCall(call) {
  if (call.memberIds) return call;
  return {
    ...call,
    hostId: call.callerId,
    memberIds: [call.callerId, call.calleeId].filter(Boolean),
    joinedIds: call.status === 'active' ? [call.callerId, call.calleeId] : [call.callerId],
  };
}

function formatCall(call) {
  const c = normalizeCall(call);
  const members = c.memberIds.map((id) => publicUser(getUser(id))).filter(Boolean);
  const host = getUser(c.hostId);
  const other = members.find((m) => m.id !== c.hostId);
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    hostId: c.hostId,
    memberIds: c.memberIds,
    joinedIds: c.joinedIds || [],
    members,
    caller: publicUser(host),
    callee: other || null,
    createdAt: c.createdAt,
  };
}

function getUserActiveCall(userId) {
  for (const call of activeCalls.values()) {
    const c = normalizeCall(call);
    if (c.status !== 'ended' && c.memberIds.includes(userId)) return c;
  }
  return null;
}

function notifyCallMembers(call, event, payload, exceptUserId = null) {
  const c = normalizeCall(call);
  for (const mid of c.memberIds) {
    if (mid === exceptUserId) continue;
    notifyUser(mid, event, payload);
  }
}

function endCall(callId, reason) {
  const call = activeCalls.get(callId);
  if (!call) return;
  call.status = 'ended';
  const payload = { callId, reason: reason || 'ended' };
  notifyCallMembers(call, 'call_ended', payload);
  activeCalls.delete(callId);
}

function endCallsForUser(userId, reason) {
  for (const [id, call] of [...activeCalls.entries()]) {
    const c = normalizeCall(call);
    if (c.memberIds.includes(userId)) endCall(id, reason);
  }
}

function dispatchNewMessage(chat, user, msg) {
  if (!chat.lastRead) chat.lastRead = {};
  chat.lastRead[user.id] = Date.now();
  scheduleSave();
  const message = formatMessage(msg);
  for (const mid of chat.memberIds) {
    notifyUser(mid, 'message', {
      message,
      chatId: chat.id,
      chat: enrichChat(chat, mid),
    });
  }
  return message;
}

function unreadCount(chat, userId) {
  const lastRead = chat.lastRead?.[userId] || 0;
  return store.messages.filter((m) => m.chatId === chat.id && m.createdAt > lastRead && m.senderId !== userId).length;
}

function broadcast(event, payload, exceptUserId = null) {
  const data = JSON.stringify({ event, payload, ts: Date.now() });
  for (const [token, client] of sseClients) {
    if (exceptUserId && client.userId === exceptUserId) continue;
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(token);
    }
  }
}

function notifyUser(userId, event, payload) {
  const data = JSON.stringify({ event, payload, ts: Date.now() });
  for (const [, client] of sseClients) {
    if (client.userId !== userId) continue;
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch {
      /* removed on close */
    }
  }
}

function notifyChatMembers(chat, event, payload, exceptUserId = null) {
  for (const memberId of chat.memberIds) {
    if (memberId === exceptUserId) continue;
    notifyUser(memberId, event, payload);
  }
}

function enrichChat(chat, userId) {
  const members = chat.memberIds.map((id) => publicUser(getUser(id))).filter(Boolean);
  const last = lastMessage(chat.id);
  let title = chat.name;
  if (chat.type === 'private') {
    const other = members.find((m) => m.id !== userId);
    title = other ? other.displayName : 'Чат';
  }
  return {
    id: chat.id,
    type: chat.type,
    title,
    name: chat.name,
    members,
    memberIds: chat.memberIds,
    createdAt: chat.createdAt,
    lastMessage: last ? formatLastMessage(last) : null,
    unread: unreadCount(chat, userId),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath, rootDir) {
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://x').pathname;
  if (urlPath.startsWith('/uploads/')) {
    const filePath = path.normalize(path.join(UPLOADS_DIR, urlPath.replace(/^\/uploads\//, '')));
    return serveFile(res, filePath, UPLOADS_DIR);
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath.replace(/^\//, '')));
  return serveFile(res, filePath, PUBLIC_DIR);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/api/events' && req.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const session = getSession(token);
    if (!session) return json(res, 401, { error: 'Unauthorized' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');

    const sseToken = uid();
    sseClients.set(sseToken, { res, userId: session.userId });
    onlineUsers.set(session.userId, Date.now());

    const u = getUser(session.userId);
    if (u) {
      u.lastSeen = Date.now();
      scheduleSave();
    }

    broadcast('presence', { userId: session.userId, online: true }, session.userId);
    notifyUser(session.userId, 'ready', { userId: session.userId });

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
        onlineUsers.set(session.userId, Date.now());
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(sseToken);
      onlineUsers.delete(session.userId);
      endCallsForUser(session.userId, 'offline');
      if (u) {
        u.lastSeen = Date.now();
        scheduleSave();
      }
      broadcast('presence', { userId: session.userId, online: false });
    });
    return;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');
      const displayName = String(body.displayName || username || 'User').trim().slice(0, 64) || 'User';

      if (username.length < 3) return json(res, 400, { error: 'Имя пользователя: минимум 3 символа (a-z, 0-9, _)' });
      if (password.length < 4) return json(res, 400, { error: 'Пароль: минимум 4 символа' });
      if (store.users.some((u) => u.username === username)) return json(res, 409, { error: 'Имя уже занято' });

      const colors = ['#5B8DEF', '#6BCB77', '#FF6B6B', '#C77DFF', '#FFB347', '#4ECDC4', '#F72585'];
      const user = {
        id: uid(),
        username,
        displayName,
        passwordHash: hashPassword(password),
        avatarColor: colors[Math.floor(Math.random() * colors.length)],
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };
      store.users.push(user);

      const token = uid();
      store.sessions.push({ token, userId: user.id, expires: Date.now() + 30 * 24 * 60 * 60 * 1000 });
      scheduleSave();
      return json(res, 201, { token, user: publicUser(user) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');
      const user = store.users.find((u) => u.username === username);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(res, 401, { error: 'Неверный логин или пароль' });
      }
      user.lastSeen = Date.now();
      const token = uid();
      store.sessions.push({ token, userId: user.id, expires: Date.now() + 30 * 24 * 60 * 60 * 1000 });
      scheduleSave();
      return json(res, 200, { token, user: publicUser(user) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const user = authUser(req);
  if (!user && pathname.startsWith('/api/')) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    return json(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    store.sessions = store.sessions.filter((s) => s.token !== token);
    scheduleSave();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/profile' && req.method === 'PATCH') {
    try {
      const body = await readBody(req);
      let changed = false;

      if (body.displayName !== undefined) {
        const displayName = String(body.displayName).trim().slice(0, 64);
        if (!displayName) return json(res, 400, { error: 'Имя не может быть пустым' });
        user.displayName = displayName;
        changed = true;
      }

      if (body.username !== undefined) {
        const username = sanitizeUsername(body.username);
        if (username.length < 3) {
          return json(res, 400, { error: 'Username: минимум 3 символа (a-z, 0-9, _)' });
        }
        if (store.users.some((u) => u.username === username && u.id !== user.id)) {
          return json(res, 409, { error: 'Этот username уже занят' });
        }
        user.username = username;
        changed = true;
      }

      if (!changed) return json(res, 400, { error: 'Нечего обновлять' });

      scheduleSave();
      const updated = publicUser(user);
      broadcast('profile_update', { user: updated });
      return json(res, 200, { user: updated });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/users/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const list = store.users
      .filter((u) => u.id !== user.id && (u.username.includes(q) || u.displayName.toLowerCase().includes(q)))
      .slice(0, 20)
      .map(publicUser);
    return json(res, 200, { users: list });
  }

  if (pathname === '/api/chats' && req.method === 'GET') {
    const chats = store.chats
      .filter((c) => c.memberIds.includes(user.id) && c.type === 'private')
      .map((c) => enrichChat(c, user.id))
      .sort((a, b) => {
        const ta = a.lastMessage?.createdAt || a.createdAt;
        const tb = b.lastMessage?.createdAt || b.createdAt;
        return tb - ta;
      });
    return json(res, 200, { chats });
  }

  if (pathname === '/api/chats/private' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const otherId = body.userId;
      const other = getUser(otherId);
      if (!other) return json(res, 404, { error: 'Пользователь не найден' });
      if (otherId === user.id) return json(res, 400, { error: 'Нельзя написать себе' });

      let chatId = privateChatId(user.id, otherId);
      let isNew = false;
      if (!chatId) {
        isNew = true;
        chatId = uid();
        store.chats.push({
          id: chatId,
          type: 'private',
          name: null,
          memberIds: [user.id, otherId],
          createdAt: Date.now(),
          lastRead: {},
        });
        scheduleSave();
      }
      const chat = store.chats.find((c) => c.id === chatId);
      if (isNew) {
        notifyUser(otherId, 'chat_new', { chat: enrichChat(chat, otherId) });
      }
      return json(res, 200, { chat: enrichChat(chat, user.id) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const chatMsgMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (chatMsgMatch) {
    const chatId = chatMsgMatch[1];
    const chat = chatForUser(chatId, user.id);
    if (!chat) return json(res, 404, { error: 'Чат не найден' });

    if (req.method === 'GET') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 50);
      const before = Number(url.searchParams.get('before')) || Infinity;
      const msgs = store.messages
        .filter((m) => m.chatId === chatId && m.createdAt < before)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .reverse()
        .map((m) => formatMessage(m));
      return json(res, 200, { messages: msgs });
    }

    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const content = String(body.content || '').trim();
        if (!content) return json(res, 400, { error: 'Пустое сообщение' });
        if (content.length > 4000) return json(res, 400, { error: 'Слишком длинное сообщение' });

        const msg = {
          id: uid(),
          chatId,
          senderId: user.id,
          type: 'text',
          content,
          createdAt: Date.now(),
          reactions: {},
        };
        if (body.replyToId) {
          const parent = messageById(body.replyToId);
          if (!parent || parent.chatId !== chatId) {
            return json(res, 400, { error: 'Сообщение для ответа не найдено' });
          }
          msg.replyToId = parent.id;
        }
        store.messages.push(msg);
        const message = dispatchNewMessage(chat, user, msg);
        return json(res, 201, { message });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
  }

  const forwardMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages\/forward$/);
  if (forwardMatch && req.method === 'POST') {
    try {
      const targetChatId = forwardMatch[1];
      const targetChat = chatForUser(targetChatId, user.id);
      if (!targetChat) return json(res, 404, { error: 'Чат не найден' });
      const body = await readBody(req);
      const orig = messageById(body.messageId);
      if (!orig) return json(res, 404, { error: 'Сообщение не найдено' });
      const origChat = chatForUser(orig.chatId, user.id);
      if (!origChat) return json(res, 403, { error: 'Нет доступа к сообщению' });

      const fromName = getUser(orig.senderId)?.displayName || 'Пользователь';
      const msg = {
        id: uid(),
        chatId: targetChatId,
        senderId: user.id,
        type: orig.type || 'text',
        content: orig.deleted ? 'Сообщение удалено' : orig.content || messagePreview(orig),
        createdAt: Date.now(),
        reactions: {},
        forwardedFrom: {
          messageId: orig.id,
          fromChatId: orig.chatId,
          fromName,
          preview: messagePreview(orig),
        },
      };
      if (orig.type === 'voice' && orig.audioFile) {
        msg.audioFile = orig.audioFile;
        msg.duration = orig.duration;
      }
      store.messages.push(msg);
      const message = dispatchNewMessage(targetChat, user, msg);
      return json(res, 201, { message });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const msgActionMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages\/([^/]+)\/(delete|react)$/);
  if (msgActionMatch && req.method === 'POST') {
    try {
      const chatId = msgActionMatch[1];
      const msgId = msgActionMatch[2];
      const action = msgActionMatch[3];
      const chat = chatForUser(chatId, user.id);
      if (!chat) return json(res, 404, { error: 'Чат не найден' });
      const msg = messageById(msgId);
      if (!msg || msg.chatId !== chatId) return json(res, 404, { error: 'Сообщение не найдено' });

      if (action === 'delete') {
        if (msg.senderId !== user.id) return json(res, 403, { error: 'Можно удалять только свои сообщения' });
        msg.deleted = true;
        msg.content = '';
        const message = notifyMessageUpdate(chat, msg);
        return json(res, 200, { message });
      }

      if (action === 'react') {
        const body = await readBody(req);
        const emoji = normalizeReaction(body.emoji);
        if (!emoji) return json(res, 400, { error: 'Недопустимая реакция' });
        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const i = msg.reactions[emoji].indexOf(user.id);
        if (i >= 0) msg.reactions[emoji].splice(i, 1);
        else msg.reactions[emoji].push(user.id);
        if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
        const message = notifyMessageUpdate(chat, msg);
        return json(res, 200, { message });
      }
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const chatVoiceMatch = pathname.match(/^\/api\/chats\/([^/]+)\/voice$/);
  if (chatVoiceMatch && req.method === 'POST') {
    try {
      const chatId = chatVoiceMatch[1];
      const chat = chatForUser(chatId, user.id);
      if (!chat) return json(res, 404, { error: 'Чат не найден' });

      const body = await readBody(req);
      let raw = body.audio || body.data || '';
      if (typeof raw === 'string' && raw.includes(',')) raw = raw.split(',')[1];
      const buf = Buffer.from(raw, 'base64');
      if (!buf.length) return json(res, 400, { error: 'Пустая запись' });
      if (buf.length > MAX_VOICE_BYTES) return json(res, 400, { error: 'Запись слишком большая (макс. 5 МБ)' });

      const duration = Math.min(300, Math.max(0, Number(body.duration) || 0));
      const mime = String(body.mimeType || 'audio/webm');
      let ext = '.webm';
      if (mime.includes('ogg')) ext = '.ogg';
      else if (mime.includes('mp4')) ext = '.m4a';

      const msgId = uid();
      const audioFile = msgId + ext;
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOADS_DIR, audioFile), buf);

      const msg = {
        id: msgId,
        chatId,
        senderId: user.id,
        type: 'voice',
        content: messagePreview({ type: 'voice', duration }),
        audioFile,
        duration,
        createdAt: Date.now(),
      };
      store.messages.push(msg);
      const message = dispatchNewMessage(chat, user, msg);
      return json(res, 201, { message });
    } catch (e) {
      return json(res, 400, { error: e.message || 'Ошибка загрузки' });
    }
  }

  const chatReadMatch = pathname.match(/^\/api\/chats\/([^/]+)\/read$/);
  if (chatReadMatch && req.method === 'POST') {
    const chatId = chatReadMatch[1];
    const chat = chatForUser(chatId, user.id);
    if (!chat) return json(res, 404, { error: 'Чат не найден' });
    if (!chat.lastRead) chat.lastRead = {};
    chat.lastRead[user.id] = Date.now();
    scheduleSave();
    return json(res, 200, { ok: true });
  }

  const chatTypingMatch = pathname.match(/^\/api\/chats\/([^/]+)\/typing$/);
  if (chatTypingMatch && req.method === 'POST') {
    try {
      const chatId = chatTypingMatch[1];
      const chat = chatForUser(chatId, user.id);
      if (!chat) return json(res, 404, { error: 'Чат не найден' });
      const body = await readBody(req);
      const typing = !!body.typing;
      typingUsers.set(user.id, { chatId, until: Date.now() + 4000 });
      notifyChatMembers(
        chat,
        'typing',
        { chatId, userId: user.id, displayName: user.displayName, typing },
        user.id
      );
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const chatOneMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (chatOneMatch && req.method === 'GET') {
    const chat = chatForUser(chatOneMatch[1], user.id);
    if (!chat) return json(res, 404, { error: 'Чат не найден' });
    return json(res, 200, { chat: enrichChat(chat, user.id) });
  }

  if (pathname === '/api/calls' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const calleeId = String(body.calleeId || '');
      const type = body.type === 'video' ? 'video' : 'audio';
      const callee = getUser(calleeId);

      if (!callee) return json(res, 404, { error: 'Пользователь не найден' });
      if (calleeId === user.id) return json(res, 400, { error: 'Нельзя позвонить себе' });
      if (getUserActiveCall(user.id)) return json(res, 409, { error: 'Вы уже в звонке' });
      if (getUserActiveCall(calleeId)) return json(res, 409, { error: 'Абонент занят' });
      if (!onlineUsers.has(calleeId)) {
        return json(res, 409, { error: 'Пользователь не в сети' });
      }

      const callId = uid();
      const call = {
        id: callId,
        hostId: user.id,
        type,
        status: 'ringing',
        memberIds: [user.id, calleeId],
        joinedIds: [user.id],
        createdAt: Date.now(),
      };
      activeCalls.set(callId, call);

      notifyUser(calleeId, 'call_incoming', { call: formatCall(call) });

      setTimeout(() => {
        const c = activeCalls.get(callId);
        if (c && c.status === 'ringing' && normalizeCall(c).joinedIds.length < 2) {
          endCall(callId, 'timeout');
        }
      }, 45000);

      return json(res, 201, { call: formatCall(call) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const callInviteMatch = pathname.match(/^\/api\/calls\/([^/]+)\/invite$/);
  if (callInviteMatch && req.method === 'POST') {
    try {
      const callId = callInviteMatch[1];
      const call = activeCalls.get(callId);
      if (!call) return json(res, 404, { error: 'Звонок не найден' });
      const c = normalizeCall(call);
      if (!c.joinedIds.includes(user.id)) return json(res, 403, { error: 'Сначала подключитесь к звонку' });
      if (c.memberIds.length >= MAX_CALL_MEMBERS) {
        return json(res, 400, { error: 'Максимум ' + MAX_CALL_MEMBERS + ' участников' });
      }

      const body = await readBody(req);
      const inviteId = String(body.userId || '');
      const invitee = getUser(inviteId);
      if (!invitee) return json(res, 404, { error: 'Пользователь не найден' });
      if (inviteId === user.id) return json(res, 400, { error: 'Нельзя добавить себя' });
      if (c.memberIds.includes(inviteId)) return json(res, 409, { error: 'Уже в звонке' });
      if (getUserActiveCall(inviteId)) return json(res, 409, { error: 'Пользователь занят' });
      if (!onlineUsers.has(inviteId)) return json(res, 409, { error: 'Пользователь не в сети' });

      c.memberIds.push(inviteId);
      call.memberIds = c.memberIds;

      const formatted = formatCall(call);
      notifyUser(inviteId, 'call_incoming', { call: formatted });
      notifyCallMembers(
        call,
        'call_member_invited',
        { callId, call: formatted, userId: inviteId, user: publicUser(invitee), invitedBy: user.id },
        inviteId
      );

      return json(res, 200, { call: formatted });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const callActionMatch = pathname.match(/^\/api\/calls\/([^/]+)\/(accept|reject|hangup|signal)$/);
  if (callActionMatch) {
    const callId = callActionMatch[1];
    const action = callActionMatch[2];
    const call = activeCalls.get(callId);

    if (!call) return json(res, 404, { error: 'Звонок не найден' });
    const c = normalizeCall(call);
    if (!c.memberIds.includes(user.id)) return json(res, 403, { error: 'Нет доступа' });

    if (action === 'accept' && req.method === 'POST') {
      if (call.status === 'ended') return json(res, 409, { error: 'Звонок завершён' });
      if (!c.joinedIds.includes(user.id)) c.joinedIds.push(user.id);
      call.joinedIds = c.joinedIds;
      if (c.joinedIds.length >= 2) call.status = 'active';

      const formatted = formatCall(call);
      const payload = { callId, userId: user.id, user: publicUser(user), call: formatted };
      for (const mid of c.memberIds) {
        notifyUser(mid, 'call_member_joined', payload);
      }
      return json(res, 200, { call: formatted });
    }

    if (action === 'reject' && req.method === 'POST') {
      call.memberIds = c.memberIds.filter((id) => id !== user.id);
      if (c.joinedIds.length < 2 || call.memberIds.length < 2) {
        endCall(callId, 'rejected');
      } else {
        notifyCallMembers(call, 'call_member_left', { callId, userId: user.id, reason: 'rejected' });
      }
      return json(res, 200, { ok: true });
    }

    if (action === 'hangup' && req.method === 'POST') {
      call.joinedIds = c.joinedIds.filter((id) => id !== user.id);
      call.memberIds = c.memberIds.filter((id) => id !== user.id);
      if (call.joinedIds.length < 2 || call.memberIds.length === 0) {
        endCall(callId, 'hangup');
      } else {
        notifyCallMembers(call, 'call_member_left', { callId, userId: user.id, reason: 'hangup' });
      }
      return json(res, 200, { ok: true });
    }

    if (action === 'signal' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body.signal) return json(res, 400, { error: 'Нет signal' });
        const toUserId = String(body.toUserId || '');
        if (!toUserId || !c.memberIds.includes(toUserId)) {
          return json(res, 400, { error: 'Укажите получателя сигнала' });
        }
        if (toUserId === user.id) return json(res, 400, { error: 'Неверный получатель' });
        notifyUser(toUserId, 'call_signal', {
          callId,
          fromUserId: user.id,
          toUserId,
          signal: body.signal,
        });
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url.startsWith('/api/')) {
    try {
      return await handleApi(req, res);
    } catch (e) {
      console.error(e);
      return json(res, 500, { error: 'Server error' });
    }
  }

  return serveStatic(req, res);
});

setInterval(() => {
  const now = Date.now();
  for (const [userId, t] of typingUsers) {
    if (t.until < now) typingUsers.delete(userId);
  }
}, 2000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  Порт ${PORT} уже занят — Pulse Chat, скорее всего, уже запущен.`);
    console.log(`  Откройте в браузере: http://localhost:${PORT}\n`);
    console.log('  Чтобы остановить старый процесс, запустите stop.bat\n');
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  Pulse Chat — http://localhost:${PORT}\n`);
});
