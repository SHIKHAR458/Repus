// Modern browsers reliably handle 256 KB+ SCTP messages via internal
// fragmentation.  Larger chunks reduce per-chunk overhead (IndexedDB writes,
// framing, ACKs) and dramatically improve throughput.
export const CHUNK_SIZE = 256 * 1024;
export const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024;
export const BUFFERED_AMOUNT_LOW_THRESHOLD = 4 * 1024 * 1024;
export const ACK_INTERVAL_BYTES = 2 * 1024 * 1024;
export const CHECKPOINT_INTERVAL_BYTES = 8 * 1024 * 1024;

export const TRANSFER_TYPES = {
  META: 'file-meta',
  END: 'file-end',
  ACK: 'file-ack',
};

const CHUNK_FRAME_MAGIC = 0x52505553;
const CHUNK_FRAME_VERSION = 1;
const CHUNK_FRAME_HEADER_SIZE = 28;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

class Sha256 {
  constructor() {
    this.h = new Uint32Array(SHA256_H0);
    this.buffer = new Uint8Array(64);
    this.words = new Uint32Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
  }

  update(data) {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    let offset = 0;
    this.bytesHashed += input.byteLength;

    while (offset < input.length) {
      const copyLength = Math.min(64 - this.bufferLength, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + copyLength), this.bufferLength);
      this.bufferLength += copyLength;
      offset += copyLength;

      if (this.bufferLength === 64) {
        this.processChunk(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  processChunk(chunk) {
    const w = this.words;

    for (let i = 0; i < 16; i += 1) {
      const offset = i * 4;
      w[i] =
        (chunk[offset] << 24) |
        (chunk[offset + 1] << 16) |
        (chunk[offset + 2] << 8) |
        chunk[offset + 3];
    }

    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.h;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  digestHex() {
    const bitLength = this.bytesHashed * 8;
    this.buffer[this.bufferLength++] = 0x80;

    if (this.bufferLength > 56) {
      while (this.bufferLength < 64) {
        this.buffer[this.bufferLength++] = 0;
      }
      this.processChunk(this.buffer);
      this.bufferLength = 0;
    }

    while (this.bufferLength < 56) {
      this.buffer[this.bufferLength++] = 0;
    }

    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.processChunk(this.buffer);

    return Array.from(this.h)
      .map((value) => value.toString(16).padStart(8, '0'))
      .join('');
  }
}

export const createSha256 = () => new Sha256();

const digestFileSha256OnMainThread = async (file) => {
  // Use hardware-accelerated crypto.subtle when available (5-20× faster
  // than the pure-JS fallback).  Falls back to the manual implementation
  // for browsers that lack SubtleCrypto (extremely rare).
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  const hash = createSha256();
  const stream = file.stream().getReader();

  while (true) {
    const { value, done } = await stream.read();
    if (done) break;
    hash.update(value);
  }

  return hash.digestHex();
};

export const digestFileSha256 = async (file) => {
  if (typeof Worker === 'undefined') {
    return digestFileSha256OnMainThread(file);
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sha256.worker.js', import.meta.url), { type: 'module' });
    const id = crypto.randomUUID();

    const cleanup = () => worker.terminate();

    worker.onmessage = ({ data }) => {
      if (data?.id !== id) return;
      cleanup();

      if (data.error) {
        reject(new Error(data.error));
        return;
      }

      resolve(data.sha256);
    };

    worker.onerror = () => {
      cleanup();
      reject(new Error('Unable to calculate SHA-256 in a background worker.'));
    };

    worker.postMessage({ type: 'hash-file', id, file });
  });
};

export const createControlMessage = (type, payload = {}) =>
  JSON.stringify({
    type,
    ...payload,
  });

export const parseControlMessage = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const transferIdToBytes = (transferId) => {
  const compactId = transferId.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compactId)) {
    throw new Error('Invalid transfer id.');
  }

  return Uint8Array.from(
    { length: 16 },
    (_, index) => Number.parseInt(compactId.slice(index * 2, index * 2 + 2), 16)
  );
};

const bytesToTransferId = (bytes) => {
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

export const createChunkFrame = ({ transferId, sequenceNumber, data }) => {
  const payload = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const frame = new Uint8Array(CHUNK_FRAME_HEADER_SIZE + payload.byteLength);
  const view = new DataView(frame.buffer);

  view.setUint32(0, CHUNK_FRAME_MAGIC, false);
  frame[4] = CHUNK_FRAME_VERSION;
  view.setUint32(8, sequenceNumber, false);
  frame.set(transferIdToBytes(transferId), 12);
  frame.set(payload, CHUNK_FRAME_HEADER_SIZE);

  return frame.buffer;
};

export const parseChunkFrame = (frame) => {
  if (!(frame instanceof ArrayBuffer) || frame.byteLength < CHUNK_FRAME_HEADER_SIZE) {
    return null;
  }

  const view = new DataView(frame);
  if (view.getUint32(0, false) !== CHUNK_FRAME_MAGIC || new Uint8Array(frame)[4] !== CHUNK_FRAME_VERSION) {
    return null;
  }

  return {
    transferId: bytesToTransferId(new Uint8Array(frame, 12, 16)),
    sequenceNumber: view.getUint32(8, false),
    data: frame.slice(CHUNK_FRAME_HEADER_SIZE),
  };
};

export const waitForBufferedAmount = async (
  channel,
  maxBufferedAmount = MAX_BUFFERED_AMOUNT,
  shouldStop = () => false
) => {
  channel.bufferedAmountLowThreshold = Math.min(
    BUFFERED_AMOUNT_LOW_THRESHOLD,
    maxBufferedAmount / 2
  );

  while (channel.readyState === 'open' && channel.bufferedAmount > maxBufferedAmount) {
    if (shouldStop()) return;

    await new Promise((resolve) => {
      let fallbackTimer;

      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', handleLowBuffer);
        window.clearTimeout(fallbackTimer);
      };

      const handleLowBuffer = () => {
        cleanup();
        resolve();
      };

      channel.addEventListener('bufferedamountlow', handleLowBuffer, { once: true });
      fallbackTimer = window.setTimeout(() => {
        cleanup();
        resolve();
      }, 16);
    });
  }
};
