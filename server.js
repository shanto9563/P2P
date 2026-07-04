const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

class Room {
  constructor(id, options = {}) {
    this.id = id;
    this.password = options.password || null;
    this.locked = false;
    this.users = new Map();
    this.createdAt = Date.now();
  }

  addUser(socketId, userInfo) {
    this.users.set(socketId, userInfo);
  }

  removeUser(socketId) {
    this.users.delete(socketId);
    return this.users.size === 0;
  }

  getUserList() {
    return Array.from(this.users.entries()).map(([socketId, info]) => ({
      socketId,
      ...info
    }));
  }

  isEmpty() {
    return this.users.size === 0;
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let userInfo = null;

  socket.on('create-room', (data, callback) => {
    const roomId = (data.roomId && data.roomId.trim()) || generateRoomId();
    const upperRoomId = roomId.toUpperCase();
    
    if (rooms.has(upperRoomId)) {
      return callback({ success: false, error: 'Room already exists' });
    }

    const room = new Room(upperRoomId, {
      password: data.password || null
    });
    rooms.set(upperRoomId, room);

    userInfo = {
      nickname: data.nickname || 'Anonymous',
      avatar: data.avatar || '',
      isHost: true,
      joinedAt: Date.now()
    };

    room.addUser(socket.id, userInfo);
    socket.join(upperRoomId);
    currentRoom = upperRoomId;

    callback({ success: true, roomId: upperRoomId });
  });

  socket.on('join-room', (data, callback) => {
    const roomId = (data.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);

    if (!room) {
      return callback({ success: false, error: 'Room not found' });
    }

    if (room.locked) {
      return callback({ success: false, error: 'Room is locked' });
    }

    if (room.password && data.password !== room.password) {
      return callback({ success: false, error: 'Incorrect password' });
    }

    userInfo = {
      nickname: data.nickname || 'Anonymous',
      avatar: data.avatar || '',
      isHost: false,
      joinedAt: Date.now()
    };

    room.addUser(socket.id, userInfo);
    socket.join(roomId);
    currentRoom = roomId;

    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      ...userInfo
    });

    callback({
      success: true,
      roomId,
      users: room.getUserList(),
      locked: room.locked
    });
  });

  socket.on('send-offer', (data) => {
    io.to(data.targetSocketId).emit('receive-offer', {
      fromSocketId: socket.id,
      sdp: data.sdp
    });
  });

  socket.on('send-answer', (data) => {
    io.to(data.targetSocketId).emit('receive-answer', {
      fromSocketId: socket.id,
      sdp: data.sdp
    });
  });

  socket.on('send-ice-candidate', (data) => {
    io.to(data.targetSocketId).emit('receive-ice-candidate', {
      fromSocketId: socket.id,
      candidate: data.candidate
    });
  });

  socket.on('chat-message', (data) => {
    if (!currentRoom) return;
    
    const message = {
      from: socket.id,
      nickname: userInfo?.nickname || 'Anonymous',
      avatar: userInfo?.avatar || '',
      message: data.message,
      timestamp: Date.now(),
      type: data.type || 'user'
    };

    io.to(currentRoom).emit('chat-message', message);
  });

  socket.on('lock-room', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user?.isHost) return;

    room.locked = data.locked;
    io.to(currentRoom).emit('room-locked', { locked: data.locked });
  });

  socket.on('kick-user', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user?.isHost) return;

    const targetSocket = io.sockets.sockets.get(data.targetSocketId);
    if (targetSocket) {
      targetSocket.emit('kicked', { reason: data.reason || 'You have been kicked' });
      targetSocket.leave(currentRoom);
      room.removeUser(data.targetSocketId);
      
      io.to(currentRoom).emit('user-left', {
        socketId: data.targetSocketId,
        notify: true
      });
    }
  });

  socket.on('update-user', (data) => {
    if (!currentRoom || !userInfo) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (data.nickname) userInfo.nickname = data.nickname;
    if (data.avatar) userInfo.avatar = data.avatar;

    room.addUser(socket.id, userInfo);
    io.to(currentRoom).emit('user-updated', {
      socketId: socket.id,
      ...userInfo
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        const isEmpty = room.removeUser(socket.id);
        
        socket.to(currentRoom).emit('user-left', {
          socketId: socket.id,
          notify: true
        });

        if (isEmpty) {
          rooms.delete(currentRoom);
        }
      }
    }
  });

  socket.on('leave-room', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        const isEmpty = room.removeUser(socket.id);
        
        socket.to(currentRoom).emit('user-left', {
          socketId: socket.id,
          notify: true
        });

        if (isEmpty) {
          rooms.delete(currentRoom);
        }
      }
      
      socket.leave(currentRoom);
      currentRoom = null;
      userInfo = null;
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.isEmpty() && now - room.createdAt > 3600000) {
      rooms.delete(roomId);
    }
  }
}, 300000);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});