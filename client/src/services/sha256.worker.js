import { createSha256 } from './fileTransfer.js';

const hashes = new Map();

self.onmessage = async ({ data }) => {
  if (data?.type === 'hash-start') {
    hashes.set(data.id, createSha256());
    return;
  }

  if (data?.type === 'hash-chunk') {
    const hash = hashes.get(data.id);
    if (!hash) return;
    hash.update(new Uint8Array(data.chunk));
    self.postMessage({ id: data.id, type: 'hash-chunk-processed' });
    return;
  }

  if (data?.type === 'hash-end') {
    const hash = hashes.get(data.id);
    if (!hash) return;
    hashes.delete(data.id);
    self.postMessage({ id: data.id, sha256: hash.digestHex() });
    return;
  }

  if (data?.type !== 'hash-file') return;

  try {
    const hash = createSha256();
    const reader = data.file.stream().getReader();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
    }

    self.postMessage({ id: data.id, sha256: hash.digestHex() });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : 'Unable to calculate SHA-256.',
    });
  }
};
