import crypto from 'crypto';

const rooms = new Map();
const ROOM_TTL = 30 * 60 * 1000;

const createEmptyTransferSession = () => ({
  transferId: null,
  fileName: null,
  fileSize: 0,
  chunkSize: 0,
  totalChunks: 0,
  sha256: '',
  senderNextChunk: 0,
  receiverChunks: 0,
  status: 'idle',
  updatedAt: null,
});

export const createRoomService = async () => {
  const roomId = crypto.randomBytes(4).toString('hex');
  const token = crypto.randomBytes(12).toString('hex');
  const clientUrl = process.env.PUBLIC_CLIENT_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173';

  const roomData = {
    roomId,
    token,
    createdAt: Date.now(),
    users: [],
    status: 'waiting',
    transfer: createEmptyTransferSession(),
  };

  rooms.set(roomId, roomData);

  return {
    roomId,
    token,
    inviteLink: `${clientUrl}/join/${roomId}?token=${token}`,
  };
};

export const joinRoomServices = async (roomId , token) => {
  const room = validateRoomAccess(roomId, token);

  if(room.users.length >= 2){
    throw {
      status : 400,
      message : 'Room is full'
    }
  }

  const role = room.users.length === 0 ? 'creator' : 'joiner';

  room.users.push({
    role,
    joinedAt: Date.now(),
    clientId: null,
    socketId: null,
  });

  if(room.users.length === 2){
    room.status = 'ready';
  }

  return {
    roomId : room.roomId,
    status : room.status,
    userCount : room.users.length,
    role,
    message : 'Successfully joined the room',
    transferSession: room.transfer,
  }
}

const validateRoomAccess = (roomId, token) => {
  const room = rooms.get(roomId);

  if (!room) {
    throw {
      status: 404,
      message: 'Room not found',
    };
  }

  if (room.token !== token) {
    throw {
      status: 403,
      message: 'Invalid or unauthorized token',
    };
  }

  const isExpired = Date.now() - room.createdAt > ROOM_TTL;
  if (isExpired) {
    rooms.delete(roomId);
    throw {
      status: 410,
      message: 'Room has expired',
    };
  }

  return room;
};

export const attachSocketToRoomService = async (roomId, socketId, clientId) => {
  const room = rooms.get(roomId);

  if (!room) {
    throw {
      status: 404,
      message: 'Room not found',
    };
  }

  const participant = room.users.find((user) => user.clientId === clientId || user.socketId === socketId);
  if (participant) {
    participant.clientId = participant.clientId || clientId;
    participant.socketId = socketId;
    return {
      roomId: room.roomId,
      status: room.status,
      userCount: room.users.length,
      peerReady: room.users.length === 2,
      role: participant.role,
      transferSession: room.transfer,
    };
  }

  const slot = room.users.find((user) => user.socketId === null && user.clientId === null);
  if (!slot) {
    throw {
      status: 400,
      message: 'Room is full',
    };
  }

  slot.clientId = clientId;
  slot.socketId = socketId;

  return {
    roomId: room.roomId,
    status: room.status,
    userCount: room.users.length,
    peerReady: room.users.length === 2 && room.users.every((user) => user.socketId),
    role: slot.role,
    transferSession: room.transfer,
  };
};

export const joinSocketRoomService = async (roomId, token, socketId, clientId) => {
  const room = validateRoomAccess(roomId, token);

  const existingParticipant = room.users.find((user) => user.clientId === clientId || user.socketId === socketId);
  if (existingParticipant) {
    existingParticipant.clientId = existingParticipant.clientId || clientId;
    existingParticipant.socketId = socketId;
    return {
      roomId: room.roomId,
      status: room.status,
      userCount: room.users.length,
      peerReady: room.users.length === 2 && room.users.every((user) => user.socketId),
      role: existingParticipant.role,
      transferSession: room.transfer,
    };
  }

  const emptySlot = room.users.find((user) => user.socketId === null && user.clientId === null);
  if (emptySlot) {
    emptySlot.clientId = clientId;
    emptySlot.socketId = socketId;

    return {
      roomId: room.roomId,
      status: room.status,
      userCount: room.users.length,
      peerReady: room.users.length === 2 && room.users.every((user) => user.socketId),
      role: emptySlot.role,
      transferSession: room.transfer,
    };
  }

  if (room.users.length >= 2) {
    throw {
      status: 400,
      message: 'Room is full',
    };
  }

  const role = room.users.length === 0 ? 'creator' : 'joiner';

  room.users.push({
    role,
    joinedAt: Date.now(),
    clientId,
    socketId,
  });

  if (room.users.length === 2) {
    room.status = 'ready';
  }

  return {
    roomId: room.roomId,
    status: room.status,
    userCount: room.users.length,
    peerReady: room.users.length === 2 && room.users.every((user) => user.socketId),
    role,
    transferSession: room.transfer,
  };
};

export const detachSocketFromRoomService = (roomId, socketId, { releaseSlot = false } = {}) => {
  const room = rooms.get(roomId);
  if (!room) return;

  if (releaseSlot) {
    room.users = room.users.filter((user) => user.socketId !== socketId);
  } else {
    const participant = room.users.find((user) => user.socketId === socketId);
    if (participant) {
      participant.socketId = null;
    }
  }

  if (room.users.length < 2) {
    room.status = 'waiting';
  }
};

export const getRoomById = (roomId) => rooms.get(roomId);

export const updateTransferSession = (roomId, patch) => {
  const room = rooms.get(roomId);
  if (!room) return null;

  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  );

  room.transfer = {
    ...room.transfer,
    ...cleanPatch,
    updatedAt: Date.now(),
  };

  return room.transfer;
};

export const getTransferSession = (roomId) => {
  const room = rooms.get(roomId);
  return room?.transfer || null;
};

export const removeRoom = (roomId) => {
  rooms.delete(roomId);
};
