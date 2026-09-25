import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { socket } from '../socket.js';
import { createPeerConnection, setupDataChannel } from '../services/webrtc.js';
import { getClientId } from '../services/clientIdentity.js';
import {
  CHUNK_SIZE,
  ACK_INTERVAL_BYTES,
  CHECKPOINT_INTERVAL_BYTES,
  MAX_BUFFERED_AMOUNT,
  TRANSFER_TYPES,
  createChunkFrame,
  createControlMessage,
  createSha256,
  digestFileSha256,
  parseChunkFrame,
  parseControlMessage,
  waitForBufferedAmount,
} from '../services/fileTransfer.js';
import {
  createChunkBatcher,
  getStoredChunk,
  getStoredTransfer,
  readTransferChunks,
  saveTransferMetadata,
} from '../services/transferStorage.js';

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [status, setStatus] = useState('Connecting to room...');
  const [inviteLink] = useState(location.state?.inviteLink || '');
  const [role, setRole] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [activity, setActivity] = useState(['Waiting for peer connection...']);
  const [transferMessage, setTransferMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [sendProgress, setSendProgress] = useState(0);
  const [receiveProgress, setReceiveProgress] = useState(0);
  const [incomingFile, setIncomingFile] = useState(null);
  const [downloadFile, setDownloadFile] = useState(null);
  const [integrityStatus, setIntegrityStatus] = useState('');

  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const incomingMetaRef = useRef(null);
  const receiveQueueRef = useRef(Promise.resolve());
  const receiverAckRef = useRef(-1);
  const receiverHashRef = useRef(null);
  const chunkBatcherRef = useRef(null);
  const senderHashPromiseRef = useRef(null);
  const lastSenderCheckpointRef = useRef(-1);
  const lastReceiverCheckpointRef = useRef(-1);
  const lastSendProgressUpdateRef = useRef(0);
  const lastReceiveProgressUpdateRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const isPausedRef = useRef(false);
  const joinedRef = useRef(false);
  const clientIdRef = useRef(getClientId());
  const selectedFileRef = useRef(null);
  const roleRef = useRef('');
  const sendStateRef = useRef({
    transferId: '',
    file: null,
    totalChunks: 0,
    nextChunkIndex: 0,
    sha256: '',
    started: false,
    awaitingReceiverAck: false,
    receiverAcknowledgedChunk: -1,
  });

  const isCreator = role === 'creator';
  const isJoiner = role === 'joiner';
  const isChannelOpen = channelRef.current?.readyState === 'open';
  const resumableStatuses = ['active', 'paused', 'receiving', 'interrupted'];
  const outgoingProgress =
    sendStateRef.current.totalChunks > 0
      ? Math.max(
          sendProgress,
          Math.min(
            100,
            Math.round((sendStateRef.current.nextChunkIndex / sendStateRef.current.totalChunks) * 100)
          )
        )
      : sendProgress;
  const canResumeActiveTransfer = () =>
    roleRef.current === 'creator' &&
    Boolean(selectedFileRef.current) &&
    sendStateRef.current.started &&
    !isPausedRef.current;

  const pushActivity = (message) => {
    setActivity((items) => [message, ...items].slice(0, 8));
  };

  const handleRoomError = (error) => {
    const message = error?.message || 'Failed to join room';
    setStatus(message);
    pushActivity(message);
  };

  const resetIncomingTransfer = () => {
    incomingMetaRef.current = null;
    receiverAckRef.current = -1;
    receiverHashRef.current = null;
    chunkBatcherRef.current = null;
    setIncomingFile(null);
    setReceiveProgress(0);
    setIntegrityStatus('');
  };

  const emitCreatorCheckpoint = (status = 'active', force = false) => {
    const state = sendStateRef.current;
    if (!roomId || !state.transferId) return;

    const minimumChunks = Math.ceil(CHECKPOINT_INTERVAL_BYTES / CHUNK_SIZE);
    if (!force && state.nextChunkIndex - lastSenderCheckpointRef.current < minimumChunks) return;

    lastSenderCheckpointRef.current = state.nextChunkIndex;
    socket.emit('transfer-checkpoint', {
      roomId,
      transferId: state.transferId,
      role: 'creator',
      nextChunkIndex: state.nextChunkIndex,
      totalChunks: state.totalChunks,
      fileName: state.file?.name || '',
      fileSize: state.file?.size || 0,
      chunkSize: CHUNK_SIZE,
      sha256: state.sha256,
      status,
    });
  };

  const emitReceiverCheckpoint = (metadata, status = 'receiving', force = false) => {
    if (!roomId || !metadata?.transferId) return;

    const minimumChunks = Math.ceil(CHECKPOINT_INTERVAL_BYTES / CHUNK_SIZE);
    if (!force && metadata.receivedThrough - lastReceiverCheckpointRef.current < minimumChunks) return;

    lastReceiverCheckpointRef.current = metadata.receivedThrough;
    socket.emit('transfer-checkpoint', {
      roomId,
      transferId: metadata.transferId,
      role: 'joiner',
      nextChunkIndex: metadata.receivedThrough + 1,
      totalChunks: metadata.totalChunks,
      fileName: metadata.name,
      fileSize: metadata.size,
      chunkSize: CHUNK_SIZE,
      sha256: metadata.sha256 || '',
      status,
    });
  };

  const closePeerConnection = () => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    channelRef.current = null;
    pendingCandidatesRef.current = [];
  };

  const scheduleConnectionRecovery = () => {
    if (roleRef.current !== 'creator' || reconnectTimerRef.current) return;

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void startOfferFlow().catch((error) => {
        console.error('Failed to restart the peer connection:', error);
        setStatus('Connection recovery failed');
        pushActivity('Connection recovery failed');
      });
    }, 1_000);
  };

  const digestStoredTransfer = async (metadata) => {
    if (typeof Worker === 'undefined') {
      const hash = createSha256();

      for (let sequenceNumber = 0; sequenceNumber < metadata.totalChunks; sequenceNumber += 1) {
        const chunk = await getStoredChunk(metadata.transferId, sequenceNumber);
        if (!chunk) throw new Error(`Missing persisted chunk ${sequenceNumber}.`);
        hash.update(new Uint8Array(chunk));
      }

      return hash.digestHex();
    }

    const worker = new Worker(new URL('../services/sha256.worker.js', import.meta.url), { type: 'module' });
    const hashId = crypto.randomUUID();
    const waitForWorkerMessage = (expectedType) =>
      new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if (data?.id !== hashId) return;
          if (data.error) {
            reject(new Error(data.error));
            return;
          }
          if (expectedType === 'chunk' && data.type === 'hash-chunk-processed') resolve();
          if (expectedType === 'digest' && data.sha256) resolve(data.sha256);
        };
        worker.onerror = () => reject(new Error('Unable to verify SHA-256 in a background worker.'));
      });

    try {
      worker.postMessage({ type: 'hash-start', id: hashId });

      for (let sequenceNumber = 0; sequenceNumber < metadata.totalChunks; sequenceNumber += 1) {
        const chunk = await getStoredChunk(metadata.transferId, sequenceNumber);
        if (!chunk) throw new Error(`Missing persisted chunk ${sequenceNumber}.`);

        const processed = waitForWorkerMessage('chunk');
        worker.postMessage({ type: 'hash-chunk', id: hashId, chunk }, [chunk]);
        await processed;
      }

      const digest = waitForWorkerMessage('digest');
      worker.postMessage({ type: 'hash-end', id: hashId });
      return await digest;
    } finally {
      worker.terminate();
    }
  };

  const finalizeIncomingFile = async (expectedHash) => {
    const metadata = incomingMetaRef.current;
    if (!metadata) return;

    // Use the incrementally-computed hash when available, falling back to
    // the slow re-read path only if the incremental hasher is missing
    // (e.g. due to a page reload mid-transfer).
    const receivedHash = receiverHashRef.current
      ? receiverHashRef.current.digestHex()
      : await digestStoredTransfer(metadata);
    const integrityOk = Boolean(expectedHash) && receivedHash === expectedHash;

    setDownloadFile({
      name: metadata.name,
      size: metadata.size,
      mimeType: metadata.mimeType,
      transferId: metadata.transferId,
      totalChunks: metadata.totalChunks,
    });
    setIntegrityStatus(
      expectedHash
        ? integrityOk
          ? 'Integrity verified: SHA-256 matched.'
          : 'Integrity check failed: SHA-256 mismatch.'
        : 'Integrity check unavailable for this transfer.'
    );
    setTransferMessage(`Received ${metadata.name}. Download is ready.`);
    pushActivity(`File received: ${metadata.name}`);
    pushActivity(
      expectedHash
        ? integrityOk
          ? 'SHA-256 integrity verified'
          : 'SHA-256 integrity mismatch'
        : 'No SHA-256 hash provided'
    );
  };

  const sendReceiverAck = (metadata, force = false) => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== 'open') return;

    const receivedSinceLastAck = metadata.receivedThrough - receiverAckRef.current;
    const minimumChunks = Math.ceil(ACK_INTERVAL_BYTES / CHUNK_SIZE);
    if (!force && receivedSinceLastAck < minimumChunks) return;

    receiverAckRef.current = metadata.receivedThrough;
    channel.send(
      createControlMessage(TRANSFER_TYPES.ACK, {
        transferId: metadata.transferId,
        receivedThrough: metadata.receivedThrough,
      })
    );
  };

  const handleDataMessage = async (message) => {
    const control = parseControlMessage(message);

    if (control?.type === TRANSFER_TYPES.META) {
      const stored = await getStoredTransfer(control.transferId);
      const canResumeStoredTransfer =
        stored && stored.name === control.name && stored.size === control.size && stored.totalChunks === control.totalChunks;
      const metadata = {
        transferId: control.transferId || '',
        name: control.name,
        size: control.size,
        mimeType: control.mimeType,
        totalChunks: control.totalChunks,
        sha256: control.sha256 || stored?.sha256 || '',
        receivedBytes: canResumeStoredTransfer ? stored.receivedBytes || 0 : 0,
        receivedThrough: canResumeStoredTransfer ? stored.receivedThrough ?? -1 : -1,
      };
      incomingMetaRef.current = metadata;
      receiverAckRef.current = metadata.receivedThrough;

      // Start an incremental SHA-256 hasher for this transfer.  When we
      // are resuming, replay the already-persisted chunks into the hasher
      // so the running digest stays correct.
      const hash = createSha256();
      if (canResumeStoredTransfer && metadata.receivedThrough >= 0) {
        for (let seq = 0; seq <= metadata.receivedThrough; seq += 1) {
          const stored = await getStoredChunk(metadata.transferId, seq);
          if (stored) hash.update(new Uint8Array(stored));
        }
      }
      receiverHashRef.current = hash;

      // Create a chunk batcher so incoming chunks accumulate in memory and
      // are flushed to IndexedDB in bulk (~32 at a time).
      chunkBatcherRef.current = createChunkBatcher(metadata.transferId);

      await saveTransferMetadata(metadata);
      setIncomingFile({
        name: metadata.name,
        size: metadata.size,
        mimeType: metadata.mimeType,
        totalChunks: metadata.totalChunks,
      });
      setDownloadFile(null);
      setReceiveProgress(Math.round((metadata.receivedBytes / metadata.size) * 100) || 0);
      setTransferMessage(
        metadata.receivedThrough >= 0
          ? `Resuming ${metadata.name} from chunk ${metadata.receivedThrough + 1}.`
          : `Incoming file: ${metadata.name}`
      );
      pushActivity(`Incoming file announced: ${metadata.name}`);
      sendReceiverAck(metadata, true);
      return;
    }

    if (control?.type === TRANSFER_TYPES.END) {
      setReceiveProgress(100);

      // Flush any remaining batched chunks to IndexedDB before verification.
      if (chunkBatcherRef.current) {
        await chunkBatcherRef.current.flush();
      }

      await finalizeIncomingFile(control.sha256);
      if (incomingMetaRef.current) {
        await saveTransferMetadata({
          ...incomingMetaRef.current,
          sha256: control.sha256 || '',
          completed: true,
        });
        emitReceiverCheckpoint(incomingMetaRef.current, 'completed', true);
      }
      return;
    }

    if (control?.type === TRANSFER_TYPES.ACK) {
      const state = sendStateRef.current;
      if (roleRef.current !== 'creator' || control.transferId !== state.transferId) return;

      const receivedThrough = Number.isInteger(control.receivedThrough) ? control.receivedThrough : -1;
      state.receiverAcknowledgedChunk = Math.max(state.receiverAcknowledgedChunk, receivedThrough);

      if (state.awaitingReceiverAck) {
        state.nextChunkIndex = Math.max(0, receivedThrough + 1);
        state.awaitingReceiverAck = false;
        setTransferMessage(`Receiver ready. Sending ${state.file?.name || 'file'}...`);
        void handleSendFile();
      }
      return;
    }

    if (typeof message === 'string') {
      pushActivity(`Message received: ${message}`);
      return;
    }

    const rawFrame = message instanceof ArrayBuffer ? message : await message.arrayBuffer?.();
    const frame = rawFrame ? parseChunkFrame(rawFrame) : null;
    const metadata = incomingMetaRef.current;

    if (!frame || !metadata || frame.transferId !== metadata.transferId) {
      return;
    }

    if (frame.sequenceNumber < metadata.receivedThrough + 1) {
      sendReceiverAck(metadata, true);
      return;
    }

    if (frame.sequenceNumber !== metadata.receivedThrough + 1) {
      throw new Error(`Expected chunk ${metadata.receivedThrough + 1}, received ${frame.sequenceNumber}.`);
    }

    metadata.receivedBytes += frame.data.byteLength;
    metadata.receivedThrough = frame.sequenceNumber;

    // Feed the chunk into the incremental SHA-256 hasher.
    if (receiverHashRef.current) {
      receiverHashRef.current.update(new Uint8Array(frame.data));
    }

    // Batch the chunk in memory — the batcher auto-flushes to IndexedDB
    // every 32 chunks instead of writing each one individually.
    if (chunkBatcherRef.current) {
      chunkBatcherRef.current.add(frame.sequenceNumber, frame.data, metadata);
    }

    const progress = Math.min(
      100,
      Math.round((metadata.receivedBytes / metadata.size) * 100)
    );

    const now = Date.now();
    if (now - lastReceiveProgressUpdateRef.current >= 150 || progress === 100) {
      lastReceiveProgressUpdateRef.current = now;
      setReceiveProgress(progress);
    }

    sendReceiverAck(metadata);
    emitReceiverCheckpoint(metadata);
  };

  const attachChannelHandlers = (channel) => {
    channel.binaryType = 'arraybuffer';

    setupDataChannel(channel, {
      onOpen: () => {
        setStatus('Data channel open');
        pushActivity('Data channel open');
        if (canResumeActiveTransfer()) {
          const state = sendStateRef.current;
          state.awaitingReceiverAck = true;
          channel.send(
            createControlMessage(TRANSFER_TYPES.META, {
              transferId: state.transferId,
              name: state.file?.name,
              size: state.file?.size,
              mimeType: state.file?.type,
              totalChunks: state.totalChunks,
              chunkSize: CHUNK_SIZE,
            })
          );
          setTransferMessage('Connection restored. Checking receiver progress...');
          emitCreatorCheckpoint('active', true);
        }
      },
      onMessage: (message) => {
        receiveQueueRef.current = receiveQueueRef.current
          .then(() => handleDataMessage(message))
          .catch((error) => {
            console.error('Failed to process transfer message:', error);
            setTransferMessage('Transfer message could not be processed.');
            pushActivity('Transfer message processing failed');
          });
      },
      onError: (error) => {
        console.error('Data channel error:', error);
        pushActivity('Data channel error');
      },
      onClose: () => {
        setStatus('Data channel closed');
        pushActivity('Data channel closed');
        channelRef.current = null;
      },
    });
  };

  const flushPendingCandidates = async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;

    const candidates = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.error('Error adding queued ICE candidate:', error);
      }
    }
  };

  const createConnection = () => {
    if (pcRef.current && !['closed', 'failed'].includes(pcRef.current.connectionState)) {
      return pcRef.current;
    }

    closePeerConnection();

    const pc = createPeerConnection({
      onIceCandidate: (candidate) => {
        socket.emit('webrtc-ice-candidate', { roomId, candidate });
      },
      onConnectionStateChange: (state) => {
        setStatus(`Connection: ${state}`);
        pushActivity(`Connection state: ${state}`);
        if (state === 'failed') {
          closePeerConnection();
          scheduleConnectionRecovery();
        }
      },
      onIceConnectionStateChange: (state) => {
        if (state === 'disconnected') {
          setStatus('Connection: disconnected');
          pushActivity('ICE connection disconnected');
        }

        if (state === 'failed') {
          setStatus('Connection: failed');
          pushActivity('ICE connection failed');
          closePeerConnection();
          scheduleConnectionRecovery();
        }
      },
      onDataChannel: (channel) => {
        channelRef.current = channel;
        attachChannelHandlers(channel);
      },
    });

    pcRef.current = pc;
    return pc;
  };

  const startOfferFlow = async () => {
    const pc = createConnection();

    if (channelRef.current?.readyState === 'open' || channelRef.current?.readyState === 'connecting') {
      return;
    }

    const channel = pc.createDataChannel('file-channel', {
      ordered: true,
    });
    channelRef.current = channel;
    attachChannelHandlers(channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('webrtc-offer', {
      roomId,
      offer,
    });
  };

  const handleIncomingOffer = async (offer) => {
    const pc = pcRef.current || createConnection();

    await pc.setRemoteDescription(offer);
    await flushPendingCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      roomId,
      answer,
    });
  };

  const handleIncomingAnswer = async (answer) => {
    const pc = pcRef.current;
    if (!pc) return;

    await pc.setRemoteDescription(answer);
    await flushPendingCandidates();
  };

  const handleIncomingCandidate = async (candidate) => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.error('Error adding ICE candidate:', error);
    }
  };

  const handleFileSelect = (event) => {
    const file = event.target.files?.[0] || null;
    setSelectedFile(file);
    selectedFileRef.current = file;
    setSendProgress(0);
    setIntegrityStatus('');
    setIsPaused(false);
    isPausedRef.current = false;
    sendStateRef.current = {
      transferId: '',
      file,
      totalChunks: 0,
      nextChunkIndex: 0,
      sha256: '',
      started: false,
      awaitingReceiverAck: false,
      receiverAcknowledgedChunk: -1,
    };
    senderHashPromiseRef.current = null;
    lastSenderCheckpointRef.current = -1;
    lastSendProgressUpdateRef.current = 0;

    if (file) {
      setTransferMessage(`Selected ${file.name}`);
      pushActivity(`Selected file: ${file.name}`);
    }
  };

  const handleSendFile = async () => {
    const activeFile = selectedFileRef.current || selectedFile;
    const channel = channelRef.current;

    if (!activeFile || channel?.readyState !== 'open' || roleRef.current !== 'creator' || isSending) {
      return;
    }

    const totalChunks = Math.ceil(activeFile.size / CHUNK_SIZE);
    const sendState = sendStateRef.current;

    try {
      if (!sendState.started) {
        sendState.transferId = crypto.randomUUID();
        sendState.file = activeFile;
        sendState.totalChunks = totalChunks;
        sendState.nextChunkIndex = 0;
        sendState.started = true;
        sendState.awaitingReceiverAck = true;
        senderHashPromiseRef.current = digestFileSha256(activeFile);
        setSendProgress(0);
        setTransferMessage(`Preparing ${activeFile.name} for direct transfer...`);
        pushActivity(`Started transfer: ${activeFile.name}`);
        channel.send(
          createControlMessage(TRANSFER_TYPES.META, {
            transferId: sendState.transferId,
            name: activeFile.name,
            size: activeFile.size,
            mimeType: activeFile.type,
            totalChunks,
            chunkSize: CHUNK_SIZE,
          })
        );
        emitCreatorCheckpoint('active', true);
        return;
      }

      if (sendState.awaitingReceiverAck) {
        return;
      }

      setIsSending(true);
      setSendProgress(outgoingProgress);
      for (let index = sendState.nextChunkIndex; index < totalChunks; index += 1) {
        if (!sendStateRef.current.started || sendStateRef.current.file !== activeFile) {
          break;
        }

        while (
          sendStateRef.current.started &&
          sendStateRef.current.nextChunkIndex === index &&
          isPausedRef.current
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }

        if (!sendStateRef.current.started || sendStateRef.current.file !== activeFile) {
          break;
        }

        const start = index * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, activeFile.size);

        // Pre-read the next chunk while we wait for the current one to be
        // sent, overlapping disk I/O with network I/O.
        const chunkPromise = activeFile.slice(start, end).arrayBuffer();
        const nextIndex = index + 1;
        let nextChunkPromise = null;
        if (nextIndex < totalChunks && !isPausedRef.current) {
          const nextStart = nextIndex * CHUNK_SIZE;
          const nextEnd = Math.min(nextStart + CHUNK_SIZE, activeFile.size);
          nextChunkPromise = activeFile.slice(nextStart, nextEnd).arrayBuffer();
        }
        const chunk = await chunkPromise;

        if (isPausedRef.current) {
          sendStateRef.current.nextChunkIndex = index;
          setTransferMessage(`Paused at ${index + 1} of ${totalChunks} chunks.`);
          pushActivity(`Transfer paused at chunk ${index + 1}`);
          break;
        }

        await waitForBufferedAmount(channel, MAX_BUFFERED_AMOUNT, () => isPausedRef.current);

        if (isPausedRef.current) {
          sendStateRef.current.nextChunkIndex = index;
          setTransferMessage(`Paused at ${index + 1} of ${totalChunks} chunks.`);
          pushActivity(`Transfer paused at chunk ${index + 1}`);
          break;
        }

        channel.send(
          createChunkFrame({
            transferId: sendState.transferId,
            sequenceNumber: index,
            data: chunk,
          })
        );

        const totalPushedBytes = (index + 1) * CHUNK_SIZE;
        const actualSentBytes = Math.max(0, totalPushedBytes - channel.bufferedAmount);
        const progress = Math.min(
          100,
          Math.round((actualSentBytes / activeFile.size) * 100)
        );
        sendStateRef.current.nextChunkIndex = index + 1;
        const now = Date.now();
        if (now - lastSendProgressUpdateRef.current >= 150 || progress === 100) {
          lastSendProgressUpdateRef.current = now;
          setSendProgress(progress);
        }
        emitCreatorCheckpoint(isPausedRef.current ? 'paused' : 'active');
      }

      if (!isPausedRef.current && sendStateRef.current.nextChunkIndex >= totalChunks) {
        setTransferMessage('Finalizing SHA-256 integrity verification...');
        const sha256 = await senderHashPromiseRef.current;
        sendStateRef.current.sha256 = sha256;
        channel.send(
          createControlMessage(TRANSFER_TYPES.END, {
            transferId: sendStateRef.current.transferId,
            name: activeFile.name,
            totalChunks,
            sha256,
          })
        );

        setTransferMessage(`Finished sending ${activeFile.name}`);
        pushActivity(`SHA-256: ${sendStateRef.current.sha256.slice(0, 12)}...`);
        pushActivity(`Finished transfer: ${activeFile.name}`);
        sendStateRef.current.started = false;
        emitCreatorCheckpoint('completed', true);
      } else if (isPausedRef.current) {
        setTransferMessage(`Paused at ${sendStateRef.current.nextChunkIndex} of ${totalChunks} chunks.`);
      }
    } catch (error) {
      console.error('Failed to send file:', error);
      if (channelRef.current?.readyState !== 'open') {
        setTransferMessage('Connection lost. Transfer will resume when the peer reconnects.');
        pushActivity('Transfer interrupted by connection loss');
        emitCreatorCheckpoint('interrupted', true);
      } else {
        const message = error instanceof Error ? error.message : 'File transfer failed.';
        setTransferMessage(`File transfer failed: ${message}`);
        pushActivity(`File transfer failed: ${message}`);
        sendStateRef.current.started = false;
        emitCreatorCheckpoint('error', true);
      }
    } finally {
      setIsSending(false);
    }
  };

  const handlePauseTransfer = () => {
    if (!isCreator || !sendStateRef.current.started) {
      return;
    }

    isPausedRef.current = true;
    setIsPaused(true);
    setTransferMessage('Transfer paused. Resume will continue from the same chunk.');
    pushActivity('Sender paused transfer');
    emitCreatorCheckpoint('paused', true);
  };

  const handleResumeTransfer = async () => {
    if (!isCreator || !selectedFile || !sendStateRef.current.started || !isPaused) {
      return;
    }

    isPausedRef.current = false;
    setIsPaused(false);
    pushActivity('Sender resumed transfer');
    emitCreatorCheckpoint('active', true);

    const channel = channelRef.current;
    const state = sendStateRef.current;
    if (channel?.readyState !== 'open') {
      setTransferMessage('Waiting for the direct connection before resuming.');
      return;
    }

    state.awaitingReceiverAck = true;
    channel.send(
      createControlMessage(TRANSFER_TYPES.META, {
        transferId: state.transferId,
        name: state.file?.name,
        size: state.file?.size,
        mimeType: state.file?.type,
        totalChunks: state.totalChunks,
        chunkSize: CHUNK_SIZE,
      })
    );
    setTransferMessage('Checking receiver progress before resuming...');
  };

  const handleDownloadFile = async () => {
    if (!downloadFile) return;

    try {
      setTransferMessage(`Saving ${downloadFile.name}...`);

      if ('showSaveFilePicker' in window) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: downloadFile.name,
        });
        const writable = await fileHandle.createWritable();

        for (let sequenceNumber = 0; sequenceNumber < downloadFile.totalChunks; sequenceNumber += 1) {
          const chunk = await getStoredChunk(downloadFile.transferId, sequenceNumber);
          if (!chunk) {
            throw new Error(`Missing persisted chunk ${sequenceNumber}.`);
          }
          await writable.write(chunk);
        }

        await writable.close();
        setTransferMessage(`Saved ${downloadFile.name}.`);
        pushActivity(`Saved file: ${downloadFile.name}`);
        return;
      }

      if (downloadFile.size > 200 * 1024 * 1024) {
        throw new Error('Use a Chromium-based browser to save files larger than 200 MB without loading them into memory.');
      }

      const chunks = await readTransferChunks(downloadFile.transferId);
      const blob = new Blob(chunks, { type: downloadFile.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadFile.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setTransferMessage(`Download started for ${downloadFile.name}.`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        setTransferMessage('Save cancelled. Your received chunks are still stored safely.');
        return;
      }

      console.error('Failed to save received file:', error);
      setTransferMessage(error?.message || 'Unable to save the received file.');
    }
  };

  const copyInviteLink = async () => {
    if (!inviteLink) return;

    try {
      await navigator.clipboard.writeText(inviteLink);
      setTransferMessage('Invite link copied to clipboard.');
      pushActivity('Invite link copied');
    } catch (error) {
      console.error('Failed to copy invite link:', error);
    }
  };

  useEffect(() => {
    if (!roomId) {
      setStatus('Missing room id');
      return;
    }

    const handleRoomJoined = async (data) => {
      if (data.roomId !== roomId) return;

      setRole(data.role);
      roleRef.current = data.role;
      setStatus(data.peerReady ? 'Peer is ready' : 'Waiting for another user...');
      pushActivity(`Joined as ${data.role || 'peer'}`);

      if (data.role === 'creator') {
        setTransferMessage('You can send files once the guest joins.');
      } else if (data.role === 'joiner') {
        setTransferMessage('You can receive files once the creator starts transfer.');
      }

      if (data.role === 'creator' && data.transferSession?.transferId) {
        sendStateRef.current.transferId = data.transferSession.transferId;
        sendStateRef.current.file = selectedFileRef.current;
        sendStateRef.current.totalChunks = data.transferSession.totalChunks || 0;
        sendStateRef.current.nextChunkIndex =
          typeof data.transferSession.receiverChunks === 'number'
            ? data.transferSession.receiverChunks
            : data.transferSession.senderNextChunk || 0;
        sendStateRef.current.sha256 = data.transferSession.sha256 || '';
        sendStateRef.current.started =
          Boolean(selectedFileRef.current) && resumableStatuses.includes(data.transferSession.status);
        if (data.transferSession.status === 'paused') {
          setIsPaused(true);
          isPausedRef.current = true;
        }
      }
    };

    const handlePeerJoined = async (data) => {
      if (data.roomId !== roomId) return;
      setStatus('Peer joined, starting connection...');
      pushActivity('Peer joined room');
      await startOfferFlow();
    };

    const handleOffer = async ({ offer }) => {
      await handleIncomingOffer(offer);
    };

    const handleAnswer = async ({ answer }) => {
      await handleIncomingAnswer(answer);
    };

    const handleIceCandidate = async ({ candidate }) => {
      await handleIncomingCandidate(candidate);
    };

    const handleTransferState = ({ roomId: incomingRoomId, transferSession: session }) => {
      if (incomingRoomId !== roomId) return;
      if (session?.transferId && roleRef.current === 'creator' && sendStateRef.current.transferId === session.transferId) {
        const resumeFromChunk =
          typeof session.receiverChunks === 'number'
            ? session.receiverChunks
            : session.senderNextChunk;
        const currentChunk = sendStateRef.current.nextChunkIndex;
        const channelIsOpen = channelRef.current?.readyState === 'open';

        // Receiver checkpoints can arrive behind the sender during normal flow.
        // Only rewind to one when the channel is unavailable and we are recovering.
        if (resumeFromChunk > currentChunk || !channelIsOpen) {
          sendStateRef.current.nextChunkIndex = resumeFromChunk;
        }
        sendStateRef.current.totalChunks = session.totalChunks || sendStateRef.current.totalChunks;
        sendStateRef.current.sha256 = session.sha256 || sendStateRef.current.sha256;
        sendStateRef.current.started = Boolean(selectedFileRef.current) && resumableStatuses.includes(session.status);
        if (session.status === 'paused') {
          setIsPaused(true);
          isPausedRef.current = true;
        }
      }
    };

    const handleSocketConnect = () => {
      if (joinedRef.current) {
        socket.emit('join-room', { roomId, token, clientId: clientIdRef.current });
      }
    };

    socket.on('room-joined', handleRoomJoined);
    socket.on('peer-joined', handlePeerJoined);
    socket.on('webrtc-offer', handleOffer);
    socket.on('webrtc-answer', handleAnswer);
    socket.on('webrtc-ice-candidate', handleIceCandidate);
    socket.on('transfer-state', handleTransferState);
    socket.on('connect', handleSocketConnect);
    socket.on('room-error', handleRoomError);

    socket.emit('join-room', { roomId, token, clientId: clientIdRef.current });
    joinedRef.current = true;

    return () => {
      socket.off('room-joined', handleRoomJoined);
      socket.off('peer-joined', handlePeerJoined);
      socket.off('webrtc-offer', handleOffer);
      socket.off('webrtc-answer', handleAnswer);
      socket.off('webrtc-ice-candidate', handleIceCandidate);
      socket.off('transfer-state', handleTransferState);
      socket.off('connect', handleSocketConnect);
      socket.off('room-error', handleRoomError);

      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }

      channelRef.current = null;
      pendingCandidatesRef.current = [];
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      resetIncomingTransfer();
      joinedRef.current = false;
      socket.emit('leave-room', { roomId });
    };
  }, [roomId, token]);

  return (
    <main className="room-shell">
      <section className="room-header">
        <div className="room-header-copy">
          <p className="eyebrow">Transfer room</p>
          <h1>Room {roomId}</h1>
          <p className="hero-text">
            {isCreator
              ? 'Share the invite link, wait for the receiver, then send files directly over the browser-to-browser channel.'
              : 'Keep this room open while the sender transfers the file. Completed files appear here with integrity verification.'}
          </p>
        </div>

        <div className="room-status-card">
          <span className="room-status-label">Connection</span>
          <strong>{status}</strong>
          <p>Role: {role || 'pending'}</p>
          {transferMessage ? <span className="room-status-note">{transferMessage}</span> : null}
        </div>
      </section>

      <section className="room-grid">
        {isCreator ? (
          <article className="transfer-card">
            <p className="section-label">Sender</p>
            <h2>Send files from this room</h2>
            <p className="section-copy">
              Choose a file and send it over the live WebRTC data channel in binary chunks.
            </p>
            <div className="drop-zone">
              <input type="file" onChange={handleFileSelect} />
              <strong>{selectedFile ? selectedFile.name : 'Drop or choose a file'}</strong>
              <span>
                {selectedFile
                  ? `${selectedFile.size.toLocaleString()} bytes`
                  : 'The sender will send this file directly to the receiver without passing bytes through the server.'}
              </span>
            </div>
            <div className="transfer-actions">
              <button
                type="button"
                className="transfer-button"
                onClick={handleSendFile}
                disabled={!selectedFile || !isChannelOpen || isSending || sendStateRef.current.started}
              >
                {isSending && !isPaused
                  ? 'Sending...'
                  : sendStateRef.current.started && isPaused
                    ? 'Continue Sending'
                    : 'Send File'}
              </button>
              <button
                type="button"
                className="transfer-button transfer-button-secondary"
                onClick={handlePauseTransfer}
                disabled={!sendStateRef.current.started || isPaused}
              >
                Pause
              </button>
              <button
                type="button"
                className="transfer-button transfer-button-secondary"
                onClick={handleResumeTransfer}
                disabled={!sendStateRef.current.started || !isPaused}
              >
                Resume
              </button>
              <span>{isChannelOpen ? 'Data channel ready' : 'Waiting for WebRTC connection'}</span>
            </div>
            <div className="progress-panel">
              <span>Outgoing progress</span>
              <strong>{outgoingProgress}%</strong>
              <div className="progress-bar">
                <div style={{ width: `${outgoingProgress}%` }} />
              </div>
            </div>
          </article>
        ) : null}

        {isJoiner ? (
          <article className="transfer-card">
            <p className="section-label">Receiver</p>
            <h2>Receiving view</h2>
            <p className="section-copy">
              Stay here while chunks arrive. When the file completes, a download button will appear.
            </p>
            <div className="receiver-state">
              <strong>{incomingFile ? incomingFile.name : isChannelOpen ? 'Ready to receive' : 'Waiting for sender'}</strong>
              <span>
                {incomingFile
                  ? `${receiveProgress}% received`
                  : isChannelOpen
                    ? 'The direct channel is ready.'
                    : 'Waiting for the sender to establish the direct channel.'}
              </span>
            </div>
            <div className="progress-panel">
              <span>Incoming progress</span>
              <strong>{receiveProgress}%</strong>
              <div className="progress-bar">
                <div style={{ width: `${receiveProgress}%` }} />
              </div>
            </div>
            {downloadFile ? (
              <div className="download-card">
                <strong>{downloadFile.name}</strong>
                <span>{downloadFile.size.toLocaleString()} bytes</span>
                <button type="button" className="download-button" onClick={handleDownloadFile}>
                  Save File
                </button>
                {integrityStatus ? <span>{integrityStatus}</span> : null}
              </div>
            ) : null}
          </article>
        ) : null}

        <article className="transfer-card">
          <p className="section-label">Session</p>
          <h2>Room details</h2>
          <p className="section-copy">
            {isCreator
              ? 'Invite the receiver and track the room state from here.'
              : 'Keep an eye on the room status while the sender transfers the file.'}
          </p>
          <div className="room-meta-list">
            <div>
              <span>Invite</span>
              <strong>{inviteLink ? 'Generated' : 'Shared through room link'}</strong>
            </div>
            <div>
              <span>Channel</span>
              <strong>{isChannelOpen ? 'Open' : 'Pending'}</strong>
            </div>
            <div>
              <span>Role</span>
              <strong>{role || 'Waiting'}</strong>
            </div>
          </div>
          <div className="receiver-state">
            <strong>{transferMessage || 'Room is ready for transfer.'}</strong>
            <span>
              {isCreator
                ? 'Creator side is active and can send once a file is selected.'
                : 'Receiver side is active and will only download the incoming file.'}
            </span>
          </div>
          {isCreator && inviteLink ? (
            <div className="invite-box invite-box-room">
              <p>Invite link</p>
              <span>{inviteLink}</span>
              <button type="button" className="join-submit invite-copy" onClick={copyInviteLink}>
                Copy Invite Link
              </button>
            </div>
          ) : null}
        </article>
      </section>

      <section className="activity-panel">
        <div className="activity-head">
          <p className="section-label">Live activity</p>
          <h2>Room updates</h2>
        </div>
        <div className="activity-list">
          {activity.map((item, index) => (
            <div key={`${item}-${index}`}>{item}</div>
          ))}
        </div>
      </section>
    </main>
  );
}
