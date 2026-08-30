# Repus

Repus is a peer-to-peer file transfer app built with React, Socket.IO, and WebRTC DataChannels. The server coordinates rooms, signaling, and transfer checkpoints, while file bytes move directly between browsers.

## Current Capabilities

- Invite-only transfer rooms
- Sender and receiver roles
- WebRTC DataChannel file transfer
- Chunked transfer with backpressure
- Sender-side pause and resume
- Reconnect-aware transfer checkpoints while the browser tabs stay open
- SHA-256 integrity verification after transfer

## Local Development

Install dependencies in both apps:

```bash
npm --prefix client install
npm --prefix server install
```

Start the API and signaling server:

```bash
npm run server:dev
```

Start the React client:

```bash
npm run client:dev
```

## Environment

Copy the example files before deploying:

- `client/.env.example` -> `client/.env`
- `server/.env.example` -> `server/.env`

For production, set:

- `VITE_API_BASE_URL` to the deployed server URL
- `VITE_SOCKET_URL` to the deployed Socket.IO URL
- `CLIENT_ORIGIN` to the deployed client URL
- `PUBLIC_CLIENT_URL` to the deployed client URL used in invite links

## Production Notes

This app is designed so the server does not relay file bytes. For large files and reconnect support beyond a live browser tab, the next major upgrade should persist received chunks and transfer metadata in IndexedDB.
