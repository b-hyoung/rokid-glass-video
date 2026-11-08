package com.hoonartis.glassvideo;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.WebSocketImpl;
import org.json.JSONObject;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Sends the original encoder bytes without waiting for one HTTP response per 100ms chunk. */
final class LiveVideoSocket {
    private final Supplier<String> url;
    private final Consumer<String> report;
    private final long test;
    private final int fps;
    private WebSocketClient socket;
    private boolean ready, closed, waitingKey = true;
    private long attemptAt;
    private long keyAt;
    private final ArrayDeque<long[]> pending = new ArrayDeque<>();
    private final AtomicBoolean keyRequest = new AtomicBoolean();

    LiveVideoSocket(Supplier<String> url, long test, int fps, Consumer<String> report) {
        this.url = url; this.test = test; this.fps = fps; this.report = report;
    }
    void requestKey() { keyRequest.set(true); }
    boolean takeKeyRequest() { return keyRequest.getAndSet(false); }
    private static long now() { return System.nanoTime() / 1000000; }

    private void connect() {
        if (closed || socket != null || now() - attemptAt < 1000) return;
        attemptAt = now(); waitingKey = true; pending.clear();
        URI uri = URI.create(url.get().replaceFirst("^http", "ws"));
        WebSocketClient client = new WebSocketClient(uri, new Draft_6455(), DeviceAccess.headers(uri.toString()), 5000) {
            @Override public void onOpen(ServerHandshake handshake) {
                synchronized (LiveVideoSocket.this) {
                    if (closed || socket != this) { close(); return; }
                    ready = true; waitingKey = true; keyRequest.set(true);
                }
                report.accept("실시간 영상 연결 · H.264 " + fps + "fps");
            }
            @Override public void onMessage(String text) {
                try {
                    JSONObject m = new JSONObject(text);
                    synchronized (LiveVideoSocket.this) {
                        if (socket != this) return;
                        if (m.optBoolean("keyframe")) keyRequest.set(true);
                        if (m.has("ack")) { long ack = m.getLong("ack"); while (!pending.isEmpty() && pending.peekFirst()[0] <= ack) pending.removeFirst(); }
                    }
                } catch (Exception ignored) { }
            }
            @Override public void onClose(int code, String reason, boolean remote) {
                synchronized (LiveVideoSocket.this) { if (socket == this) { socket = null; ready = false; pending.clear(); } }
            }
            @Override public void onError(Exception e) { report.accept("실시간 연결 재시도 · " + e.getClass().getSimpleName() + ": " + e.getMessage()); }
        };
        client.setTcpNoDelay(true);
        client.setConnectionLostTimeout(10);
        socket = client;
        client.connect();
    }

    synchronized boolean send(byte[] data, int seg, boolean key) {
        connect();
        if (closed || !ready || socket == null) return false;
        // Bound the unsent queue, but keep TCP/TLS open: reconnecting during TCP
        // slow start would repeatedly restart the same congestion and never recover.
        WebSocketImpl connection = (WebSocketImpl) socket.getConnection();
        if (connection.outQueue.size() > 5 || pending.size() > 20) {
            waitingKey = true;
            if (!pending.isEmpty() && now() - pending.peekFirst()[1] > 10000) disconnect();
            return false;
        }
        if (waitingKey && !key) {
            if (now() - keyAt > 500) { keyAt = now(); keyRequest.set(true); }
            return false;
        }
        try {
            long sentAt = now();
            String header = "{\"test\":" + test + ",\"seg\":" + seg + ",\"fps\":" + fps + ",\"sentAt\":" + sentAt + "}";
            byte[] json = header.getBytes(StandardCharsets.UTF_8);
            ByteBuffer packet = ByteBuffer.allocate(4 + json.length + data.length);
            packet.putInt(json.length).put(json).put(data);
            socket.send(packet.array());
            pending.addLast(new long[]{seg, sentAt}); waitingKey = false;
            return true;
        } catch (Exception e) { disconnect(); return false; }
    }
    private void disconnect() {
        WebSocketClient old = socket; socket = null; ready = false; waitingKey = true; pending.clear();
        if (old != null) old.closeConnection(1000, "Resume from live keyframe");
    }
    synchronized void close() { closed = true; disconnect(); }
}
