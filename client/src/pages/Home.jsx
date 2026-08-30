import React from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import heroArt from '../assets/image.png';
import { API_BASE_URL } from '../config.js';

export default function Home() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleCreateRoom = async () => {
    setLoading(true);
    try{
      const response = await fetch(`${API_BASE_URL}/api/rooms/create`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });
      const data = await response.json();

      if(data.success){
        navigate(`/join/${data.roomId}?token=${data.token}`, {
          state: { inviteLink: data.inviteLink },
        });
      }
      }catch (error){ 
            console.error('Error creating room :', error);
            alert('Failed to create room. Please try again.');
      } finally {
        setLoading(false);
      }
  }

  return (
    <main className="home-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="home-brand">Repus</p>
          <h1>End-to-end peer file transfer, made fast and direct.</h1>
          <p className="hero-text">
            Repus is built for secure browser-to-browser file sharing over WebRTC, with no file relay through the server and a clean invite-link flow for quick handoffs.
          </p>
          <div className="hero-metrics" aria-label="Product highlights">
            <div>
              <strong>Direct</strong>
              <span>WebRTC data channel</span>
            </div>
            <div>
              <strong>Private</strong>
              <span>Invite-only rooms</span>
            </div>
            <div>
              <strong>Verified</strong>
              <span>SHA-256 integrity check</span>
            </div>
          </div>
          <a className="scroll-hint" href="#room-actions">
            Scroll to create or join a room
          </a>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="hero-card">
            <img src={heroArt} alt="" />
          </div>
          <div className="hero-badge hero-badge-top">Direct P2P</div>
          <div className="hero-badge hero-badge-bottom">Invite-link rooms</div>
        </div>
      </section>

      <section className="room-panel" id="room-actions">
        <div className="room-panel-inner">
          <p className="section-label">Get started</p>
          <h2>Create a transfer room or join an existing session.</h2>
          <p className="section-copy">
            Use a secure invite link to begin a private transfer session. The creator generates the room, the receiver joins with the token, and the browser-to-browser file path is established after connection.
          </p>
          <div className="flow-strip" aria-label="Transfer flow">
            <div>
              <span>01</span>
              <strong>Create</strong>
              <p>Generate a secure room and invite link for a private transfer session.</p>
            </div>
            <div>
              <span>02</span>
              <strong>Share</strong>
              <p>Send the invite link to the other peer without exposing file data to the server.</p>
            </div>
            <div>
              <span>03</span>
              <strong>Connect</strong>
              <p>Both browsers establish a direct WebRTC channel ready for file exchange.</p>
            </div>
          </div>
          <div className="action-grid">
            <button
              onClick={handleCreateRoom}
              disabled={loading}
              className="action-card action-primary"
            >
              <span className="action-kicker">Sender</span>
              <span className="action-title">{loading ? 'Creating room...' : 'Create Transfer Room'}</span>
              <span className="action-desc">Generate a private invite link, wait for the receiver, then move into the file-sharing room.</span>
            </button>
            <button
              onClick={() => navigate('/join')}
              className="action-card action-secondary"
            >
              <span className="action-kicker">Receiver</span>
              <span className="action-title">Join Existing Room</span>
              <span className="action-desc">Paste the room details from the invite link and connect to the sender.</span>
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
