import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

export default function JoinRoom() {
  const { roomId } = useParams();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [manualRoomId, setManualRoomId] = useState(roomId || '');
  const [token, setToken] = useState(searchParams.get('token') || '');
  const [error, setError] = useState('');

  useEffect(() => {
    const tokenFromLink = searchParams.get('token');
    if (tokenFromLink) {
      setToken(tokenFromLink);
    }
  }, [searchParams]);

  useEffect(() => {
    if (roomId && token) {
      navigate(`/room/${roomId}?token=${encodeURIComponent(token)}`, {  
        replace: true,
        state: location.state,
      });
    }
  }, [roomId, token, navigate, location.state]);

  const handleJoin = async (event) => {
    event.preventDefault();
    setError('');

    const targetRoomId = roomId || manualRoomId.trim();
    const targetToken = token.trim();

    if (!targetRoomId || !targetToken) {
      setError('Room ID and token are required.');
      return;
    }

    navigate(`/room/${targetRoomId}?token=${encodeURIComponent(targetToken)}`, {
      state: location.state,
    });
  };

  return (
    <main className="join-shell">
      <section className="join-panel">
        <div className="join-copy">
          <p className="eyebrow">Receiver setup</p>
          <h1>Join a secure transfer room.</h1>
          <p className="hero-text">
            Open the invite link from the sender, or paste the room details manually if you received them another way. Once the room is validated, the browser connection is ready for file exchange.
          </p>
          <div className="join-notes">
            <div>
              <strong>Step 1</strong>
              <span>Open the invite link or enter the room ID and token.</span>
            </div>
            <div>
              <strong>Step 2</strong>
              <span>We validate the room and confirm the sender is waiting.</span>
            </div>
            <div>
              <strong>Step 3</strong>
              <span>You’ll land in the transfer room for direct file sharing.</span>
            </div>
          </div>
        </div>

        <div className="join-card">
          <p className="section-label">Join room</p>
          <h2>Enter invite details</h2>
          <p className="section-copy">
            The room ID and token come from the invite link. If you opened the link, the fields will be prefilled.
          </p>
          {location.state?.inviteLink ? (
            <div className="invite-box">
              <p>Invite link</p>
              <span>{location.state.inviteLink}</span>
            </div>
          ) : null}

          <form className="join-form" onSubmit={handleJoin}>
            <div className="field-group">
              <label>Room ID</label>
              <input
                value={roomId || manualRoomId}
                onChange={(e) => setManualRoomId(e.target.value)}
                placeholder="Room ID from invite link"
                readOnly={Boolean(roomId)}
              />
            </div>
            <div className="field-group">
              <label>Token</label>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste token after ?token="
              />
            </div>
            {error ? <p className="form-error">{error}</p> : null}
            <button type="submit" className="join-submit">
              Join Room
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
