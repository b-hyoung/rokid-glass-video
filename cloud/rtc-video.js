// A single browser receives the glasses camera over WebRTC.
export class RtcVideo {
  constructor(test, onFrame, onStatus) {
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.test = test;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.onStatus('WebRTC · 안경 연결 대기');
    const url = new URL('/cam/rtc', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({role:'viewer',test:this.test});
    const socket = this.socket = new WebSocket(url);
    const openedAt = performance.now();
    socket.onmessage = async event => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ready') await this.offer(socket);
        if (message.type === 'answer' && this.id === message.id) {
          await this.peer?.setRemoteDescription({type:'answer',sdp:message.sdp});
        }
        if (message.type === 'error') {
          this.stop();
          this.onStatus(message.message);
        }
      } catch {
        if (this.socket === socket) this.retry();
      }
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      if (event.code === 1008) {
        this.stop();
        this.onStatus('WebRTC 세션 종료 · 촬영을 다시 시작하세요');
      } else this.retry();
    };
    this.watch = setInterval(() => {
      if (this.peer && document.visibilityState === 'visible' &&
          performance.now() - this.lastFrame > 10000) this.retry();
      else if (!this.peer && performance.now() - openedAt > 15000) {
        this.onStatus('WebRTC · 안경 앱의 연결 설정과 같은 Wi-Fi 연결을 확인하세요');
      }
    }, 2000);
  }

  async offer(socket) {
    this.closePeer();
    const peer = this.peer = new RTCPeerConnection();
    const id = this.id = crypto.randomUUID();
    this.lastFrame = performance.now();
    this.onStatus('WebRTC · 영상 연결 중');
    const transceiver = peer.addTransceiver('video',{direction:'recvonly'});
    const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
    if (codecs && transceiver.setCodecPreferences) {
      const isH264 = codec => codec.mimeType.toLowerCase() === 'video/h264';
      transceiver.setCodecPreferences([...codecs].sort((a,b) => Number(isH264(b)) - Number(isH264(a))));
    }
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === 'failed') this.retry();
      else if (peer.connectionState === 'disconnected') this.onStatus('WebRTC · 연결 복구 중');
    };
    peer.onicegatheringstatechange = () => this.sendOffer(socket,peer,id);
    peer.ontrack = ({track}) => {
      if (this.peer !== peer || track.kind !== 'video') return;
      this.video.srcObject = new MediaStream([track]);
      this.video.play().catch(() => {
        if (this.peer === peer) this.onStatus('WebRTC · 영상 재생 실패');
      });
      this.readFrame(peer);
    };
    const offer = await peer.createOffer();
    if (this.peer !== peer) return;
    await peer.setLocalDescription(offer);
    this.sendOffer(socket,peer,id);
  }

  sendOffer(socket,peer,id) {
    if (this.peer !== peer || this.socket !== socket || socket.readyState !== WebSocket.OPEN ||
        this.sentId === id || peer.iceGatheringState !== 'complete' || !peer.localDescription) return;
    socket.send(JSON.stringify({type:'offer',id,sdp:peer.localDescription.sdp}));
    this.sentId = id;
  }

  readFrame(peer) {
    this.frameRequest = this.video.requestVideoFrameCallback((now, metadata) => {
      if (this.peer !== peer) return;
      const resumed = !this.hasFrame || now - this.lastFrame > 1000;
      this.hasFrame = true;
      this.lastFrame = now;
      if (resumed) this.onStatus('WebRTC · 영상 수신 중');
      this.onFrame(this.video, metadata.captureTime ?? now);
      this.readFrame(peer);
    });
  }

  closePeer() {
    if (this.frameRequest !== undefined) this.video.cancelVideoFrameCallback(this.frameRequest);
    this.frameRequest = undefined;
    this.video.srcObject = null;
    this.peer?.close();
    this.peer = null;
    this.hasFrame = false;
  }

  disconnect() {
    clearInterval(this.watch);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.closePeer();
  }

  retry() {
    this.disconnect();
    this.onStatus('WebRTC · 다시 연결 중');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(),1500);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.disconnect();
  }
}
