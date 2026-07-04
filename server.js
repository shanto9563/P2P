const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// --------------- Room storage ---------------
const rooms = new Map();

function generateRoomId(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function createRoom(roomId, password, socket) {
  const room = {
    id: roomId,
    password: password || null,
    host: socket.id,
    locked: false,
    users: new Map(),
  };
  const user = {
    socketId: socket.id,
    nickname: null,
    avatar: null,
    isHost: true,
    connected: true,
    disconnectedAt: null,
  };
  room.users.set(socket.id, user);
  rooms.set(roomId, room);
  return room;
}

function removeUserFromRoom(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const user = room.users.get(socketId);
  room.users.delete(socketId);
  if (user?._removalTimeout) clearTimeout(user._removalTimeout);
  if (room.users.size === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} deleted (empty).`);
    return;
  }
  if (room.host === socketId) {
    const first = [...room.users.values()].find(u => u.connected);
    if (first) {
      room.host = first.socketId;
      io.to(roomId).emit('host-changed', { newHost: first.socketId, nickname: first.nickname });
    }
  }
  io.to(roomId).emit('user-left', { socketId });
}

// --------------- Socket events ---------------
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('create-room', ({ roomId, password, nickname, avatar }, cb) => {
    try {
      let id = (roomId?.trim()) || generateRoomId();
      if (rooms.has(id)) return cb({ error: 'Room already exists.' });
      const room = createRoom(id, password || null, socket);
      const user = room.users.get(socket.id);
      user.nickname = nickname || 'Anonymous';
      user.avatar = avatar || '';
      socket.join(id);
      socket.data.roomId = id;
      cb({
        success: true,
        roomId: id,
        users: [...room.users.values()].map(u => ({
          socketId: u.socketId, nickname: u.nickname, avatar: u.avatar, isHost: u.socketId === room.host
        })),
      });
    } catch (e) { cb({ error: e.message }); }
  });

  socket.on('join-room', ({ roomId, password, nickname, avatar }, cb) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return cb({ error: 'Room not found.' });
      if (room.locked) return cb({ error: 'Room is locked.' });
      if (room.password && room.password !== password) return cb({ error: 'Incorrect password.' });

      // Already in room? rejoin
      if (room.users.has(socket.id)) {
        const u = room.users.get(socket.id);
        u.nickname = nickname || u.nickname;
        u.avatar = avatar || u.avatar;
        u.connected = true;
        u.disconnectedAt = null;
        if (u._removalTimeout) clearTimeout(u._removalTimeout);
        socket.join(roomId);
        socket.data.roomId = roomId;
        io.to(roomId).emit('user-joined', { socketId: socket.id, nickname: u.nickname, avatar: u.avatar, isHost: socket.id === room.host });
        return cb({ success: true, roomId, users: getOnlineUsers(room, socket.id) });
      }

      const user = { socketId: socket.id, nickname: nickname || 'Anonymous', avatar: avatar || '', isHost: false, connected: true, disconnectedAt: null };
      room.users.set(socket.id, user);
      socket.join(roomId);
      socket.data.roomId = roomId;

      // Notify new user about existing peers
      const existing = getOnlineUsers(room, socket.id);
      // Notify all *other* users about the new joiner
      socket.to(roomId).emit('user-joined', { socketId: socket.id, nickname: user.nickname, avatar: user.avatar, isHost: false });
      io.to(roomId).emit('chat-message', { type: 'system', text: `${user.nickname} joined the room.`, from: 'system' });

      cb({ success: true, roomId, users: existing, myData: { socketId: socket.id, nickname: user.nickname, avatar: user.avatar, isHost: false } });
    } catch (e) { cb({ error: e.message }); }
  });

  // Rejoin after reconnect
  socket.on('rejoin-room', ({ roomId, nickname, avatar }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: 'Room not found.' });
    const user = room.users.get(socket.id);
    if (user) {
      user.connected = true;
      user.disconnectedAt = null;
      user.nickname = nickname || user.nickname;
      user.avatar = avatar || user.avatar;
      if (user._removalTimeout) clearTimeout(user._removalTimeout);
      socket.join(roomId);
      socket.data.roomId = roomId;
      io.to(roomId).emit('user-updated', { socketId: socket.id, nickname: user.nickname, avatar: user.avatar, connected: true });
      return cb({ success: true, users: getOnlineUsers(room, socket.id) });
    }
    cb({ error: 'Reconnection failed. Please join again.' });
  });

  socket.on('lock-room', (locked, cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return cb({ error: 'Only host can lock.' });
    room.locked = !!locked;
    io.to(roomId).emit('room-locked', room.locked);
    cb({ success: true, locked: room.locked });
  });

  socket.on('kick-user', ({ targetSocketId }, cb) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id) return cb({ error: 'Only host can kick.' });
    const target = io.sockets.sockets.get(targetSocketId);
    if (target) {
      target.emit('kicked');
      target.disconnect(true);
    } else {
      const u = room.users.get(targetSocketId);
      if (u) { u.connected = false; removeUserFromRoom(roomId, targetSocketId); }
    }
    cb({ success: true });
  });

  // WebRTC signaling
  socket.on('offer', ({ to, offer }) => io.to(to).emit('offer', { from: socket.id, offer }));
  socket.on('answer', ({ to, answer }) => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  // Chat relay
  socket.on('chat-message', (data) => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit('chat-message', { type: 'chat', text: data.text, from: data.from, avatar: data.avatar, socketId: socket.id });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const user = room.users.get(socket.id);
      if (user) {
        user.connected = false;
        user.disconnectedAt = Date.now();
        user._removalTimeout = setTimeout(() => removeUserFromRoom(roomId, socket.id), 30000);
        io.to(roomId).emit('user-disconnected', { socketId: socket.id, nickname: user.nickname });
        io.to(roomId).emit('chat-message', { type: 'system', text: `${user.nickname} left the room.`, from: 'system' });
      }
    }
    socket.data.roomId = null;
  });
});

function getOnlineUsers(room, excludeSocketId) {
  return [...room.users.values()]
    .filter(u => u.socketId !== excludeSocketId && (u.connected || (u.disconnectedAt && Date.now() - u.disconnectedAt < 30000)))
    .map(u => ({ socketId: u.socketId, nickname: u.nickname, avatar: u.avatar, isHost: u.socketId === room.host }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
