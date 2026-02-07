// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// отдаём статику из public
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('join', (roomId, userName) => {
    if (!roomId) return;
    const room = io.sockets.adapter.rooms.get(roomId);
    const count = room ? room.size : 0;
    if (count >= 5) {
      socket.emit('full', roomId);
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName || socket.id;

    // собираем существующих участников
    const peers = [];
    for (const id of (io.sockets.adapter.rooms.get(roomId) || [])) {
      if (id === socket.id) continue;
      const s = io.sockets.sockets.get(id);
      peers.push({ id, userName: s?.userName || id });
    }

    socket.emit('joined', { roomId, you: socket.id, peers });

    // уведомляем остальных
    socket.to(roomId).emit('peer-joined', { id: socket.id, userName: socket.userName });
    console.log(`${socket.userName} joined ${roomId} (now ${count+1})`);
  });

  // сигналинг (peer-to-peer messages)
  socket.on('offer', data => { io.to(data.to).emit('offer', data); });
  socket.on('answer', data => { io.to(data.to).emit('answer', data); });
  socket.on('ice-candidate', data => { io.to(data.to).emit('ice-candidate', data); });

  // статусы UI: mute/unmute, screen-on/off
  socket.on('mute', data => { // data: { to, from, muted }
    if (data.to) io.to(data.to).emit('peer-muted', data);
    else if (socket.roomId) socket.to(socket.roomId).emit('peer-muted', data);
  });
  socket.on('screen-status', data => { // { to, from, sharing }
    if (data.to) io.to(data.to).emit('peer-screen', data);
    else if (socket.roomId) socket.to(socket.roomId).emit('peer-screen', data);
  });

  socket.on('disconnecting', () => {
    const roomId = socket.roomId;
    if (roomId) socket.to(roomId).emit('peer-left', { id: socket.id, userName: socket.userName });
  });

  socket.on('disconnect', () => { console.log('disconnect', socket.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
