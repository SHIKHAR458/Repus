import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { socket } from '../socket.js';
import { createPeerConnection, setupDataChannel } from '../services/webrtc.js';
import { getClientId } from '../services/clientIdentity.js';
import {
  CHUNK_SIZE,
  TRANSFER_TYPES,
  createControlMessage,
  createSha256,
  digestFileSha256,
  parseControlMessage,
  waitForBufferedAmount,
} from '../services/fileTransfer.js';

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
  const incomingChunksRef = useRef([]);
  const incomingMetaRef = useRef(null);
  const incomingHashRef = useRef(null);
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
  });

  const isCreator = role === 'creator';
  const isJoiner = role === 'joiner';
  const isChannelOpen = channelRef.current?.readyState === 'open';
  const resumableStatuses = ['active', 'paused', 'receiving', 'interrupted'];
  const canResumeActiveTransfer = () =>
    roleRef.current === 'creator' &&
    Boolean(selectedFileRef.current) &&
    sendStateRef.current.started &&
    !isPausedRef.current;

  const pushActivity = (message) => {
    setActivity((items) => [message, ...items].slice(0, 8));
  };

  useEffect(() => {
    return () => {
      if (downloadFile?.url) {
        URL.revokeObjectURL(downloadFile.url);
      }
    };
  }, [downloadFile]);

  const handleRoomError = (error) => {
    const message = error?.message || 'Failed to join room';
    setStatus(message);
    pushActivity(message);
  };

  const resetIncomingTransfer = () => {
    incomingChunksRef.current = [];
    incomingMetaRef.current = null;
    incomingHashRef.current = null;
    setIncomingFile(null);
    setReceiveProgress(0);
    setIntegrityStatus('');
  };

  const emitTransferCheckpoint = (status = 'active') => {
    if (!roomId || !sendStateRef.current.transferId) return;

    socket.emit('transfer-checkpoint', {
      roomId,
      transferId: sendStateRef.current.transferId,
      role: roleRef.current,
      nextChunkIndex: sendStateRef.current.nextChunkIndex,
      totalChunks: sendStateRef.current.totalChunks,
      fileName: sendStateRef.current.file?.name || selectedFile?.name || '',
      fileSize: sendStateRef.current.file?.size || selectedFile?.size || 0,
      chunkSize: CHUNK_SIZE,
      sha256: sendStateRef.current.sha256,
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

  const finalizeIncomingFile = () => {
    const metadata = incomingMetaRef.current;
    if (!metadata) return;

    if (downloadFile?.url) {
      URL.revokeObjectURL(downloadFile.url);
    }

    const blob = new Blob(incomingChunksRef.current, {
      type: metadata.mimeType || 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const receivedHash = incomingHashRef.current?.digestHex() || '';
    const expectedHash = metadata.sha256 || '';
    const integrityOk = Boolean(expectedHash) && receivedHash === expectedHash;

    setDownloadFile({
      name: metadata.name,
      url,
      size: metadata.size,
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

  const handleDataMessage = async (message) => {
    const control = parseControlMessage(message);

    if (control?.type === TRANSFER_TYPES.META) {
      incomingChunksRef.current = [];
      incomingHashRef.current = createSha256();
      incomingMetaRef.current = {
        transferId: control.transferId || '',
        name: control.name,
        size: control.size,
        mimeType: control.mimeType,
        totalChunks: control.totalChunks,
        sha256: control.sha256,
        receivedBytes: 0,
        receivedChunks: 0,
      };
      setIncomingFile({
        name: control.name,
        size: control.size,
        mimeType: control.mimeType,
        totalChunks: control.totalChunks,
      });
      setDownloadFile(null);
      setReceiveProgress(0);
      setTransferMessage(`Incoming file: ${control.name}`);
      pushActivity(`Incoming file announced: ${control.name}`);
      return;
    }

    if (control?.type === TRANSFER_TYPES.END) {
      setReceiveProgress(100);
      finalizeIncomingFile();
      return;
    }

    if (typeof message === 'string') {
      pushActivity(`Message received: ${message}`);
      return;
    }

    const chunk =
      message instanceof ArrayBuffer ? message : await message.arrayBuffer?.();

    if (!chunk || !incomingMetaRef.current) {
      return;
    }

    incomingChunksRef.current.push(chunk);
    incomingHashRef.current?.update(new Uint8Array(chunk));
    incomingMetaRef.current.receivedBytes += chunk.byteLength;
    incomingMetaRef.current.receivedChunks += 1;

    const progress = Math.min(
      100,
      Math.round((incomingMetaRef.current.receivedBytes / incomingMetaRef.current.size) * 100)
    );

    setReceiveProgress(progress);
    if (incomingMetaRef.current?.transferId) {
      socket.emit('transfer-checkpoint', {
        roomId,
        transferId: incomingMetaRef.current.transferId,
        role: 'joiner',
        nextChunkIndex: incomingMetaRef.current.receivedChunks,
        totalChunks: incomingMetaRef.current.totalChunks,
        fileName: incomingMetaRef.current.name,
        fileSize: incomingMetaRef.current.size,
        chunkSize: CHUNK_SIZE,
        sha256: incomingMetaRef.current.sha256,
        status: 'receiving',
      });
    }
  };

  const attachChannelHandlers = (channel) => {
    channel.binaryType = 'arraybuffer';

    setupDataChannel(channel, {
      onOpen: () => {
        setStatus('Data channel open');
        pushActivity('Data channel open');
        if (canResumeActiveTransfer()) {
          setTransferMessage('Connection restored. Resuming transfer...');
          void handleSendFile();
        }
      },
      onMessage: (message) => {
        void handleDataMessage(message);
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

    const channel = pc.createDataChannel('file-channel');
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
    };

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

    setIsSending(true);
    setSendProgress(0);
    if (!sendState.started) {
      setTransferMessage(`Sending ${activeFile.name}...`);
      pushActivity(`Started transfer: ${activeFile.name}`);
    }

    try {
      if (!sendState.started) {
        sendState.transferId = crypto.randomUUID();
        sendState.file = activeFile;
        const sha256 = await digestFileSha256(activeFile);
        sendState.sha256 = sha256;
        sendState.totalChunks = totalChunks;
        sendState.nextChunkIndex = 0;
        sendState.started = true;
        channel.send(
          createControlMessage(TRANSFER_TYPES.META, {
            transferId: sendState.transferId,
            name: activeFile.name,
            size: activeFile.size,
            mimeType: activeFile.type,
            totalChunks,
            sha256,
            chunkSize: CHUNK_SIZE,
          })
        );
        emitTransferCheckpoint('active');
      }

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
        const chunk = await activeFile.slice(start, end).arrayBuffer();

        if (isPausedRef.current) {
          sendStateRef.current.nextChunkIndex = index;
          setTransferMessage(`Paused at ${index + 1} of ${totalChunks} chunks.`);
          pushActivity(`Transfer paused at chunk ${index + 1}`);
          break;
        }

        await waitForBufferedAmount(channel, CHUNK_SIZE * 2, () => isPausedRef.current);

        if (isPausedRef.current) {
          sendStateRef.current.nextChunkIndex = index;
          setTransferMessage(`Paused at ${index + 1} of ${totalChunks} chunks.`);
          pushActivity(`Transfer paused at chunk ${index + 1}`);
          break;
        }

        channel.send(chunk);

        const progress = Math.min(
          100,
          Math.round(((index + 1) / totalChunks) * 100)
        );
        setSendProgress(progress);
        sendStateRef.current.nextChunkIndex = index + 1;
        emitTransferCheckpoint(isPausedRef.current ? 'paused' : 'active');
      }

      if (!isPausedRef.current && sendStateRef.current.nextChunkIndex >= totalChunks) {
        channel.send(
          createControlMessage(TRANSFER_TYPES.END, {
            transferId: sendStateRef.current.transferId,
            name: activeFile.name,
            totalChunks,
          })
        );

        setTransferMessage(`Finished sending ${activeFile.name}`);
        pushActivity(`SHA-256: ${sendStateRef.current.sha256.slice(0, 12)}...`);
        pushActivity(`Finished transfer: ${activeFile.name}`);
        sendStateRef.current.started = false;
        emitTransferCheckpoint('completed');
      } else if (isPausedRef.current) {
        setTransferMessage(`Paused at ${sendStateRef.current.nextChunkIndex} of ${totalChunks} chunks.`);
      }
    } catch (error) {
      console.error('Failed to send file:', error);
      if (channelRef.current?.readyState !== 'open') {
        setTransferMessage('Connection lost. Transfer will resume when the peer reconnects.');
        pushActivity('Transfer interrupted by connection loss');
        emitTransferCheckpoint('interrupted');
      } else {
        setTransferMessage('File transfer failed.');
        pushActivity('File transfer failed');
        sendStateRef.current.started = false;
        emitTransferCheckpoint('error');
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
    emitTransferCheckpoint('paused');
  };

  const handleResumeTransfer = async () => {
    if (!isCreator || !selectedFile || !sendStateRef.current.started || !isPaused) {
      return;
    }

    isPausedRef.current = false;
    setIsPaused(false);
    pushActivity('Sender resumed transfer');
    emitTransferCheckpoint('active');
    await handleSendFile();
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
        sendStateRef.current.nextChunkIndex = resumeFromChunk || sendStateRef.current.nextChunkIndex;
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
        <article className="transfer-card">
          <p className="section-label">Sender</p>
          <h2>{isCreator ? 'Send files from this room' : 'Sender controls locked'}</h2>
          <p className="section-copy">
            {isCreator
              ? 'Choose a file and send it over the live WebRTC data channel in binary chunks.'
              : 'Only the creator can select and send files. This room is receive-only for you.'}
          </p>
          {isCreator ? (
            <>
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
                  disabled={!selectedFile || !isChannelOpen || isSending || (sendStateRef.current.started && !isPaused)}
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
                  disabled={!sendStateRef.current.started || isPaused || !isCreator}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="transfer-button transfer-button-secondary"
                  onClick={handleResumeTransfer}
                  disabled={!sendStateRef.current.started || !isPaused || !isCreator}
                >
                  Resume
                </button>
                <span>{isChannelOpen ? 'Data channel ready' : 'Waiting for WebRTC connection'}</span>
              </div>
              <div className="progress-panel">
                <span>Outgoing progress</span>
                <strong>{sendProgress}%</strong>
                <div className="progress-bar">
                  <div style={{ width: `${sendProgress}%` }} />
                </div>
              </div>
            </>
          ) : (
            <div className="receiver-state sender-lock">
              <strong>Receive-only session</strong>
              <span>The receiver cannot pick or send files. Once the creator starts transfer, your download view will activate here.</span>
            </div>
          )}
        </article>

        <article className="transfer-card">
          <p className="section-label">Receiver</p>
          <h2>{isJoiner ? 'Receiving view' : 'Receiver view'}</h2>
          <p className="section-copy">
            {isJoiner
              ? 'Stay here while chunks arrive. When the file completes, a download button will appear.'
              : 'Track the receiver side of the transfer, including incoming progress and final integrity status.'}
          </p>
          <div className="receiver-state">
            <strong>{incomingFile ? incomingFile.name : isChannelOpen ? 'Ready to receive' : 'Waiting for sender'}</strong>
            <span>
              {incomingFile
                ? `${receiveProgress}% received`
                : isChannelOpen
                  ? 'The direct channel is ready.'
                  : isCreator
                    ? 'Share the invite link so the receiver can join.'
                    : 'Waiting for the sender to establish the direct channel.'}
            </span>
          </div>
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
              <span>Session</span>
              <strong>{role || 'Waiting'}</strong>
            </div>
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
              <a className="download-button" href={downloadFile.url} download={downloadFile.name}>
                Download File
              </a>
              {integrityStatus ? <span>{integrityStatus}</span> : null}
            </div>
          ) : null}
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
