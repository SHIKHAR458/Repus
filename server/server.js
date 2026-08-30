import 'dotenv/config';
import http from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import {
  detachSocketFromRoomService,
  joinSocketRoomService,
  updateTransferSession,
} from './src/services/roomService.js';

const server = http.createServer(app);
const isProduction = process.env.NODE_ENV === 'production';

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  if (!isProduction) {
    console.log('User connected:', socket.id);
  }

  socket.on('join-room', async ({ roomId, token, clientId }) => {
    try {
      if (!clientId) {
        throw {
          status: 400,
          message: 'Missing client session id',
        };
      }

      const roomDetails = await joinSocketRoomService(roomId, token, socket.id, clientId);

      socket.join(roomId);
      socket.data.roomId = roomId;

      socket.emit('room-joined', roomDetails);

      if (roomDetails.peerReady) {
        socket.to(roomId).emit('peer-joined', {
          roomId,
          socketId: socket.id,
        });
      }
    } catch (error) {
      socket.emit('room-error', {
        message: error.message || 'Failed to join room',
      });
    }
  });

  socket.on('transfer-checkpoint', ({ roomId, transferId, role, nextChunkIndex, totalChunks, fileName, fileSize, chunkSize, sha256, status }) => {
    if (!roomId || !transferId) {
      return;
    }

    const patch = {
      transferId,
    };

    if (typeof totalChunks === 'number') patch.totalChunks = totalChunks;
    if (typeof fileName === 'string') patch.fileName = fileName;
    if (typeof fileSize === 'number') patch.fileSize = fileSize;
    if (typeof chunkSize === 'number') patch.chunkSize = chunkSize;
    if (typeof sha256 === 'string') patch.sha256 = sha256;
    if (typeof status === 'string') patch.status = status;

    if (role === 'creator') {
      patch.senderNextChunk = nextChunkIndex;
    }

    if (role === 'joiner') {
      patch.receiverChunks = nextChunkIndex;
    }

    const session = updateTransferSession(roomId, patch);

    if (session) {
      io.to(roomId).emit('transfer-state', {
        roomId,
        transferSession: session,
      });
    }
  });

  socket.on('leave-room', ({ roomId }) => {
    detachSocketFromRoomService(roomId, socket.id, { releaseSlot: true });
    socket.leave(roomId);
  });

  socket.on('webrtc-offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('webrtc-offer', {
      offer,
      from: socket.id,
    });
  });

  socket.on('webrtc-answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('webrtc-answer', {
      answer,
      from: socket.id,
    });
  });

  socket.on('webrtc-ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('webrtc-ice-candidate', {
      candidate,
      from: socket.id,
    });
  });

  socket.on('disconnect', () => {
    if (socket.data.roomId) {
      detachSocketFromRoomService(socket.data.roomId, socket.id);
    }

    if (!isProduction) {
      console.log('User disconnected:', socket.id);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
