package com.hoonartis.glassvideo;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.util.Range;
import android.util.Size;
import android.view.Surface;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 안경 카메라 전송 시험. 서버 신호 {"cmd":"cam", mode, fps, sec, ...} 로 시작하고 sec초 뒤 저절로 멈춘다(0이면 끌 때까지).
 *  - photo: 카메라를 열어 둔 채 초당 fps장, 화면 가운데(crop 비율)를 잘라 JPEG로 /frame 에 한 장씩 POST.
 *           보내기가 밀리면(전송 2줄 + 대기 2장 초과) 그 장은 버리고 수를 센다.
 *  - video: 하드웨어 인코더(H.264) 출력을 약 0.25초씩 잘라 /stream 에 차례로 POST(서버 ffmpeg가 이어 붙여 풂).
 *           한 줄로 길게 올리면 Cloudflare 터널이 끝까지 모았다가 넘겨서(11-04 실측) 조각으로 나눈다.
 * 배터리 %, 배터리 온도(0.1°C), 시스템 발열 단계(0~6)를 함께 보내 "얼마나 버티는지"를 잰다.
 */
final class CameraStreamer {
    interface Out { void report(String m); void status(String m); }

    private final Context ctx;
    private final java.util.function.Supplier<String> server; // 서버 주소는 바뀔 수 있어(server.txt) 매번 읽는다
    private final String id;
    private final Out out;
    private HandlerThread thread;
    private Handler bg;
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader reader;
    private ThreadPoolExecutor upload;
    private MediaCodec encoder;
    private Thread pump;

    private volatile String mode = "photo";
    private volatile int fps, sec, kbps = 2000;
    private volatile float crop = 0.5f;
    private volatile int quality = 80;
    private volatile long test; // 서버가 정한 시험 번호
    private long nextShot;
    private final AtomicInteger shot = new AtomicInteger(), sent = new AtomicInteger(), dropped = new AtomicInteger(), failed = new AtomicInteger();
    private final AtomicLong captured = new AtomicLong(), bytes = new AtomicLong();
    private volatile int battery = -1, temp = -1, thermal = -1;
    private volatile int zmax = -1, head = -1; // 칩 구역 최고 온도(0.1°C), 발열 여유(0~100%, 100이면 크게 느려짐)
    private volatile String zname = "";
    private long startedAt, lastInfo;

    CameraStreamer(Context ctx, java.util.function.Supplier<String> server, String id, Out out) {
        this.ctx = ctx; this.server = server; this.id = id; this.out = out;
    }

    synchronized void start(String mode, int fps, int sec, float crop, int quality, int kbps, long test) {
        stop(false);
        this.mode = mode; this.fps = fps; this.sec = sec; this.crop = crop; this.quality = quality; this.kbps = kbps; this.test = test;
        shot.set(0); sent.set(0); dropped.set(0); failed.set(0); captured.set(0); bytes.set(0);
        thread = new HandlerThread("cam");
        thread.start();
        bg = new Handler(thread.getLooper());
        upload = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(2),
                (r, ex) -> dropped.incrementAndGet());
        readInfo();
        bg.post(() -> open(0));
    }

    synchronized void stop(boolean say) {
        int was = fps;
        fps = 0;
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        try { if (device != null) device.close(); } catch (Exception ignored) { }
        try { if (reader != null) reader.close(); } catch (Exception ignored) { }
        session = null; device = null; reader = null;
        MediaCodec enc = encoder;
        encoder = null;
        if (enc != null) try { enc.signalEndOfInputStream(); } catch (Exception ignored) { } // 펌프가 마저 보내고 닫는다
        if (upload != null) upload.shutdown();
        if (thread != null) thread.quitSafely();
        upload = null; thread = null;
        if (say && was > 0) {
            long s = Math.max(1, (System.currentTimeMillis() - startedAt) / 1000);
            out.report("카메라 끔 · " + mode + " " + was + "장/초, " + s + "초 · 보냄 " + sent.get() + " · 버림 " + dropped.get() + " · 실패 " + failed.get());
            out.status("신호 대기");
        }
    }

    private void open(int attempt) {
        CameraManager cm = ctx.getSystemService(CameraManager.class);
        try {
            String camId = null;
            for (String c : cm.getCameraIdList()) {
                Integer face = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (camId == null || (face != null && face == CameraMetadata.LENS_FACING_BACK)) camId = c;
            }
            if (camId == null) { out.report("카메라 없음"); return; }
            CameraCharacteristics ch = cm.getCameraCharacteristics(camId);
            StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Range<Integer>[] ranges = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            Range<Integer> range = pickRange(ranges, fps);
            Surface target;
            String desc;
            if (mode.equals("video")) {
                Size size = pick(map.getOutputSizes(SurfaceTexture.class), 1280, 16.0 / 9);
                target = startEncoder(size);
                desc = "동영상 " + size + " " + kbps + "kbps";
            } else {
                Size size = pick(map.getOutputSizes(ImageFormat.YUV_420_888), Math.round(640 / crop), 4.0 / 3);
                reader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 3);
                reader.setOnImageAvailableListener(this::onImage, bg);
                target = reader.getSurface();
                desc = "사진 원본 " + size + " 가운데 " + Math.round(crop * 100) + "% 화질 " + quality;
            }
            if (attempt == 0) out.report("카메라 " + camId + " 속도범위 " + Arrays.toString(ranges) + " → " + range + " · " + desc);
            if (attempt == 0) out.report("온도 구역 " + zoneList());
            final Range<Integer> fr = range;
            final Surface tg = target;
            cm.openCamera(camId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) { device = d; session(d, tg, fr); }
                @Override public void onDisconnected(CameraDevice d) { d.close(); device = null; out.report("카메라 끊김(다른 앱이 가져감?)"); }
                @Override public void onError(CameraDevice d, int e) {
                    d.close(); device = null;
                    out.report("카메라 열기 오류 " + e + " · 시도 " + (attempt + 1));
                    retry(attempt);
                }
            }, bg);
        } catch (SecurityException e) {
            out.report("카메라 권한 없음: adb shell pm grant com.hoonartis.glassvideo android.permission.CAMERA");
            out.status("카메라 권한 없음");
        } catch (Exception e) {
            out.report("카메라 열기 실패 " + e);
            retry(attempt);
        }
    }

    private void retry(int attempt) { // 로키드 시스템이 카메라를 잡고 있으면 잠깐 뒤 다시
        Handler h = bg;
        if (attempt < 3 && fps > 0 && h != null) h.postDelayed(() -> open(attempt + 1), 1500L * (attempt + 1));
    }

    private void session(CameraDevice d, Surface target, Range<Integer> range) {
        try {
            d.createCaptureSession(Arrays.asList(target), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) {
                    session = s;
                    try {
                        CaptureRequest.Builder b = d.createCaptureRequest(mode.equals("video") ? CameraDevice.TEMPLATE_RECORD : CameraDevice.TEMPLATE_PREVIEW);
                        b.addTarget(target);
                        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
                        if (range != null) b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, range);
                        s.setRepeatingRequest(b.build(), null, bg);
                        startedAt = System.currentTimeMillis();
                        nextShot = startedAt;
                        out.report("카메라 시작 · " + mode + " " + fps + "장/초 · " + (sec > 0 ? sec + "초" : "끌 때까지"));
                        if (sec > 0) bg.postDelayed(() -> stop(true), sec * 1000L);
                    } catch (Exception e) { out.report("카메라 요청 실패 " + e); }
                }
                @Override public void onConfigureFailed(CameraCaptureSession s) { out.report("카메라 세션 실패"); }
            }, bg);
        } catch (Exception e) { out.report("카메라 세션 예외 " + e); }
    }

    /** 원하는 가로폭·비율에 가장 가까운 크기. */
    private static Size pick(Size[] sizes, int want, double aspect) {
        Size best = sizes[0];
        double bestScore = 1e18;
        for (Size s : sizes) {
            double score = Math.abs(s.getWidth() - want) + Math.abs((double) s.getWidth() / s.getHeight() - aspect) * 400;
            if (score < bestScore) { bestScore = score; best = s; }
        }
        return best;
    }

    /** 원하는 속도를 넘는 범위 중 가장 낮은 것(쓸데없이 빨리 찍지 않게 → 발열·전력 줄임). */
    private static Range<Integer> pickRange(Range<Integer>[] ranges, int fps) {
        if (ranges == null) return null;
        Range<Integer> best = null;
        for (Range<Integer> r : ranges) {
            if (r.getUpper() < fps) continue;
            if (best == null || r.getUpper() < best.getUpper()
                    || (r.getUpper().equals(best.getUpper()) && r.getLower() < best.getLower())) best = r;
        }
        return best;
    }

    // ───── 사진 방식 ─────

    private void onImage(ImageReader r) {
        Image img;
        try { img = r.acquireLatestImage(); } catch (Exception e) { return; }
        if (img == null) return;
        try {
            captured.incrementAndGet();
            long now = System.currentTimeMillis();
            int f = fps;
            if (f <= 0 || now < nextShot) return;
            long gap = 1000L / f;
            nextShot = now - nextShot > 2 * gap ? now + gap : nextShot + gap; // 밀리면 다시 맞춤
            int w = img.getWidth(), h = img.getHeight();
            int cw = Math.round(w * crop) & ~1, ch = Math.round(h * crop) & ~1;
            int x0 = ((w - cw) / 2) & ~1, y0 = ((h - ch) / 2) & ~1;
            byte[] nv21 = cropNv21(img, x0, y0, cw, ch); // 카메라 버퍼는 곧 돌려줘야 해서 여기서 복사
            int n = shot.incrementAndGet();
            ThreadPoolExecutor u = upload;
            if (u != null) u.execute(() -> send(nv21, cw, ch, now, n));
        } catch (Exception e) {
            failed.incrementAndGet();
        } finally {
            img.close();
        }
        info();
    }

    /** YUV_420_888 의 가운데 영역만 NV21(Y + VU 섞임)로 옮긴다. */
    private static byte[] cropNv21(Image img, int x0, int y0, int cw, int ch) {
        byte[] out = new byte[cw * ch * 3 / 2];
        Image.Plane[] p = img.getPlanes();
        ByteBuffer y = p[0].getBuffer();
        int yRow = p[0].getRowStride();
        int pos = 0;
        for (int r = 0; r < ch; r++) {
            y.position((y0 + r) * yRow + x0);
            y.get(out, pos, cw);
            pos += cw;
        }
        ByteBuffer u = p[1].getBuffer(), v = p[2].getBuffer();
        int row = p[1].getRowStride(), pix = p[1].getPixelStride();
        for (int r = 0; r < ch / 2; r++) {
            int base = (y0 / 2 + r) * row + (x0 / 2) * pix;
            for (int c = 0; c < cw / 2; c++) {
                int i = base + c * pix;
                out[pos++] = v.get(i);
                out[pos++] = u.get(i);
            }
        }
        return out;
    }

    private String query(String path) {
        return server.get() + path + "?id=" + id + "&test=" + test + "&mode=" + mode + "&fps=" + fps
                + "&bat=" + battery + "&temp=" + temp + "&th=" + thermal + "&zmax=" + zmax + "&head=" + head + "&zname=" + zname
                + "&sent=" + sent.get() + "&drop=" + dropped.get() + "&fail=" + failed.get() + "&cap=" + captured.get();
    }

    private void send(byte[] nv21, int w, int h, long t, int n) {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(64 * 1024);
            new YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(new Rect(0, 0, w, h), quality, bos);
            byte[] jpg = bos.toByteArray();
            HttpURLConnection c = (HttpURLConnection) new URL(query("/frame") + "&n=" + n + "&t=" + t + "&w=" + w + "&h=" + h + "&q=" + quality).openConnection();
            c.setDoOutput(true);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "image/jpeg");
            c.setFixedLengthStreamingMode(jpg.length);
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            try (OutputStream o = c.getOutputStream()) { o.write(jpg); }
            int code = c.getResponseCode();
            c.getInputStream().close();
            if (code == 200) { sent.incrementAndGet(); bytes.addAndGet(jpg.length); } else failed.incrementAndGet();
        } catch (Exception e) {
            failed.incrementAndGet();
        }
    }

    // ───── 동영상 방식 ─────

    private Surface startEncoder(Size size) throws Exception {
        int w = size.getWidth() & ~15, h = size.getHeight() & ~15;
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, kbps * 1000);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, Math.max(1, fps));
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        MediaCodec enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        enc.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        Surface in = enc.createInputSurface();
        enc.start();
        encoder = enc;
        String url = query("/stream") + "&w=" + w + "&h=" + h + "&kbps=" + kbps;
        pump = new Thread(() -> pump(enc, url), "pump");
        pump.start();
        return in;
    }

    /** 인코더 출력(H.264 Annex-B)을 0.25초씩 모아 조각 POST 로 차례로 보낸다. 끝나면 인코더를 닫는다. */
    private void pump(MediaCodec enc, String url) {
        ThreadPoolExecutor sender = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(40),
                (r, ex) -> dropped.incrementAndGet()); // 한 줄로 보내 순서 유지, 너무 밀리면 버림(다음 키프레임부터 다시 풀림)
        ByteArrayOutputStream seg = new ByteArrayOutputStream(256 * 1024);
        int segNo = 0;
        long segAt = System.currentTimeMillis(), deadline = Long.MAX_VALUE;
        try {
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            byte[] buf = new byte[256 * 1024];
            while (System.currentTimeMillis() < deadline) {
                if (encoder != enc && deadline == Long.MAX_VALUE) deadline = System.currentTimeMillis() + 2000; // 멈춤 요청 뒤 2초 안에 마무리
                int i = enc.dequeueOutputBuffer(info, 20000);
                if (i >= 0) {
                    if (info.size > 0) {
                        ByteBuffer b = enc.getOutputBuffer(i);
                        b.position(info.offset);
                        b.limit(info.offset + info.size);
                        if (buf.length < info.size) buf = new byte[info.size * 2];
                        b.get(buf, 0, info.size);
                        seg.write(buf, 0, info.size);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) { sent.incrementAndGet(); captured.incrementAndGet(); }
                    }
                    enc.releaseOutputBuffer(i, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                }
                long now = System.currentTimeMillis();
                if (seg.size() > 0 && now - segAt >= 250) {
                    byte[] part = seg.toByteArray();
                    seg.reset();
                    int k = segNo++;
                    sender.execute(() -> post(url + "&seg=" + k, part));
                    segAt = now;
                }
                info();
            }
        } catch (Exception e) {
            failed.incrementAndGet();
            out.report("동영상 인코더 오류 " + e);
        } finally {
            byte[] last = seg.toByteArray();
            int k = segNo;
            sender.execute(() -> post(url + "&seg=" + k + "&end=1", last));
            sender.shutdown();
            try { sender.awaitTermination(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            try { enc.stop(); } catch (Exception ignored) { }
            enc.release();
        }
    }

    private void post(String url, byte[] data) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setDoOutput(true);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "video/h264");
            c.setFixedLengthStreamingMode(data.length);
            c.setConnectTimeout(5000);
            c.setReadTimeout(10000);
            try (OutputStream o = c.getOutputStream()) { o.write(data); }
            if (c.getResponseCode() != 200) failed.incrementAndGet();
            c.getInputStream().close();
            bytes.addAndGet(data.length);
        } catch (Exception e) {
            failed.incrementAndGet();
        }
    }

    // ───── 배터리·발열 ─────

    private void readInfo() {
        Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b != null) {
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            battery = level < 0 ? -1 : level * 100 / Math.max(1, scale);
            temp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1); // 0.1°C 단위
        }
        PowerManager pm = ctx.getSystemService(PowerManager.class);
        if (pm != null) {
            thermal = pm.getCurrentThermalStatus();
            if (android.os.Build.VERSION.SDK_INT >= 30) { // 안드로이드 11+: 10초 뒤 발열 여유 예측(1.0 = 심하게 느려지는 선)
                float f = pm.getThermalHeadroom(10);
                head = Float.isNaN(f) ? -1 : Math.round(f * 100);
            }
        }
        readZones();
    }

    /** /sys/class/thermal 의 구역별 온도 중 가장 뜨거운 곳(카메라·칩 쪽 실제 열). 읽기가 막힌 기기도 있다. */
    private void readZones() {
        java.io.File[] zones = new java.io.File("/sys/class/thermal").listFiles((d, n) -> n.startsWith("thermal_zone"));
        if (zones == null) return;
        int best = -1;
        String name = "";
        for (java.io.File z : zones) {
            try {
                String raw = read(new java.io.File(z, "temp"));
                if (raw == null) continue;
                long v = Long.parseLong(raw.trim());
                int tenth = (int) (v > 1000 ? v / 100 : v * 10); // 밀리°C 또는 °C 를 0.1°C 로
                if (tenth < 0 || tenth > 1500) continue;          // 센서 없음·이상값 제외
                if (tenth > best) { best = tenth; name = read(new java.io.File(z, "type")); }
            } catch (Exception ignored) { }
        }
        zmax = best;
        zname = name == null ? "" : name.trim().replaceAll("[^A-Za-z0-9_\\-]", "");
    }

    private static String read(java.io.File f) {
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(f))) { return r.readLine(); }
        catch (Exception e) { return null; }
    }

    /** 처음 한 번: 읽히는 온도 구역 목록을 서버 기록에 남긴다(어느 구역이 카메라·칩인지 보려고). */
    private String zoneList() {
        StringBuilder b = new StringBuilder();
        java.io.File[] zones = new java.io.File("/sys/class/thermal").listFiles((d, n) -> n.startsWith("thermal_zone"));
        if (zones == null) return "온도 구역 읽기 불가";
        for (java.io.File z : zones) {
            String t = read(new java.io.File(z, "type")), v = read(new java.io.File(z, "temp"));
            if (v != null) b.append(t).append('=').append(v.trim()).append(' ');
        }
        return b.length() == 0 ? "온도 구역 읽기 막힘" : b.toString();
    }

    /** 2초마다 배터리·온도·발열 단계를 다시 읽고 안경 화면에 상태를 띄운다. */
    private void info() {
        long now = System.currentTimeMillis();
        if (now - lastInfo < 2000) return;
        lastInfo = now;
        readInfo();
        String tele = query("/tele");
        new Thread(() -> { // 배터리·발열 기록(두 방식 공통)
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(tele).openConnection();
                c.setConnectTimeout(3000);
                c.getResponseCode();
                c.disconnect();
            } catch (Exception ignored) { }
        }).start();
        long s = (now - startedAt) / 1000;
        out.status("카메라 " + (mode.equals("video") ? "동영상 " : "") + fps + "장/초 · " + s / 60 + ":" + String.format("%02d", s % 60)
                + " · 보냄 " + sent.get() + " · " + battery + "% " + (temp / 10.0) + "°C");
    }
}
