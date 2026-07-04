class FileShareApp {
  constructor() {
    this.socket = null;
    this.webrtc = null;
    this.roomId = null;
    this.myData = { socketId: null, nickname: '', avatar: '', isHost: false };
    this.users = new Map();      // socketId -> user object
    this.selectedFiles = [];     // { file, relativePath, transferId (temp) }
    this.transfers = new Map();  // transferId -> { peerId, file, status, bytes, total, startTime, speed, etc }
    this.pendingOffers = new Map();
    this.transferIdCounter = 0;
    this.autoReconnect = true;
  }

  init() {
    this.cacheDom();
    this.socket = io({ reconnection: true, reconnectionAttempts: 20, reconnectionDelay: 1000 });
    this.webrtc = new WebRTCManager(this.socket, {
      onChatMessage: (m) => this.addChatMessage(m.from, m.text, m.avatar, false),
      onFileTransferOffer: (o) => this.handleIncomingOffer(o),
      onFileTransferResponse: (o) => this.handleTransferResponse(o),
      onFileProgress: (p) => this.updateTransferProgress(p),
      onFileReceived: (f) => this.handleReceivedFile(f),
      onPeerConnectionStateChange: (peerId, state) => this.updatePeerStatus(peerId, state)
    });

    this.socket.on('connect', () => {
      this.hideLoading();
      this.updateConnectionStatus('connected');
      if (this.autoReconnect && this.roomId && this.myData.nickname) {
        this.socket.emit('rejoin-room', { roomId: this.roomId, nickname: this.myData.nickname, avatar: this.myData.avatar }, (res) => {
          if (res.success) this.onRejoined(res.users);
          else this.showToast('Could not rejoin room.', 'error');
        });
      }
    });
    this.socket.on('disconnect', () => this.updateConnectionStatus('disconnected'));
    this.socket.on('reconnect_attempt', () => this.updateConnectionStatus('connecting'));

    // Room events
    this.socket.on('user-joined', (user) => this.onUserJoined(user));
    this.socket.on('user-left', ({ socketId }) => this.onUserLeft(socketId));
    this.socket.on('user-disconnected', ({ socketId }) => this.onUserDisconnected(socketId));
    this.socket.on('user-updated', (u) => this.onUserUpdated(u));
    this.socket.on('host-changed', ({ newHost }) => { this.myData.isHost = (newHost === this.myData.socketId); this.renderUserList(); });
    this.socket.on('room-locked', (locked) => this.showToast(locked ? 'Room locked' : 'Room unlocked'));
    this.socket.on('kicked', () => { this.leaveRoom(); this.showToast('You were kicked by the host.', 'error'); });
    this.socket.on('chat-message', (msg) => this.addChatMessage(msg.from, msg.text, msg.avatar, true));

    this.bindEvents();
  }

  cacheDom() {
    this.els = {
      loading: document.getElementById('loading-overlay'),
      main: document.getElementById('main-container'),
      statusDot: document.getElementById('connection-status'),
      roomPanel: document.getElementById('room-panel'),
      roomUi: document.getElementById('room-ui'),
      roomIdDisplay: document.getElementById('room-id-display'),
      userList: document.getElementById('user-list'),
      chatMessages: document.getElementById('chat-messages'),
      chatInput: document.getElementById('chat-input'),
      recipientSelect: document.getElementById('recipient-select'),
      fileDropZone: document.getElementById('file-drop-zone'),
      selectedFilesDiv: document.getElementById('selected-files'),
      transferList: document.getElementById('transfer-list'),
      btnSend: document.getElementById('btn-send-files'),
      btnCancelTransfers: document.getElementById('btn-cancel-transfers'),
      qrModal: document.getElementById('qr-modal'),
      qrCodeDiv: document.getElementById('qr-code'),
      lockBtn: document.getElementById('btn-lock-room'),
    };
  }

  bindEvents() {
    // Tabs
    document.getElementById('tab-create').onclick = () => this.switchTab('create');
    document.getElementById('tab-join').onclick = () => this.switchTab('join');
    // Create / Join
    document.getElementById('btn-create-room').onclick = () => this.createRoom();
    document.getElementById('btn-join-room').onclick = () => this.joinRoom();
    // In-room actions
    this.els.lockBtn.onclick = () => this.toggleLock();
    document.getElementById('btn-leave-room').onclick = () => this.leaveRoom();
    document.getElementById('btn-copy-link').onclick = () => this.copyRoomLink();
    document.getElementById('btn-show-qr').onclick = () => this.showQR();
    document.getElementById('btn-select-files').onclick = () => this.openFilePicker();
    document.getElementById('btn-select-folder').onclick = () => this.openFolderPicker();
    this.els.btnSend.onclick = () => this.sendFiles();
    this.els.btnCancelTransfers.onclick = () => this.cancelAllTransfers();
    document.getElementById('btn-send-chat').onclick = () => this.sendChat();
    this.els.chatInput.onkeypress = (e) => { if (e.key === 'Enter') this.sendChat(); };

    // Drag & drop
    this.els.fileDropZone.addEventListener('dragover', e => { e.preventDefault(); this.els.fileDropZone.classList.add('dragover'); });
    this.els.fileDropZone.addEventListener('dragleave', () => this.els.fileDropZone.classList.remove('dragover'));
    this.els.fileDropZone.addEventListener('drop', e => { e.preventDefault(); this.els.fileDropZone.classList.remove('dragover'); this.handleDrop(e.dataTransfer.items); });
    this.els.fileDropZone.addEventListener('click', () => this.openFilePicker());

    // QR modal close
    document.querySelector('#qr-modal .close').onclick = () => this.els.qrModal.style.display = 'none';
    window.onclick = (e) => { if (e.target === this.els.qrModal) this.els.qrModal.style.display = 'none'; };
  }

  // ---------- UI helpers ----------
  showLoading() { this.els.loading.style.display = 'flex'; }
  hideLoading() { this.els.loading.style.display = 'none'; this.els.main.style.display = 'block'; }
  updateConnectionStatus(s) {
    const dot = this.els.statusDot;
    dot.classList.remove('connected', 'disconnected', 'connecting');
    if (s === 'connected') dot.classList.add('connected');
    else if (s === 'disconnected') dot.classList.add('disconnected');
    else dot.classList.add('connecting');
  }
  switchTab(tab) {
    document.getElementById('create-section').style.display = tab === 'create' ? '' : 'none';
    document.getElementById('join-section').style.display = tab === 'join' ? '' : 'none';
    document.getElementById('tab-create').classList.toggle('active', tab === 'create');
    document.getElementById('tab-join').classList.toggle('active', tab === 'join');
  }
  showToast(msg, type = '') {
    const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = msg;
    document.getElementById('toast-container').appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ---------- Avatar & nickname ----------
  generateAvatar(nick) {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const hash = this.hashCode(nick || 'anon');
    ctx.fillStyle = `hsl(${hash % 360}, 70%, 50%)`; ctx.fillRect(0,0,64,64);
    ctx.fillStyle = 'white'; ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((nick?.[0] || 'A').toUpperCase(), 32, 32);
    return canvas.toDataURL();
  }
  hashCode(s) { let h=0; for(let i=0;i<s.length;i++) h = ((h<<5)-h)+s.charCodeAt(i)|0; return Math.abs(h); }

  getNickname() {
    return document.getElementById('create-nickname').value.trim() || document.getElementById('join-nickname').value.trim() || 'User';
  }

  // ---------- Room management ----------
  createRoom() {
    const roomId = document.getElementById('custom-room-id').value.trim();
    const password = document.getElementById('create-password').value;
    const nick = this.getNickname();
    if (!nick) return this.showToast('Enter a nickname', 'error');
    const avatar = this.generateAvatar(nick);
    this.socket.emit('create-room', { roomId, password, nickname: nick, avatar }, (res) => {
      if (res.error) return this.showToast(res.error, 'error');
      this.enterRoom(res.roomId, res.users, { socketId: this.socket.id, nickname: nick, avatar, isHost: true });
    });
  }
  joinRoom() {
    const roomId = document.getElementById('join-room-id').value.trim();
    const password = document.getElementById('join-password').value;
    const nick = this.getNickname();
    if (!roomId || !nick) return this.showToast('Room ID and nickname required', 'error');
    const avatar = this.generateAvatar(nick);
    this.socket.emit('join-room', { roomId, password, nickname: nick, avatar }, (res) => {
      if (res.error) return this.showToast(res.error, 'error');
      this.enterRoom(res.roomId, res.users, res.myData);
    });
  }
  enterRoom(roomId, users, myData) {
    this.roomId = roomId;
    this.myData = myData;
    this.els.roomPanel.style.display = 'none';
    this.els.roomUi.style.display = '';
    this.els.roomIdDisplay.textContent = roomId;
    this.users.clear();
    users.forEach(u => this.users.set(u.socketId, u));
    this.renderUserList();
    this.connectToPeers(users);
    this.updateHostUI();
  }
  onRejoined(users) {
    this.els.roomPanel.style.display = 'none';
    this.els.roomUi.style.display = '';
    this.users.clear();
    users.forEach(u => this.users.set(u.socketId, u));
    this.renderUserList();
    this.connectToPeers(users);
    this.updateHostUI();
  }
  connectToPeers(users) {
    users.forEach(u => {
      if (u.socketId !== this.myData.socketId) this.webrtc.connectToPeer(u.socketId, true);
    });
  }
  leaveRoom() {
    this.roomId = null; this.myData = {};
    this.webrtc.closeAll(); this.users.clear();
    this.els.roomUi.style.display = 'none';
    this.els.roomPanel.style.display = '';
    this.selectedFiles = []; this.renderSelectedFiles();
    this.els.transferList.innerHTML = '';
    this.els.chatMessages.innerHTML = '';
    this.socket.emit('leave-room'); // will disconnect from room
  }

  // ---------- User list & events ----------
  onUserJoined(user) {
    if (user.socketId === this.myData.socketId) return;
    this.users.set(user.socketId, user);
    this.renderUserList();
    this.webrtc.connectToPeer(user.socketId, true);
  }
  onUserLeft(socketId) { this.users.delete(socketId); this.webrtc.closePeer(socketId); this.renderUserList(); }
  onUserDisconnected({ socketId }) { const u = this.users.get(socketId); if (u) u.connected = false; this.renderUserList(); }
  onUserUpdated(u) { if (this.users.has(u.socketId)) Object.assign(this.users.get(u.socketId), u); this.renderUserList(); }
  renderUserList() {
    const list = this.els.userList; list.innerHTML = '';
    const hostId = [...this.users.values()].find(u => u.isHost)?.socketId;
    for (const [id, u] of this.users) {
      const li = document.createElement('li');
      li.innerHTML = `<img src="${u.avatar}" class="avatar"> ${u.nickname}${u.socketId === hostId ? ' <span class="host-badge">HOST</span>' : ''}`;
      if (this.myData.isHost && id !== this.myData.socketId) {
        const kickBtn = document.createElement('button'); kickBtn.textContent = 'Kick'; kickBtn.className = 'btn small danger';
        kickBtn.onclick = () => this.kickUser(id);
        li.appendChild(kickBtn);
      }
      list.appendChild(li);
    }
    this.updateRecipientSelect();
  }
  updateRecipientSelect() {
    const sel = this.els.recipientSelect;
    sel.innerHTML = '<option value="all">Everyone</option>';
    this.users.forEach((u, id) => { if (id !== this.myData.socketId) sel.innerHTML += `<option value="${id}">${u.nickname}</option>`; });
  }
  kickUser(socketId) { this.socket.emit('kick-user', { targetSocketId: socketId }, (r) => { if (r?.error) this.showToast(r.error, 'error'); }); }
  toggleLock() {
    const newState = !this.els.lockBtn.textContent.includes('🔒'); // rough
    this.socket.emit('lock-room', newState, (r) => {
      if (r?.success) this.els.lockBtn.textContent = r.locked ? '🔓 Unlock' : '🔒 Lock';
      else this.showToast(r.error, 'error');
    });
  }
  updateHostUI() {
    this.els.lockBtn.style.display = this.myData.isHost ? '' : 'none';
  }

  // ---------- Chat ----------
  sendChat() {
    const text = this.els.chatInput.value.trim(); if (!text) return;
    this.addChatMessage(this.myData.nickname, text, this.myData.avatar, false);
    this.users.forEach((_, id) => this.webrtc.sendChatMessage(id, { text, from: this.myData.nickname, avatar: this.myData.avatar }));
    this.els.chatInput.value = '';
  }
  addChatMessage(from, text, avatar, isRemote) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message${from === 'system' ? ' system' : ''}`;
    if (from === 'system') msgDiv.textContent = text;
    else msgDiv.innerHTML = `<span class="nick"><img src="${avatar}" class="avatar" style="width:20px;height:20px;"> ${from}:</span> ${text}`;
    this.els.chatMessages.appendChild(msgDiv);
    this.els.chatMessages.scrollTop = this.els.chatMessages.scrollHeight;
  }

  // ---------- File selection ----------
  openFilePicker() { const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.onchange = () => this.addFiles(inp.files); inp.click(); }
  openFolderPicker() { const inp = document.createElement('input'); inp.type = 'file'; inp.webkitdirectory = true; inp.multiple = true; inp.onchange = () => this.addFiles(inp.files, true); inp.click(); }
  handleDrop(items) { this.traverseFileTree(items).then(files => this.addFiles(files)); }
  async traverseFileTree(items) {
    const files = [];
    const readEntry = async (entry, path = '') => {
      if (entry.isFile) {
        const file = await new Promise(res => entry.file(res));
        file.relativePath = path + file.name;
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await new Promise(res => reader.readEntries(res));
        for (const e of entries) await readEntry(e, path + entry.name + '/');
      }
    };
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.() || (item.getAsEntry?.());
      if (entry) await readEntry(entry);
    }
    return files;
  }
  addFiles(files, fromFolder = false) {
    for (const file of files) {
      if (!file.relativePath) file.relativePath = file.name; // for dropped folders, already set
      this.selectedFiles.push({ file, relativePath: file.relativePath, transferId: null });
    }
    this.renderSelectedFiles();
    this.els.btnSend.disabled = this.selectedFiles.length === 0;
  }
  renderSelectedFiles() {
    const div = this.els.selectedFilesDiv; div.innerHTML = '';
    this.selectedFiles.forEach((f, i) => {
      const item = document.createElement('div'); item.className = 'file-item';
      item.innerHTML = `<span class="icon">${this.fileIcon(f.file)}</span><span class="name">${f.file.relativePath || f.file.name}</span><span class="size">${this.formatSize(f.file.size)}</span>`;
      const rm = document.createElement('button'); rm.textContent = '✕'; rm.className = 'btn small'; rm.onclick = () => { this.selectedFiles.splice(i,1); this.renderSelectedFiles(); this.els.btnSend.disabled = this.selectedFiles.length===0; };
      item.appendChild(rm);
      div.appendChild(item);
    });
  }
  fileIcon(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return '🖼️';
    if (['mp4','webm','ogg','mov'].includes(ext)) return '🎥';
    if (['mp3','wav','aac','flac'].includes(ext)) return '🎵';
    if (ext === 'pdf') return '📑';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return '📦';
    return '📄';
  }
  formatSize(bytes) { if (bytes < 1024) return bytes + ' B'; const u = ['KB','MB','GB']; let i = -1; do { bytes /= 1024; i++; } while (bytes >= 1024 && i < u.length-1); return bytes.toFixed(1) + ' ' + u[i]; }

  // ---------- Sending files ----------
  sendFiles() {
    if (!this.selectedFiles.length) return;
    const recipients = this.getSelectedRecipients();
    if (!recipients.length) return this.showToast('No recipients selected', 'error');
    this.els.btnSend.disabled = true;
    this.els.btnCancelTransfers.style.display = '';
    for (const sf of this.selectedFiles) {
      for (const peerId of recipients) {
        const transferId = 't' + (++this.transferIdCounter);
        sf.transferId = transferId;
        this.transfers.set(transferId, { peerId, file: sf.file, status: 'pending', bytes: 0, total: sf.file.size, startTime: 0, speed: 0, lastBytes: 0 });
        this.webrtc.sendFileOffer(peerId, transferId, { name: sf.file.name, size: sf.file.size, type: sf.file.type, relativePath: sf.file.relativePath });
      }
    }
    this.renderTransferList();
  }
  getSelectedRecipients() {
    const sel = this.els.recipientSelect;
    if (sel.value === 'all' || sel.selectedOptions[0]?.value === 'all') return [...this.users.keys()];
    return [...sel.selectedOptions].map(o => o.value);
  }
  handleIncomingOffer({ peerSocketId, transferId, file: fileInfo }) {
    if (this.pendingOffers.has(transferId)) return;
    this.pendingOffers.set(transferId, { peerSocketId, fileInfo });
    this.showTransferAcceptPrompt(transferId, peerSocketId, fileInfo);
  }
  showTransferAcceptPrompt(transferId, peerId, fileInfo) {
    const accept = confirm(`${this.users.get(peerId)?.nickname || 'User'} wants to send "${fileInfo.name}" (${this.formatSize(fileInfo.size)}). Accept?`);
    this.webrtc.sendFileResponse(peerId, transferId, accept);
    this.pendingOffers.delete(transferId);
    if (!accept) return;
    // Sender will start the transfer; on receiver side we just wait for file channel
  }
  handleTransferResponse({ peerSocketId, transferId, accepted, reason }) {
    const t = this.transfers.get(transferId);
    if (!t) return;
    if (accepted) {
      t.status = 'transferring';
      t.startTime = performance.now();
      this.webrtc.startFileTransfer(peerSocketId, transferId, t.file);
      this.renderTransferList();
    } else {
      this.transfers.delete(transferId);
      this.renderTransferList();
    }
  }
  updateTransferProgress(p) {
    const t = this.transfers.get(p.transferId);
    if (!t && p.status === 'started') { /* receiver started */ }
    if (!t) return;
    t.status = p.status;
    if (p.sentBytes) t.bytes = p.sentBytes;
    if (p.receivedBytes) t.bytes = p.receivedBytes;
    t.lastBytes = t.bytes;
    if (p.status === 'cancelled' || p.status === 'completed') this.transfers.delete(p.transferId);
    this.renderTransferList();
  }
  cancelAllTransfers() {
    for (const [tid, t] of this.transfers) this.webrtc.sendFileCancel(t.peerId, tid);
    this.transfers.clear();
    this.renderTransferList();
    this.els.btnCancelTransfers.style.display = 'none';
  }
  handleReceivedFile({ peerSocketId, file, metadata }) {
    this.showToast(`Received ${file.name}`, 'success');
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('image/')) this.previewFile(url, 'image');
    else if (file.type.startsWith('video/')) this.previewFile(url, 'video');
    else if (file.type.startsWith('audio/')) this.previewFile(url, 'audio');
    else if (file.type === 'application/pdf') window.open(url, '_blank');
    else {
      const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); URL.revokeObjectURL(url);
    }
  }
  previewFile(url, type) {
    const w = window.open('', '_blank');
    w.document.write(`<${type} controls style="max-width:100%;max-height:100vh;" src="${url}"></${type}>`);
  }
  renderTransferList() {
    const div = this.els.transferList; div.innerHTML = '';
    for (const [tid, t] of this.transfers) {
      const pct = t.total ? Math.min(100, (t.bytes / t.total * 100)).toFixed(1) : 0;
      const speed = this.calcSpeed(t);
      div.innerHTML += `<div class="file-item"><span>${t.file.name}</span><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="speed">${pct}% ${speed}</span></div>`;
    }
  }
  calcSpeed(t) {
    if (!t.startTime) return '';
    const elapsed = (performance.now() - t.startTime) / 1000;
    if (elapsed < 0.5) return '';
    const bytes = t.bytes; const speed = bytes / elapsed;
    return this.formatSize(speed) + '/s';
  }

  // ---------- Copy & QR ----------
  copyRoomLink() {
    const link = `${window.location.origin}?room=${this.roomId}`;
    navigator.clipboard.writeText(link).then(() => this.showToast('Link copied!'));
  }
  showQR() {
    const link = `${window.location.origin}?room=${this.roomId}`;
    this.els.qrCodeDiv.innerHTML = '';
    new QRCode(this.els.qrCodeDiv, { text: link, width: 200, height: 200 });
    this.els.qrModal.style.display = 'flex';
  }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
  const app = new FileShareApp();
  app.init();
  app.showLoading();
  // Check for room in URL
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  if (roomFromUrl) {
    document.getElementById('join-room-id').value = roomFromUrl;
    document.getElementById('tab-join').click();
  }
});
