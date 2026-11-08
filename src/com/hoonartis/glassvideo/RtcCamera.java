package com.hoonartis.glassvideo;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.SystemClock;
import java.net.URI;
import java.util.Collections;
import java.util.function.Consumer;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;
import org.webrtc.*;

/** Owns one Camera2 capture and one browser peer during a WebRTC test. */
final class RtcCamera {
    private final Context context;
    private final Consumer<String> report;
    private final HandlerThread thread = new HandlerThread("rtc-camera");
    private final Handler handler;
    private final String url;
    private final int fps, kbps;
    private volatile boolean stopped;
    private volatile long lastFrame;
    private volatile boolean connected;
    private int cameraRetries;
    private EglBase egl;
    private SurfaceTextureHelper texture;
    private PeerConnectionFactory factory;
    private CameraVideoCapturer capturer;
    private VideoSource source;
    private VideoTrack track;
    private PeerConnection peer;
    private String answeredId;
    private WebSocketClient signal;

    RtcCamera(Context context, String server, long test, int fps, int kbps, int seconds, Consumer<String> report) {
        this.context = context.getApplicationContext();
        this.url = server.replaceFirst("^http", "ws") + "/cam/rtc?role=device&test=" + test;
        this.fps = fps;
        this.kbps = kbps;
        this.report = report;
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(() -> {
            if (stopped) return;
            try {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(this.context).createInitializationOptions());
                egl = EglBase.create();
                factory = PeerConnectionFactory.builder()
                        .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
                        .createPeerConnectionFactory();
                texture = SurfaceTextureHelper.create("rtc-capture", egl.getEglBaseContext());
                source = factory.createVideoSource(false);
                track = factory.createVideoTrack("glasses", source);
                openCamera();
                connect();
                handler.postDelayed(this::watchCapture, 2000);
            } catch (Exception | LinkageError e) {
                fail("WebRTC 시작 실패 · " + e);
            }
        });
        if (seconds > 0) handler.postDelayed(this::stop, seconds * 1000L);
    }

    private void openCamera() {
        Camera2Enumerator cameras = new Camera2Enumerator(context);
        for (String id : cameras.getDeviceNames()) {
            if (capturer == null || cameras.isBackFacing(id)) {
                if (capturer != null) capturer.dispose();
                capturer = cameras.createCapturer(id, null);
            }
        }
        if (capturer == null) throw new IllegalStateException("Camera2 camera unavailable");
        CapturerObserver observer = source.getCapturerObserver();
        capturer.initialize(texture, context, new CapturerObserver() {
            @Override public void onCapturerStarted(boolean success) { observer.onCapturerStarted(success); }
            @Override public void onCapturerStopped() { observer.onCapturerStopped(); }
            @Override public void onFrameCaptured(VideoFrame frame) {
                lastFrame = SystemClock.elapsedRealtime();
                // Match the existing glasses preview's fixed -90 degree sensor rotation.
                observer.onFrameCaptured(new VideoFrame(frame.getBuffer(), 270, frame.getTimestampNs()));
            }
        });
        lastFrame = SystemClock.elapsedRealtime();
        capturer.startCapture(1280, 720, fps);
    }

    private void watchCapture() {
        if (stopped) return;
        PowerManager power = context.getSystemService(PowerManager.class);
        if (power != null && power.getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE) {
            fail("WebRTC 발열 자동 중지");
            return;
        }
        if (SystemClock.elapsedRealtime() - lastFrame > 6500) {
            if (++cameraRetries > 3) { fail("WebRTC 카메라 프레임 수신 실패"); return; }
            report.accept("WebRTC 카메라 재시작 · " + cameraRetries);
            try {
                closeCamera();
                openCamera();
            } catch (RuntimeException e) {
                fail("WebRTC 카메라 재시작 실패 · " + e);
                return;
            }
        }
        handler.postDelayed(this::watchCapture, 2000);
    }

    private void connect() {
        if (stopped) return;
        signal = new WebSocketClient(URI.create(url), new Draft_6455(), Collections.emptyMap(), 5000) {
            @Override public void onOpen(ServerHandshake handshake) {}
            @Override public void onMessage(String text) {
                handler.post(() -> {
                    if (signal != this || stopped) return;
                    try {
                        JSONObject message = new JSONObject(text);
                        if ("offer".equals(message.optString("type"))) answer(message.getString("sdp"), message.getString("id"));
                        else if ("viewer-left".equals(message.optString("type"))) closePeer();
                    } catch (Exception e) { report.accept("WebRTC 연결 설정 실패 · " + e); }
                });
            }
            @Override public void onClose(int code, String reason, boolean remote) {
                handler.post(() -> {
                    if (signal != this || stopped) return;
                    signal = null;
                    closePeer();
                    if (code == 1008) stop();
                    else handler.postDelayed(RtcCamera.this::connect, 1500);
                });
            }
            @Override public void onError(Exception e) { report.accept("WebRTC 신호 연결 · " + e.getClass().getSimpleName()); }
        };
        signal.setConnectionLostTimeout(10);
        signal.connect();
    }

    private void answer(String sdp, String id) {
        closePeer();
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(Collections.emptyList());
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        PeerConnection[] owner = new PeerConnection[1];
        PeerConnection connection = factory.createPeerConnection(config, new PeerConnection.Observer() {
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) handler.post(() -> sendAnswer(owner[0], id));
            }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                handler.post(() -> {
                    if(peer==owner[0])connected=state==PeerConnection.IceConnectionState.CONNECTED||
                            state==PeerConnection.IceConnectionState.COMPLETED;
                });
            }
            @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
            @Override public void onIceConnectionReceivingChange(boolean receiving) {}
            @Override public void onIceCandidate(IceCandidate candidate) {}
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
            @Override public void onAddStream(MediaStream stream) {}
            @Override public void onRemoveStream(MediaStream stream) {}
            @Override public void onDataChannel(DataChannel channel) {}
            @Override public void onRenegotiationNeeded() {}
        });
        if (connection == null) throw new IllegalStateException("PeerConnection unavailable");
        peer = owner[0] = connection;
        connection.setRemoteDescription(new SdpStep(connection) {
            @Override void afterSet() {
                RtpSender sender = connection.addTrack(track, Collections.singletonList("camera"));
                RtpParameters parameters = sender.getParameters();
                for (RtpParameters.Encoding encoding : parameters.encodings) {
                    encoding.maxBitrateBps = kbps * 1000;
                    encoding.maxFramerate = fps;
                }
                sender.setParameters(parameters);
                connection.createAnswer(new SdpStep(connection) {
                    @Override void afterCreate(SessionDescription description) {
                        connection.setLocalDescription(new SdpStep(connection) {
                            @Override void afterSet() { sendAnswer(connection, id); }
                        }, description);
                    }
                }, new MediaConstraints());
            }
        }, new SessionDescription(SessionDescription.Type.OFFER, sdp));
    }

    private void sendAnswer(PeerConnection connection, String id) {
        if (stopped || peer == null || peer != connection || id.equals(answeredId) || signal == null || !signal.isOpen()
                || peer.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) return;
        SessionDescription description = peer.getLocalDescription();
        if (description == null) return;
        try {
            signal.send(new JSONObject().put("type", "answer").put("id", id).put("sdp", description.description).toString());
            answeredId = id;
        } catch (Exception e) { report.accept("WebRTC 응답 전송 실패 · " + e); }
    }

    private class SdpStep implements SdpObserver {
        private final PeerConnection connection;
        SdpStep(PeerConnection connection) { this.connection = connection; }
        void afterSet() {}
        void afterCreate(SessionDescription description) {}
        @Override public void onCreateSuccess(SessionDescription description) {
            handler.post(() -> { if (!stopped && peer == connection) afterCreate(description); });
        }
        @Override public void onSetSuccess() {
            handler.post(() -> { if (!stopped && peer == connection) afterSet(); });
        }
        @Override public void onCreateFailure(String error) { report.accept("WebRTC SDP · " + error); }
        @Override public void onSetFailure(String error) { report.accept("WebRTC SDP · " + error); }
    }

    private void closePeer() {
        connected=false;
        if (peer != null) { peer.dispose(); peer = null; }
        answeredId = null;
    }

    private void closeCamera() {
        if (capturer == null) return;
        try { capturer.stopCapture(); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        capturer.dispose();
        capturer = null;
    }

    private void fail(String message) {
        report.accept(message);
        if (signal != null && signal.isOpen()) {
            try { signal.send(new JSONObject().put("type", "error").put("message", message).toString()); }
            catch (Exception ignored) {}
        }
        stop();
    }

    synchronized void stop() {
        if (stopped) return;
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        handler.post(() -> {
            try {
                if (signal != null) signal.close();
                closePeer();
                closeCamera();
                if (track != null) track.dispose();
                if (source != null) source.dispose();
                if (texture != null) texture.dispose();
                if (factory != null) factory.dispose();
                if (egl != null) egl.release();
            } finally {
                thread.quitSafely();
            }
        });
    }

    void awaitStop() {
        try { thread.join(4000); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    String statusLine() {
        if(stopped)return "WebRTC 촬영 중지";
        if(connected&&SystemClock.elapsedRealtime()-lastFrame<2000)return "WebRTC 카메라 · 설정 "+fps+"fps";
        return "WebRTC 영상 연결 중";
    }
}
