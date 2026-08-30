const DATABASE_NAME = 'repus-transfer-storage';
const DATABASE_VERSION = 1;
const TRANSFERS_STORE = 'transfers';
const CHUNKS_STORE = 'chunks';

let databasePromise;

const getDatabase = () => {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;

        if (!database.objectStoreNames.contains(TRANSFERS_STORE)) {
          database.createObjectStore(TRANSFERS_STORE, { keyPath: 'transferId' });
        }

        if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
          const chunks = database.createObjectStore(CHUNKS_STORE, { keyPath: ['transferId', 'sequenceNumber'] });
          chunks.createIndex('by-transfer', 'transferId', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open transfer storage.'));
    });
  }

  return databasePromise;
};

const completeRequest = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });

const completeTransaction = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  });

export const getStoredTransfer = async (transferId) => {
  const database = await getDatabase();
  const transaction = database.transaction(TRANSFERS_STORE, 'readonly');
  return completeRequest(transaction.objectStore(TRANSFERS_STORE).get(transferId));
};

export const saveTransferMetadata = async (metadata) => {
  const database = await getDatabase();
  const transaction = database.transaction(TRANSFERS_STORE, 'readwrite');
  transaction.objectStore(TRANSFERS_STORE).put({
    ...metadata,
    updatedAt: Date.now(),
  });
  await completeTransaction(transaction);
};

export const saveReceivedChunk = async ({ transferId, sequenceNumber, data, metadata }) => {
  const database = await getDatabase();
  const transaction = database.transaction([TRANSFERS_STORE, CHUNKS_STORE], 'readwrite');

  transaction.objectStore(CHUNKS_STORE).put({
    transferId,
    sequenceNumber,
    data,
  });
  transaction.objectStore(TRANSFERS_STORE).put({
    ...metadata,
    transferId,
    receivedThrough: sequenceNumber,
    receivedBytes: metadata.receivedBytes,
    updatedAt: Date.now(),
  });

  await completeTransaction(transaction);
};

export const readTransferChunks = async (transferId) => {
  const database = await getDatabase();
  const transaction = database.transaction(CHUNKS_STORE, 'readonly');
  const index = transaction.objectStore(CHUNKS_STORE).index('by-transfer');
  const chunks = await completeRequest(index.getAll(transferId));

  return chunks
    .sort((first, second) => first.sequenceNumber - second.sequenceNumber)
    .map((chunk) => chunk.data);
};

export const getStoredChunk = async (transferId, sequenceNumber) => {
  const database = await getDatabase();
  const transaction = database.transaction(CHUNKS_STORE, 'readonly');
  const chunk = await completeRequest(
    transaction.objectStore(CHUNKS_STORE).get([transferId, sequenceNumber])
  );

  return chunk?.data || null;
};

export const clearStoredTransfer = async (transferId) => {
  const database = await getDatabase();
  const transaction = database.transaction([TRANSFERS_STORE, CHUNKS_STORE], 'readwrite');
  const chunkStore = transaction.objectStore(CHUNKS_STORE);
  const index = chunkStore.index('by-transfer');

  const cursorRequest = index.openCursor(IDBKeyRange.only(transferId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };

  transaction.objectStore(TRANSFERS_STORE).delete(transferId);
  await completeTransaction(transaction);
};
