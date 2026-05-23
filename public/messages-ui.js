'use strict';

const MessageUI = (() => {
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏'];

  let api = null;
  let $ = null;
  let getMe = null;
  let getActiveChatId = null;
  let getChats = null;
  let openChat = null;
  let escapeHtml = null;
  let formatTime = null;
  let formatDuration = null;

  let replyTo = null;
  let ctxMsg = null;
  let forwardMsg = null;

  function init(deps) {
    api = deps.api;
    $ = deps.$;
    getMe = deps.getMe;
    getActiveChatId = deps.getActiveChatId;
    getChats = deps.getChats;
    openChat = deps.openChat;
    escapeHtml = deps.escapeHtml;
    formatTime = deps.formatTime;
    formatDuration = deps.formatDuration;
    bindUi();
  }

  function bindUi() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#ctx-menu, #reaction-picker, #modal-forward, .forward-chat-item')) return;
      clearCtxState();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        clearCtxState();
        $('modal-forward')?.classList.add('hidden');
      }
    });

    $('ctx-menu')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('[data-action]');
      const msg = ctxMsg;
      if (!btn || !msg) return;
      const action = btn.dataset.action;
      hideContextMenu();
      if (action === 'reply') {
        clearCtxState();
        setReply(msg);
      } else if (action === 'forward') {
        clearCtxState();
        openForwardModal(msg);
      } else if (action === 'delete') {
        clearCtxState();
        deleteMessage(msg);
      } else if (action === 'react') {
        showReactionPicker(btn, msg);
      }
    });

    $('reply-bar-cancel')?.addEventListener('click', () => clearReply());
    $('modal-forward-close')?.addEventListener('click', () => $('modal-forward').classList.add('hidden'));

    $('reaction-picker')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('[data-emoji]');
      const msg = ctxMsg;
      if (!btn || !msg) return;
      clearCtxState();
      reactToMessage(msg, btn.dataset.emoji);
    });
  }

  function getReplyTo() {
    return replyTo;
  }

  function clearReply() {
    replyTo = null;
    $('reply-bar')?.classList.add('hidden');
  }

  function setReply(msg) {
    if (msg.deleted) return;
    replyTo = { id: msg.id, senderName: msg.sender?.displayName || 'Пользователь', content: messagePreviewText(msg) };
    const bar = $('reply-bar');
    if (bar) {
      bar.classList.remove('hidden');
      $('reply-bar-name').textContent = replyTo.senderName;
      $('reply-bar-text').textContent = replyTo.content;
    }
    $('message-input')?.focus();
  }

  function messagePreviewText(msg) {
    if (msg.deleted) return 'Сообщение удалено';
    if (msg.type === 'voice') return '🎤 Голосовое';
    return (msg.content || '').slice(0, 80);
  }

  function showContextMenu(x, y, msg) {
    clearCtxState();
    ctxMsg = msg;
    const menu = $('ctx-menu');
    if (!menu) return;
    const me = getMe();
    const delBtn = menu.querySelector('[data-action="delete"]');
    if (delBtn) delBtn.classList.toggle('hidden', msg.senderId !== me?.id || msg.deleted);

    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function hideContextMenu() {
    $('ctx-menu')?.classList.add('hidden');
  }

  function clearCtxState() {
    ctxMsg = null;
    hideContextMenu();
    hideReactionPicker();
  }

  function showReactionPicker(anchor, msg) {
    ctxMsg = msg;
    const picker = $('reaction-picker');
    if (!picker) return;
    picker.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    picker.style.left = Math.min(r.left, window.innerWidth - 280) + 'px';
    picker.style.top = r.top - 48 + 'px';
  }

  function hideReactionPicker() {
    $('reaction-picker')?.classList.add('hidden');
  }

  async function deleteMessage(msg) {
    const chatId = getActiveChatId();
    if (!chatId || !msg?.id || !confirm('Удалить сообщение для всех?')) return;
    try {
      const res = await api(`/api/chats/${chatId}/messages/${msg.id}/delete`, { method: 'POST', body: '{}' });
      if (res.message) updateMessageRow(res.message);
    } catch (e) {
      alert(e.message || 'Не удалось удалить');
    }
  }

  async function reactToMessage(msg, emoji) {
    const chatId = getActiveChatId();
    if (!chatId || !msg?.id) return;
    try {
      const res = await api(`/api/chats/${chatId}/messages/${msg.id}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
      if (res.message) updateMessageRow(res.message);
    } catch (e) {
      alert(e.message || 'Не удалось поставить реакцию');
    }
  }

  async function forwardToChat(targetChatId) {
    if (!forwardMsg?.id) return;
    const modal = $('modal-forward');
    modal?.classList.add('hidden');
    try {
      await api(`/api/chats/${targetChatId}/messages/forward`, {
        method: 'POST',
        body: JSON.stringify({ messageId: forwardMsg.id }),
      });
      if (targetChatId !== getActiveChatId()) await openChat(targetChatId);
    } catch (e) {
      alert(e.message || 'Не удалось переслать');
    }
    forwardMsg = null;
  }

  async function openForwardModal(msg) {
    if (msg.deleted) return;
    forwardMsg = msg;
    const list = $('forward-chat-list');
    const modal = $('modal-forward');
    if (!list || !modal) return;
    list.innerHTML = '<p class="forward-loading">Загрузка…</p>';
    modal.classList.remove('hidden');

    const me = getMe();
    const seenUsers = new Set();

    try {
      const data = await api('/api/users/search?q=');
      list.innerHTML = '';

      for (const chat of getChats() || []) {
        if (chat.type && chat.type !== 'private') continue;
        const other = chat.members?.find((m) => m.id !== me?.id);
        if (!other || seenUsers.has(other.id)) continue;
        seenUsers.add(other.id);

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'forward-chat-item';
        row.textContent = chat.title || other.displayName;
        row.addEventListener('click', () => forwardToChat(chat.id));
        list.appendChild(row);
      }

      for (const user of data.users || []) {
        if (seenUsers.has(user.id)) continue;
        seenUsers.add(user.id);

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'forward-chat-item';
        row.textContent = user.displayName + ' (@' + user.username + ')';
        row.addEventListener('click', async () => {
          try {
            const res = await api('/api/chats/private', {
              method: 'POST',
              body: JSON.stringify({ userId: user.id }),
            });
            await forwardToChat(res.chat.id);
          } catch (e) {
            alert(e.message || 'Не удалось открыть чат');
          }
        });
        list.appendChild(row);
      }

      if (!list.children.length) {
        list.innerHTML = '<p class="forward-empty">Нет других пользователей</p>';
      }
    } catch (e) {
      list.innerHTML = '<p class="forward-empty">' + escapeHtml(e.message) + '</p>';
    }
  }

  function buildVoiceContent(bubble, msg) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-voice';
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'voice-play';
    playBtn.textContent = '▶';
    const audio = document.createElement('audio');
    audio.src = msg.audioUrl;
    const wave = document.createElement('div');
    wave.className = 'voice-wave';
    for (let i = 0; i < 12; i++) wave.appendChild(document.createElement('span'));
    const dur = document.createElement('span');
    dur.className = 'voice-dur';
    dur.textContent = formatDuration(msg.duration || 0);
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (audio.paused) {
        document.querySelectorAll('.messages audio').forEach((a) => {
          if (a !== audio) a.pause();
        });
        audio.play();
        playBtn.textContent = '⏸';
        wave.classList.add('playing');
      } else {
        audio.pause();
        playBtn.textContent = '▶';
        wave.classList.remove('playing');
      }
    });
    wrap.appendChild(playBtn);
    wrap.appendChild(wave);
    wrap.appendChild(dur);
    bubble.appendChild(wrap);
  }

  function renderReactions(bubble, msg) {
    const reactions = msg.reactions || {};
    const keys = Object.keys(reactions).filter((k) => reactions[k]?.length);
    if (!keys.length) return;
    const row = document.createElement('div');
    row.className = 'msg-reactions';
    for (const emoji of keys) {
      const count = reactions[emoji].length;
      const me = getMe();
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip' + (reactions[emoji].includes(me?.id) ? ' mine' : '');
      chip.textContent = emoji + (count > 1 ? ' ' + count : '');
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        reactToMessage(msg, emoji);
      });
      row.appendChild(chip);
    }
    bubble.appendChild(row);
  }

  function appendMessageBubble(container, msg, showSender) {
    const me = getMe();
    const out = msg.senderId === me?.id;
    const row = document.createElement('div');
    row.className = 'msg-row ' + (out ? 'out' : 'in') + (msg.deleted ? ' deleted' : '');
    row.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (msg.forwardedFrom) {
      const fwd = document.createElement('div');
      fwd.className = 'msg-forward-label';
      fwd.textContent = 'Переслано от ' + (msg.forwardedFrom.fromName || 'пользователя');
      bubble.appendChild(fwd);
    }

    if (msg.replyTo) {
      const reply = document.createElement('div');
      reply.className = 'msg-reply-quote';
      reply.innerHTML = `<strong>${escapeHtml(msg.replyTo.senderName)}</strong><br>${escapeHtml(msg.replyTo.content)}`;
      reply.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = container.querySelector('[data-id="' + msg.replyTo.id + '"]');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('highlight');
          setTimeout(() => el.classList.remove('highlight'), 1500);
        }
      });
      bubble.appendChild(reply);
    }

    if (showSender && !out && msg.sender && !msg.deleted) {
      const sn = document.createElement('div');
      sn.className = 'sender-name';
      sn.textContent = msg.sender.displayName;
      bubble.appendChild(sn);
    }

    if (msg.deleted) {
      const text = document.createElement('div');
      text.className = 'text deleted-text';
      text.textContent = 'Сообщение удалено';
      bubble.appendChild(text);
    } else if (msg.type === 'voice' && msg.audioUrl) {
      buildVoiceContent(bubble, msg);
    } else {
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = msg.content;
      bubble.appendChild(text);
    }

    renderReactions(bubble, msg);

    const time = document.createElement('div');
    time.className = 'meta-time';
    time.textContent = formatTime(msg.createdAt);
    bubble.appendChild(time);

    row.appendChild(bubble);

    if (!msg.deleted) {
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, msg);
      });
    }

    container.appendChild(row);
    return row;
  }

  function updateMessageRow(msg) {
    const box = $('messages');
    const old = box?.querySelector('[data-id="' + msg.id + '"]');
    const chat = getChats()?.find((c) => c.id === getActiveChatId());
    const showSender = chat?.type === 'group';
    if (old && box) {
      const wrap = document.createElement('div');
      appendMessageBubble(wrap, msg, showSender);
      const newRow = wrap.firstElementChild;
      if (newRow) old.replaceWith(newRow);
    }
  }

  function handleEvent(event, payload) {
    if (event === 'message_update' && payload.chatId === getActiveChatId()) {
      updateMessageRow(payload.message);
      return true;
    }
    return false;
  }

  return {
    init,
    appendMessageBubble,
    updateMessageRow,
    getReplyTo,
    clearReply,
    handleEvent,
  };
})();
