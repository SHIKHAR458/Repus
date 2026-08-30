const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
];

if (import.meta.env.VITE_TURN_URL) {
    iceServers.push({
        urls: import.meta.env.VITE_TURN_URL,
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
}

export const createPeerConnection = ({
    onIceCandidate,
    onConnectionStateChange,
    onIceConnectionStateChange,
    onDataChannel,
}) => {
    const pc = new RTCPeerConnection({
        iceServers,
    });
    
    pc.onicecandidate = (event) => {
        if(event.candidate && onIceCandidate){
            onIceCandidate(event.candidate);
        }
    };

    pc.onconnectionstatechange = () => {
        if(onConnectionStateChange){
            onConnectionStateChange(pc.connectionState);
        }
    };

    pc.oniceconnectionstatechange = () => {
        if (onIceConnectionStateChange) {
            onIceConnectionStateChange(pc.iceConnectionState);
        }
    };

    if(onDataChannel){
        pc.ondatachannel = (event) => {
            onDataChannel(event.channel);
        };
    }
    return pc;
}

export const setupDataChannel = (channel, handlers = {}) => {
  channel.bufferedAmountLowThreshold = 1024 * 1024;

  channel.onopen = () => {
    handlers.onOpen?.();
  };

  channel.onmessage = (event) => {
    handlers.onMessage?.(event.data);
  };

  channel.onerror = (error) => {
    handlers.onError?.(error);
  };

  channel.onclose = () => {
    handlers.onClose?.();
  };
};
