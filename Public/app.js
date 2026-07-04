// State
let socket = null;
let webrtcManager = null;
let currentRoomId = null;
let currentUser = null;
let users = new Map();
let isHost = false;
let selectedFiles = [];
let pendingFileRequest = null;
let transferElements = new Map();
let myAvatar = '';

// Emojis
const EMOJIS = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐'];

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    document.getElementById('loading-screen').classList.add('hidden');
  }, 1500);

  setupLandingPage();
  setupRoomPage();
  setupModals();
  setupEmojiPicker();
});

function setupLandingPage() {
  const nicknameInput = document.getElementById('nickname-input');
  const savedNickname = localStorage.getItem('nickname');
  if (savedNickname) nicknameInput.value = savedNickname;

  document.getElementById('create-room-btn').addEventListener('click', createRoom);
  document.getElementById('join-room-btn').addEventListener('click', joinRoom);
  
  document.getElementById('room-id-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

function setupRoomPage() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');

  document.getElementById('select-files-btn').addEventListener('click', () => fileInput.click());
  document.getElementById('select-folder-btn').addEventListener('click', () => folderInput.click());
  
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files, false));
  folderInput.addEventListener('change', (e) => handleFiles(e.target.files, true));

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    
    const items = e.dataTransfer.items;
    if (items) {
      const files = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i].webkitGetAsEntry();
        if (item) traverseFileTree(item, '', files);
      }
      setTimeout(() => handleFileEntries(files), 500);
    } else {
      handleFiles(e.dataTransfer.files, false);
    }
  });

  document.getElementById('toggle-sidebar-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  document.getElementById('copy-link-btn').addEventListener('click', copyRoomLink);
  document.getElementById('show-qr-btn').addEventListener('click', showQRCode);
  document.getElementById('lock-room-btn').addEventListener('click', toggleLockRoom);
  document.getElementById('leave-room-btn').addEventListener('click', leaveRoom);

  document.getElementById('send-chat-btn').addEventListener('click', sendChatMessage);
  document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  document.getElementById('clear-completed-btn').addEventListener('click', clearCompletedTransfers);

  document.querySelectorAll('input[name="send-to"]').forEach(radio => {
    radio.addEventListener('change', updateSendToUI);
  });
}

function setupModals() {
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-modal');
      closeModal(modalId);
    });
  });

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    });
  });

  document.getElementById('modal-password-cancel').addEventListener('click', () => closeModal('password-modal'));
  document.getElementById('modal-password-submit').addEventListener('click', submitPassword);
  
  document.getElementById('file-request-accept').addEventListener('click', acceptPendingFile);
  document.getElementById('file-request-reject').addEventListener('click', rejectPendingFile);
}

function setupEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  EMOJIS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      document.getElementById('chat-input').value += emoji;
      picker.style.display = 'none';
    });
    picker.appendChild(btn);
  });

  document.getElementById('toggle-emoji-btn').addEventListener('click', () => {
    picker.style.display = picker.style.display === 'none' ? 'grid' : 'none';
  });
}

function traverseFileTree(item, path, files) {
  if (item.isFile) {
    item.file((file) => {
      Object.defineProperty(file, 'webkitRelativePath', {
        value: path + file.name,
        writable: false
      });
      files.push({ file, path });
    });
  } else if (item.isDirectory) {
    const dirReader = item.createReader();
    dirReader.readEntries((entries) => {
      for (let i = 0; i < entries.length; i++) {
        traverseFileTree(entries[i], path + item.name + '/', files);
      }
    });
  }
}

async function createRoom() {
  const nickname = document.getElementById('nickname-input').value.trim() || 'Anonymous';
  localStorage.setItem('nickname', nickname);

  const roomId = prompt('Enter custom room ID (leave empty for random):') || '';
  const password = prompt('Enter room password (leave empty for none):') || '';

  connectSocket(nickname, roomId.trim(), password);
}

async function joinRoom() {
  const nickname = document.getElementById('nickname-input').value.trim() || 'Anonymous';
  const roomId = document.getElementById('room-id-input').value.trim();
  const password = document.getElementById('room-password-input').value;

  if (!roomId) {
    showToast('Please enter a room ID', 'error');
    return;
  }

  localStorage.setItem('nickname', nickname);
  connectSocket(nickname, roomId, password);
}

function connectSocket(nickname, roomId, password) {
  socket = io();
  
  socket.on('connect', () => {
    myAvatar = generateAvatar(nickname);
    currentUser = { nickname, avatar: myAvatar };

    if (roomId) {
      socket.emit('join-room', { roomId, nickname, avatar: myAvatar, password }, (response) => {
        if (response.success) {
          enterRoom(response.roomId, response.users);
        } else {
          if (response.error === 'Incorrect password') {
            showPasswordModal(roomId);
          } else {
            showToast(response.error, 'error');
          }
        }
      });
    } else {
      socket.emit('create-room', { nickname, avatar: myAvatar, password }, (response) => {
        if (response.success) {
          enterRoom(response.roomId, []);
        } else {
          showToast(response.error, 'error');
        }
      });
    }
  });

  socket.on('disconnect', () => {
    updateConnectionIndicator('disconnected');
  });

  socket.on('connect_error', () => {
    updateConnectionIndicator('disconnected');
  });

  socket.on('user-joined', (user) => {
    users.set(user.socketId, user);
    renderUsers();
    updateSendToUI();
    addSystemMessage(`${user.nickname} joined the room`);
    showToast(`${user.nickname} joined`, 'info');
    
    webrtcManager.createPeerConnection(user.socketId, true);
  });

  socket.on('user-left', (data) => {
    const user = users.get(data.socketId);
    users.delete(data.socketId);
    renderUsers();
    updateSendToUI();
    
    if (webrtcManager) webrtcManager.removePeer(data.socketId);
    
    if (data.notify && user) {
      addSystemMessage(`${user.nickname} left the room`);
      showToast(`${user.nickname} left`, 'info');
    }
  });

  socket.on('chat-message', (message) => {
    addChatMessage(message);
  });

  socket.on('room-locked', (data) => {
    const lockBtn = document.getElementById('lock-room-btn');
    lockBtn.textContent = data.locked ? '🔒' : '🔓';
    addSystemMessage(data.locked ? 'Room is now locked' : 'Room is now unlocked');
  });

  socket.on('kicked', (data) => {
    showToast(data.reason || 'You have been kicked', 'error');
    setTimeout(() => location.reload(), 2000);
  });

  socket.on('user-updated', (user) => {
    users.set(user.socketId, user);
    renderUsers();
  });
}

function enterRoom(roomId, userList) {
  currentRoomId = roomId;
  
  document.getElementById('landing-page').classList.remove('active');
  document.getElementById('room-page').classList.add('active');
  
  document.getElementById('room-title').textContent = `Room: ${roomId}`;
  document.getElementById('room-id-text').textContent = roomId;
  document.getElementById('my-nickname').textContent = currentUser.nickname;
  document.getElementById('my-avatar').innerHTML = `<img src="${myAvatar}" alt="avatar">`;

  users = new Map();
  userList.forEach(user => {
    users.set(user.socketId, user);
    if (user.isHost) isHost = true;
  });

  renderUsers();
  updateSendToUI();
  updateConnectionIndicator('connected');

  webrtcManager = new WebRTCManager(socket);
  
  webrtcManager.onPeerConnected = (socketId) => {
    console.log(`Peer connected: ${socketId}`);
  };

  webrtcManager.onPeerDisconnected = (socketId) => {
    console.log(`Peer disconnected: ${socketId}`);
  };

  webrtcManager.onFileRequest = (receive) => {
    showFileRequestModal(receive);
  };

  webrtcManager.onTransferUpdate = (transfer) => {
    updateTransferUI(transfer);
  };

  webrtcManager.onTransferComplete = (transfer) => {
    if (transfer.blob) {
      showToast(`Received: ${transfer.name}`, 'success');
      addSystemMessage(`File received: ${transfer.name}`);
    }
  };

  userList.forEach(user => {
    if (user.socketId !== socket.id) {
      webrtcManager.createPeerConnection(user.socketId, false);
    }
  });

  addSystemMessage('You joined the room');
}

function renderUsers() {
  const usersList = document.getElementById('users-list');
  const userCount = document.getElementById('user-count');
  
  userCount.textContent = users.size;
  usersList.innerHTML = '';

  users.forEach((user, socketId) => {
    const item = document.createElement('div');
    item.className = 'user-item';
    
    const badge = user.isHost ? '<span class="host-badge">👑 Host</span>' : '';
    const kickBtn = isHost && !user.isHost && socketId !== socket.id 
      ? `<button class="icon-btn small" onclick="kickUser('${socketId}')">🚫</button>` 
      : '';

    item.innerHTML = `
      <div class="avatar"><img src="${user.avatar}" alt=""></div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(user.nickname)}</div>
        <div class="user-badge">${badge}</div>
      </div>
      <div class="user-actions">${kickBtn}</div>
    `;
    
    usersList.appendChild(item);
  });
}

function updateSendToUI() {
  const section = document.getElementById('send-to-section');
  const usersContainer = document.getElementById('send-to-users');
  
  if (users.size <= 1) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  usersContainer.innerHTML = '';

  users.forEach((user, socketId) => {
    if (socketId === socket.id) return;
    
    const chip = document.createElement('div');
    chip.className = 'send-to-user';
    chip.dataset.socketId = socketId;
    chip.textContent = user.nickname;
    chip.addEventListener('click', () => {
      chip.classList.toggle('selected');
    });
    usersContainer.appendChild(chip);
  });
}

function handleFiles(fileList, isFolder) {
  selectedFiles = [];
  
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const folder = isFolder ? (file.webkitRelativePath || '').replace(/\/[^/]+$/, '') : '';
    selectedFiles.push({ file, folder });
  }

  if (selectedFiles.length === 0) {
    showToast('No files selected', 'error');
    return;
  }

  sendSelectedFiles();
}

function handleFileEntries(entries) {
  selectedFiles = entries.map(entry => ({
    file: entry.file,
    folder: entry.path.replace(/\/[^/]+$/, '')
  }));

  if (selectedFiles.length === 0) {
    showToast('No files selected', 'error');
    return;
  }

  sendSelectedFiles();
}

async function sendSelectedFiles() {
  const sendToAll = document.querySelector('input[name="send-to"]:checked').value === 'all';
  let targetSocketIds;

  if (sendToAll) {
    targetSocketIds = Array.from(users.keys()).filter(id => id !== socket.id);
  } else {
    targetSocketIds = Array.from(document.querySelectorAll('.send-to-user.selected'))
      .map(el => el.dataset.socketId);
  }

  if (targetSocketIds.length === 0) {
    showToast('No recipients selected', 'error');
    return;
  }

  document.getElementById('transfers-section').style.display = 'block';

  for (const { file, folder } of selectedFiles) {
    const transferId = await webrtcManager.sendFile(file, targetSocketIds, folder);
    const transfer = webrtcManager.transfers.get(transferId);
    if (transfer) {
      createTransferElement(transfer, 'send');
    }
  }

  selectedFiles = [];
  document.getElementById('file-input').value = '';
  document.getElementById('folder-input').value = '';
}

function createTransferElement(transfer, type) {
  const list = document.getElementById('transfers-list');
  const item = document.createElement('div');
  item.className = 'transfer-item';
  item.id = `transfer-${transfer.id}`;

  const icon = getFileIcon(transfer.type, transfer.name);
  const folder = transfer.folder ? `<span>📁 ${escapeHtml(transfer.folder)}</span>` : '';

  item.innerHTML = `
    <div class="transfer-icon">${icon}</div>
    <div class="transfer-info">
      <div class="transfer-name">${escapeHtml(transfer.name)}</div>
      <div class="transfer-meta">
        <span>${formatBytes(transfer.size)}</span>
        ${folder}
      </div>
      <div class="transfer-progress">
        <div class="progress-bar">
          <div class="progress-fill" style="width: 0%"></div>
        </div>
      </div>
      <div class="transfer-stats">
        <span class="progress-text">0%</span>
        <span class="speed-text">--</span>
        <span class="eta-text">--</span>
      </div>
    </div>
    <div class="transfer-actions">
      ${type === 'send' ? `<button class="icon-btn small" onclick="cancelTransfer(${transfer.id})">✖</button>` : ''}
    </div>
  `;

  list.appendChild(item);
  transferElements.set(transfer.id, item);
}

function updateTransferUI(transfer) {
  const item = transferElements.get(transfer.id);
  if (!item) return;

  const isSend = transfer.file !== undefined;
  const total = transfer.size;
  const current = isSend ? transfer.bytesSent : transfer.bytesReceived;
  const progress = total > 0 ? (current / total) * 100 : 0;

  const progressFill = item.querySelector('.progress-fill');
  const progressText = item.querySelector('.progress-text');
  const speedText = item.querySelector('.speed-text');
  const etaText = item.querySelector('.eta-text');

  progressFill.style.width = `${progress}%`;
  progressText.textContent = `${progress.toFixed(1)}%`;

  if (transfer.status === 'complete') {
    progressFill.classList.add('complete');
    speedText.textContent = 'Complete';
    etaText.textContent = '✓';
  } else if (transfer.status === 'cancelled') {
    progressFill.classList.add('error');
    speedText.textContent = 'Cancelled';
    etaText.textContent = '✖';
  } else if (transfer.status === 'receiving' || transfer.status === 'sending') {
    const elapsed = (Date.now() - (transfer.startTime || Date.now())) / 1000;
    const speed = elapsed > 0 ? current / elapsed : 0;
    const remaining = total - current;
    const eta = speed > 0 ? remaining / speed : 0;

    speedText.textContent = `${formatBytes(speed)}/s`;
    etaText.textContent = `ETA: ${formatTime(eta)}`;
  }
}

function cancelTransfer(transferId) {
  webrtcManager.cancelTransfer(transferId);
  showToast('Transfer cancelled', 'warning');
}

function clearCompletedTransfers() {
  document.querySelectorAll('.transfer-item').forEach(item => {
    const fill = item.querySelector('.progress-fill');
    if (fill.classList.contains('complete') || fill.classList.contains('error')) {
      item.remove();
    }
  });
}

function showFileRequestModal(receive) {
  pendingFileRequest = receive;
  
  const info = document.getElementById('file-request-info');
  const icon = getFileIcon(receive.type, receive.name);
  const fromUser = users.get(receive.from);
  const fromName = fromUser ? fromUser.nickname : 'Unknown';
  const folder = receive.folder ? `<p>📁 ${escapeHtml(receive.folder)}</p>` : '';

  info.innerHTML = `
    <div class="file-request-icon">${icon}</div>
    <div class="file-request-details">
      <h4>${escapeHtml(receive.name)}</h4>
      <p>${formatBytes(receive.size)} • From: ${escapeHtml(fromName)}</p>
      ${folder}
    </div>
  `;

  openModal('file-request-modal');
}

function acceptPendingFile() {
  if (pendingFileRequest) {
    webrtcManager.acceptFile(pendingFileRequest.id);
    document.getElementById('transfers-section').style.display = 'block';
    createTransferElement(pendingFileRequest, 'receive');
    addSystemMessage(`Accepting: ${pendingFileRequest.name}`);
  }
  closeModal('file-request-modal');
  pendingFileRequest = null;
}

function rejectPendingFile() {
  if (pendingFileRequest) {
    webrtcManager.rejectFile(pendingFileRequest.id);
    addSystemMessage(`Rejected: ${pendingFileRequest.name}`);
  }
  closeModal('file-request-modal');
  pendingFileRequest = null;
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  
  if (!message) return;
  
  socket.emit('chat-message', { message });
  input.value = '';
  document.getElementById('emoji-picker').style.display = 'none';
}

function addChatMessage(message) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  
  if (message.type === 'system') {
    div.className = 'chat-message system';
    div.innerHTML = `<div class="message-text">${escapeHtml(message.message)}</div>`;
  } else {
    div.className = 'chat-message';
    const time = new Date(message.timestamp).toLocaleTimeString();
    div.innerHTML = `
      <div class="avatar"><img src="${message.avatar}" alt=""></div>
      <div class="message-content">
        <div class="message-header">
          <span class="nickname">${escapeHtml(message.nickname)}</span>
          <span class="timestamp">${time}</span>
        </div>
        <div class="message-text">${escapeHtml(message.message)}</div>
      </div>
    `;
  }
  
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addSystemMessage(text) {
  addChatMessage({ type: 'system', message: text, timestamp: Date.now() });
}

function copyRoomLink() {
  const link = `${window.location.origin}?room=${currentRoomId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Link copied to clipboard', 'success');
  }).catch(() => {
    showToast('Failed to copy link', 'error');
  });
}

function showQRCode() {
  const link = `${window.location.origin}?room=${currentRoomId}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(link)}&size=200x200`;
  document.getElementById('qr-code-container').innerHTML = `<img src="${qrUrl}" alt="QR Code">`;
  openModal('qr-modal');
}

function toggleLockRoom() {
  const lockBtn = document.getElementById('lock-room-btn');
  const isLocked = lockBtn.textContent === '🔒';
  socket.emit('lock-room', { locked: !isLocked });
}

function kickUser(socketId) {
  if (confirm('Are you sure you want to kick this user?')) {
    socket.emit('kick-user', { targetSocketId: socketId });
    showToast('User kicked', 'success');
  }
}

function leaveRoom() {
  if (confirm('Are you sure you want to leave the room?')) {
    if (webrtcManager) webrtcManager.close();
    socket.emit('leave-room');
    setTimeout(() => location.reload(), 500);
  }
}

function showPasswordModal(roomId) {
  openModal('password-modal');
  document.getElementById('modal-password-submit').onclick = () => {
    const password = document.getElementById('modal-password-input').value;
    closeModal('password-modal');
    connectSocket(currentUser.nickname, roomId, password);
  };
}

function submitPassword() {
  // Handled by dynamic onclick
}

function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function updateConnectionIndicator(state) {
  const indicator = document.getElementById('connection-indicator');
  const dot = indicator.querySelector('.indicator-dot');
  const text = indicator.querySelector('.indicator-text');
  
  dot.className = 'indicator-dot';
  
  switch (state) {
    case 'connected':
      text.textContent = 'Connected';
      break;
    case 'disconnected':
      dot.classList.add('disconnected');
      text.textContent = 'Disconnected';
      break;
    case 'connecting':
      dot.classList.add('connecting');
      text.textContent = 'Connecting...';
      break;
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icons = { success: '✓', error: '✖', warning: '⚠', info: 'ℹ' };
  
  toast.innerHTML = `
    <div class="toast-icon">${icons[type]}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function generateAvatar(name) {
  const colors = ['6366f1', '8b5cf6', 'ec4899', 'f59e0b', '10b981', '3b82f6', 'ef4444'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${color}&color=fff&size=64&bold=true`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Handle URL parameters for direct room join
window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  if (roomId) {
    document.getElementById('room-id-input').value = roomId.toUpperCase();
  }
});