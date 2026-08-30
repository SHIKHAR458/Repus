export const createPeerConnection = ({
    onIceCandidate,
    onConnectionStateChange,
    onDataChannel,
}) => {
    const pc = new RTCPeerConnection({
        iceServers : [
            {urls : 'stun:stun.l.google.com:19302'}
        ],
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

    if(onDataChannel){
        pc.ondatachannel = (event) => {
            onDataChannel(event.channel);
        }
    }
    return pc;
}

export const setupDataChannel = (channel, handlers = {}) => {
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