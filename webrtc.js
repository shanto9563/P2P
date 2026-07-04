const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' }
  ]
};

const CHUNK_SIZE = 16 * 1024;
const BUFFER_THRESHOLD = 8 * 1024 * 1024;

class WebRTCManager {
  constructor(socket) {
    this.socket = socket;
    this.peers = new Map();
    this.transfers = new Map();
    this.receiveQueue = new Map();
    this.onTransferUpdate = null;
    this.onFileRequest = null;
    this.onTransferComplete = null;
    this.onPeerConnected = null;
    this.onPeerDisconnected = null;
    this.setupSocketListeners();
  }

  setupSocketListeners() {
    this.socket.on('receive-offer', async (data) => {
      await this.handleOffer(data.fromSocketId, data.sdp);
    });
    this.socket.on('receive-answer', async (data) => {
      await this.handleAnswer(data.fromSocketId, data.sdp);
    });
    this.socket.on('receive-ice-candidate', async (data) => {
      await this.handleIceCandidate(data.fromSocketId, data.candidate);
    });
  }

  async createPeerConnection(socketId, isInitiator) {
    if (this.peers.has(socketId)) return;
    const peer = new PeerConnection(socketId, this, isInitiator);
    this.peers.set(socketId, peer);
    await peer.initialize();
    if (isInitiator) await peer.createOffer();
    return peer;
  }

  async handleOffer(socketId, sdp) {
    let peer = this.peers.get(socketId);
    if (!peer) {
      peer = new PeerConnection(socketId, this, false);
      this.peers.set(socketId, peer);
      await peer.initialize();
    }
    await peer.handleOffer(sdp);
  }

  async handleAnswer(socketId, sdp) {
    const peer = this.peers.get(socketId);
    if (peer) await peer.handleAnswer(sdp);
  }

  async handleIceCandidate(socketId, candidate) {
    const peer = this.peers.get(socketId);
    if (peer) await peer.addIceCandidate(candidate);
  }

  removePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (peer) {
      peer.close();
      this.peers.delete(socketId);
      if (this.onPeerDisconnected) this.onPeerDisconnected(socketId);
    }
  }

  async sendFile(file, targetSocketIds, folder = '') {
    const transferId = generateTransferId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const transfer = {
      id: transferId, file: file, name: file.name, size: file.size,
      type: file.type || 'application/octet-stream', folder: folder,
      totalChunks: totalChunks, targets: targetSocketIds,
      sentChunks: new Map(), startTime: Date.now(), bytesSent: 0,
      status: 'pending', accepted: new Set(), rejected: new Set()
    };

    this.transfers.set(transferId, transfer);

    for (const socketId of targetSocketIds) {
      const peer = this.peers.get(socketId);
      if (peer && peer.channel && peer.channel.readyState === 'open') {
        transfer.sentChunks.set(socketId, new Set());
        peer.channel.send(JSON.stringify({
          type: 'file-offer', id: transferId, name: file.name,
          size: file.size, mimeType: file.type || 'application/octet-stream',
          totalChunks: totalChunks, folder: folder
        }));
      }
    }

    if (this.onTransferUpdate) this.onTransferUpdate(transfer);
    return transferId;
  }

  async handleFileAccept(transferId, socketId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.accepted.add(socketId);
    this.startTransfer(transfer, socketId);
  }

  handleFileReject(transferId, socketId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.rejected.add(socketId);
    if (transfer.accepted.size === 0 && transfer.rejected.size === transfer.targets.length) {
      transfer.status = 'rejected';
    }
    if (this.onTransferUpdate) this.onTransferUpdate(transfer);
  }

  async startTransfer(transfer, socketId) {
    const peer = this.peers.get(socketId);
    if (!peer || !peer.channel || peer.channel.readyState !== 'open') return;

    transfer.status = 'sending';
    const sentChunks = transfer.sentChunks.get(socketId);

    const sendNextChunk = async () => {
      if (transfer.status === 'cancelled') return;

      for (let i = 0; i < transfer.totalChunks; i++) {
        if (sentChunks.has(i)) continue;
        if (transfer.status === 'cancelled') return;

        while (peer.channel.bufferedAmount > BUFFER_THRESHOLD) {
          await sleep(50);
          if (transfer.status === 'cancelled') return;
        }

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, transfer.size);
        const chunk = await transfer.file.slice(start, end).arrayBuffer();

        const header = new ArrayBuffer(8);
        const view = new DataView(header);
        view.setUint32(0, transfer.id);
        view.setUint32(4, i);

        const message = new Uint8Array(header.byteLength + chunk.byteLength);
        message.set(new Uint8Array(header), 0);
        message.set(new Uint8Array(chunk), header.byteLength);

        peer.channel.send(message.buffer);
        sentChunks.add(i);
        transfer.bytesSent += chunk.byteLength;

        if (this.onTransferUpdate) this.onTransferUpdate(transfer);
      }

      peer.channel.send(JSON.stringify({ type: 'file-complete', id: transfer.id }));
      transfer.status = 'complete';
      if (this.onTransferComplete) this.onTransferComplete(transfer);
    };

    sendNextChunk();
  }

  cancelTransfer(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.status = 'cancelled';
    
    for (const socketId of transfer.targets) {
      const peer = this.peers.get(socketId);
      if (peer && peer.channel && peer.channel.readyState === 'open') {
        peer.channel.send(JSON.stringify({ type: 'file-cancel', id: transferId }));
      }
    }
    if (this.onTransferUpdate) this.onTransferUpdate(transfer);
  }

  handleIncomingFileOffer(transferId, data, socketId) {
    const receive = {
      id: transferId, name: data.name, size: data.size,
      type: data.mimeType, folder: data.folder, totalChunks: data.totalChunks,
      receivedChunks: new Map(), bytesReceived: 0, startTime: null,
      status: 'waiting', from: socketId
    };
    this.receiveQueue.set(transferId, receive);
    if (this.onFileRequest) this.onFileRequest(receive);
  }

  acceptFile(transferId) {
    const receive = this.receiveQueue.get(transferId);
    if (!receive) return;
    receive.status = 'receiving';
    receive.startTime = Date.now();
    const peer = this.peers.get(receive.from);
    if (peer && peer.channel && peer.channel.readyState === 'open') {
      peer.channel.send(JSON.stringify({ type: 'file-accept', id: transferId }));
    }
    if (this.onTransferUpdate) this.onTransferUpdate(receive);
  }

  rejectFile(transferId) {
    const receive = this.receiveQueue.get(transferId);
    if (!receive) return;
    receive.status = 'rejected';
    const peer = this.peers.get(receive.from);
    if (peer && peer.channel && peer.channel.readyState === 'open') {
      peer.channel.send(JSON.stringify({ type: 'file-reject', id: transferId }));
    }
    this.receiveQueue.delete(transferId);
    if (this.onTransferUpdate) this.onTransferUpdate(receive);
  }

  handleBinaryChunk(socketId, buffer) {
    const view = new DataView(buffer);
    const transferId = view.getUint32(0);
    const chunkIndex = view.getUint32(4);
    const data = buffer.slice(8);
    const receive = this.receiveQueue.get(transferId);
    if (!receive) return;
    receive.receivedChunks.set(chunkIndex, data);
    receive.bytesReceived += data.byteLength;
    if (this.onTransferUpdate) this.onTransferUpdate(receive);
  }

  handleFileComplete(transferId) {
    const receive = this.receiveQueue.get(transferId);
    if (!receive) return;
    const chunks = [];
    for (let i = 0; i < receive.totalChunks; i++) {
      const chunk = receive.receivedChunks.get(i);
      if (chunk) chunks.push(chunk);
    }
    const blob = new Blob(chunks, { type: receive.type });
    receive.blob = blob;
    receive.status = 'complete';
    receive.url = URL.createObjectURL(blob);
    this.receiveQueue.delete(transferId);
    if (this.onTransferComplete) this.onTransferComplete(receive);
  }

  handleFileCancel(transferId) {
    const receive = this.receiveQueue.get(transferId);
    if (!receive) return;
    receive.status = 'cancelled';
    this.receiveQueue.delete(transferId);
    if (this.onTransferUpdate) this.onTransferUpdate(receive);
  }

  close() {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }
}

class PeerConnection {
  constructor(socketId, manager, isInitiator) {
    this.socketId = socketId;
    this.manager = manager;
    this.isInitiator = isInitiator;
    this.pc = null;
    this.channel = null;
  }

  async initialize() {
    this.pc = new RTCPeerConnection(RTC_CONFIG);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.manager.socket.emit('send-ice-candidate', {
          targetSocketId: this.socketId, candidate: event.candidate
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'connected') {
        if (this.manager.onPeerConnected) this.manager.onPeerConnected(this.socketId);
      } else if (['disconnected', 'failed', 'closed'].includes(this.pc.connectionState)) {
        this.manager.removePeer(this.socketId);
      }
    };

    this.pc.ondatachannel = (event) => {
      this.channel = event.channel;
      this.setupChannel();
    };

    if (this.isInitiator) {
      this.channel = this.pc.createDataChannel('fileTransfer', { ordered: true });
      this.channel.binaryType = 'arraybuffer';
      this.setupChannel();
    }
  }

  setupChannel() {
    this.channel.binaryType = 'arraybuffer';
    this.channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          this.handleControlMessage(message);
        } catch (e) { console.error('Parse error:', e); }
      } else {
        this.manager.handleBinaryChunk(this.socketId, event.data);
      }
    };
  }

  handleControlMessage(message) {
    switch (message.type) {
      case 'file-offer': this.manager.handleIncomingFileOffer(message.id, message, this.socketId); break;
      case 'file-accept': this.manager.handleFileAccept(message.id, this.socketId); break;
      case 'file-reject': this.manager.handleFileReject(message.id, this.socketId); break;
      case 'file-complete': this.manager.handleFileComplete(message.id); break;
      case 'file-cancel': this.manager.handleFileCancel(message.id); break;
    }
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.manager.socket.emit('send-offer', { targetSocketId: this.socketId, sdp: offer });
  }

  async handleOffer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.manager.socket.emit('send-answer', { targetSocketId: this.socketId, sdp: answer });
  }

  async handleAnswer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async addIceCandidate(candidate) {
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.error('ICE error:', e); }
  }

  close() {
    if (this.channel) this.channel.close();
    if (this.pc) this.pc.close();
  }
}

function generateTransferId() { return Date.now() + Math.floor(Math.random() * 10000); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function getFileIcon(mimeType, fileName) {
  if (!mimeType && !fileName) return '📄';
  const name = (fileName || '').toLowerCase();
  const type = (mimeType || '').toLowerCase();
  if (type.startsWith('image/') || name.match(/\.(jpg|jpeg|png|gif|bmp|webp|svg)$/)) return '🖼️';
  if (type.startsWith('video/') || name.match(/\.(mp4|webm|avi|mov|mkv)$/)) return '🎬';
  if (type.startsWith('audio/') || name.match(/\.(mp3|wav|ogg|flac|aac)$/)) return '🎵';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return '📕';
  if (type.includes('zip') || name.match(/\.(zip|rar|7z|tar|gz)$/)) return '🗜️';
  return '📄';
}