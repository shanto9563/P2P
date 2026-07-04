class WebRTCManager {
  constructor(socket, config = {}) {
    this.socket = socket;
    this.peers = new Map();               // peerSocketId -> { pc, dataChannel, fileChannels }
    this.stunServers = config.stunServers || [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
    this.turnServers = config.turnServers || [];
    this.rtcConfig = { iceServers: [...this.stunServers, ...this.turnServers] };
    this.onChatMessage = config.onChatMessage || (() => {});
    this.onFileTransferOffer = config.onFileTransferOffer || (() => {});
    this.onFileTransferResponse = config.onFileTransferResponse || (() => {});
    this.onFileProgress = config.onFileProgress || (() => {});
    this.onFileReceived = config.onFileReceived || (() => {});
    this.onPeerConnectionStateChange = config.onPeerConnectionStateChange || (() => {});
    this.initSocketListeners();
  }

  initSocketListeners() {
    this.socket.on('offer', async ({ from, offer }) => this.handleOffer(from, offer));
    this.socket.on('answer', async ({ from, answer }) => this.handleAnswer(from, answer));
    this.socket.on('ice-candidate', async ({ from, candidate }) => this.handleIceCandidate(from, candidate));
  }

  async connectToPeer(peerSocketId, isInitiator = false) {
    if (this.peers.has(peerSocketId)) return;
    const pc = new RTCPeerConnection(this.rtcConfig);
    const peer = { pc, dataChannel: null, fileChannels: new Map() };
    this.peers.set(peerSocketId, peer);

    pc.onicecandidate = (e) => { if (e.candidate) this.socket.emit('ice-candidate', { to: peerSocketId, candidate: e.candidate }); };
    pc.oniceconnectionstatechange = () => this.onPeerConnectionStateChange(peerSocketId, pc.iceConnectionState);
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'chat') this.setupChatChannel(peerSocketId, e.channel);
      else if (e.channel.label.startsWith('file-')) this.setupFileReceiveChannel(peerSocketId, e.channel);
    };

    if (isInitiator) {
      const chatChannel = pc.createDataChannel('chat', { ordered: true });
      this.setupChatChannel(peerSocketId, chatChannel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('offer', { to: peerSocketId, offer });
    }
  }

  setupChatChannel(peerId, channel) {
    const peer = this.peers.get(peerId); if (!peer) return;
    peer.dataChannel = channel;
    channel.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'chat') this.onChatMessage({ peerSocketId: peerId, ...msg });
        else if (msg.type === 'file-transfer-offer') this.onFileTransferOffer({ peerSocketId: peerId, ...msg });
        else if (msg.type === 'file-transfer-response') this.onFileTransferResponse({ peerSocketId: peerId, ...msg });
        else if (msg.type === 'file-transfer-cancel') this.handleCancel(peerId, msg.transferId);
      } catch {}
    };
  }

  setupFileReceiveChannel(peerId, channel) {
    const transferId = channel.label.replace('file-', '');
    const peer = this.peers.get(peerId); if (!peer) return;
    const info = { channel, metadata: null, receivedBytes: 0, chunks: [] };
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        info.metadata = JSON.parse(e.data);
        this.onFileProgress({ peerSocketId: peerId, transferId, status: 'started', metadata: info.metadata });
      } else if (e.data instanceof ArrayBuffer) {
        info.chunks.push(e.data);
        info.receivedBytes += e.data.byteLength;
        this.onFileProgress({ peerSocketId: peerId, transferId, status: 'progress', receivedBytes: info.receivedBytes, total: info.metadata.size });
        if (info.receivedBytes >= info.metadata.size) {
          const blob = new Blob(info.chunks);
          const file = new File([blob], info.metadata.name, { type: info.metadata.type || 'application/octet-stream' });
          file.relativePath = info.metadata.relativePath || '';
          this.onFileReceived({ peerSocketId: peerId, transferId, file, metadata: info.metadata });
          channel.close();
          peer.fileChannels.delete(transferId);
        }
      }
    };
    channel.onclose = () => { if (info.receivedBytes < (info.metadata?.size || 0)) this.onFileProgress({ peerSocketId: peerId, transferId, status: 'cancelled' }); };
    peer.fileChannels.set(transferId, info);
  }

  async handleOffer(from, offer) {
    await this.connectToPeer(from, false);
    const pc = this.peers.get(from).pc;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.socket.emit('answer', { to: from, answer });
  }
  async handleAnswer(from, answer) {
    const peer = this.peers.get(from);
    if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
  async handleIceCandidate(from, candidate) {
    const peer = this.peers.get(from);
    if (peer) await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  sendChatMessage(peerId, msg) {
    const p = this.peers.get(peerId);
    if (p?.dataChannel?.readyState === 'open') p.dataChannel.send(JSON.stringify({ type: 'chat', ...msg }));
  }
  sendFileOffer(peerId, transferId, fileInfo) {
    const p = this.peers.get(peerId);
    if (p?.dataChannel?.readyState === 'open') p.dataChannel.send(JSON.stringify({ type: 'file-transfer-offer', transferId, file: fileInfo }));
  }
  sendFileResponse(peerId, transferId, accepted, reason = '') {
    const p = this.peers.get(peerId);
    if (p?.dataChannel?.readyState === 'open') p.dataChannel.send(JSON.stringify({ type: 'file-transfer-response', transferId, accepted, reason }));
  }
  sendFileCancel(peerId, transferId) {
    const p = this.peers.get(peerId);
    if (p?.dataChannel?.readyState === 'open') p.dataChannel.send(JSON.stringify({ type: 'file-transfer-cancel', transferId }));
    p?.fileChannels.get(transferId)?.channel.close();
  }
  startFileTransfer(peerId, transferId, file) {
    const peer = this.peers.get(peerId); if (!peer) return;
    const channel = peer.pc.createDataChannel(`file-${transferId}`, { ordered: true });
    peer.fileChannels.set(transferId, { channel });
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      channel.send(JSON.stringify({ name: file.name, size: file.size, type: file.type, relativePath: file.relativePath || '' }));
      const stream = file.stream();
      const reader = stream.getReader();
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) { channel.close(); return; }
        if (channel.readyState === 'open') {
          channel.send(value.buffer);
          this.onFileProgress({ peerSocketId: peerId, transferId, status: 'progress', sentBytes: (this._sentOffset || 0) + value.byteLength, total: file.size });
          pump();
        }
      });
      pump();
    };
  }
  handleCancel(peerId, transferId) {
    this.onFileProgress({ peerSocketId: peerId, transferId, status: 'cancelled' });
    this.peers.get(peerId)?.fileChannels.get(transferId)?.channel.close();
  }
  closePeer(peerId) { this.peers.get(peerId)?.pc.close(); this.peers.delete(peerId); }
  closeAll() { this.peers.forEach((_, id) => this.closePeer(id)); }
}
