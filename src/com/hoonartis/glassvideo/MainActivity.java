package com.hoonartis.glassvideo;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * 서버 신호를 기다렸다가 그 영상을 서버에서 받아 재생한다.
 * 서버 /next 가 {"cmd":"play","url":"/v/whale.mp4"} 를 주면 재생, {"cmd":"stop"} 이면 끔.
 * 재생 상태(불러오는 중·재생·실패)는 /log 로 서버에 알린다.
 * 서버 주소는 빌드 때 넣은 기본값, 또는 한 번 넘겨 주면 기억한다:
 *   adb shell am start -n com.hoonartis.glassvideo/.MainActivity -d https://xxx.trycloudflare.com
 * 터치패드 탭·확인 키로 멈춤/재생. 안 만져도 신호가 오면 저절로 튼다.
 *
 * VideoView(SurfaceView) 대신 TextureView 를 쓴다: 첫 버전은 안경에서 영상을 받아 갔는데도 화면에 안 보였다(11-03).
 */
public class MainActivity extends Activity implements TextureView.SurfaceTextureListener {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextureView view;
    private TextView status;
    private MediaPlayer player;
    private Surface surface;
    private String server, id;
    private String pending; // 화면 준비 전에 온 영상 주소
    private boolean pendingLoop;
    private volatile boolean running;
    private volatile HttpURLConnection conn;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK); // 검정 = 안경에서 투명
        view = new TextureView(this);
        view.setSurfaceTextureListener(this);
        view.setAlpha(0f);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        status = new TextView(this);
        status.setTextColor(Color.GREEN);
        status.setTextSize(16);
        root.addView(status, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
        setContentView(root);

        SharedPreferences prefs = getSharedPreferences("glass", MODE_PRIVATE);
        Uri given = getIntent().getData();
        if (given != null) prefs.edit().putString("server", given.toString()).apply();
        server = trim(prefs.getString("server", getString(R.string.default_server)));
        id = android.provider.Settings.Secure.getString(getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
    }

    private static String trim(String s) {
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    @Override
    protected void onStart() {
        super.onStart();
        running = true;
        new Thread(this::listen, "next").start();
        new Thread(this::syncLoop, "sync").start();
        report("앱 시작");
    }

    /** 서버 영상 파일 이름 → 안경에 받아 둔 파일. 신호가 오면 이걸 먼저 튼다(받는 시간 없음). */
    private final java.util.Map<String, java.io.File> cached = new java.util.concurrent.ConcurrentHashMap<>();

    /** 켤 때, 그 뒤 2분마다 서버 목록을 보고 없거나 바뀐 영상만 미리 받는다. */
    private void syncLoop() {
        while (running) {
            try { sync(); } catch (Exception e) { report("미리 받기 실패 " + e); }
            for (int i = 0; i < 120 && running; i++) try { Thread.sleep(1000); } catch (InterruptedException ignored) { }
        }
    }

    private void sync() throws Exception {
        java.io.File dir = new java.io.File(getFilesDir(), "videos");
        dir.mkdirs();
        JSONObject list = new JSONObject(get(server + "/videos.json"));
        int fresh = 0;
        java.util.Iterator<String> keys = list.keys();
        java.util.Set<String> keep = new java.util.HashSet<>();
        while (keys.hasNext() && running) {
            JSONObject v = list.getJSONObject(keys.next());
            String file = v.getString("file");
            long size = v.optLong("size", -1);
            java.io.File local = new java.io.File(dir, v.optLong("ver") + "_" + file);
            keep.add(local.getName());
            if (!local.exists() || local.length() != size) {
                java.io.File part = new java.io.File(dir, local.getName() + ".part");
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/v/" + file).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(30000);
                try (java.io.InputStream in = c.getInputStream(); java.io.FileOutputStream out = new java.io.FileOutputStream(part)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                if (part.length() != size || !part.renameTo(local)) { part.delete(); continue; }
                fresh++;
            }
            cached.put(file, local);
        }
        java.io.File[] old = dir.listFiles();
        if (old != null) for (java.io.File f : old) if (!keep.contains(f.getName())) f.delete(); // 서버에서 바뀌거나 빠진 영상
        if (fresh > 0) report("미리 받기 " + fresh + "개 새로, 총 " + cached.size() + "개 준비");
    }

    private static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        StringBuilder body = new StringBuilder();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) body.append(line);
        }
        return body.toString();
    }

    @Override
    protected void onStop() {
        super.onStop();
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        hide();
    }

    /**
     * 서버에 "새 신호 있나"를 묻고, 서버는 신호가 생길 때까지(최대 25초) 답을 붙잡는다(롱 폴링).
     * 처음엔 after 없이 물어 지금 번호만 받아서, 켜자마자 옛 신호를 다시 틀지 않는다. 끊기면 3초 뒤 다시.
     */
    private void listen() {
        long after = -1;
        boolean online = false;
        while (running) {
            try {
                String q = server + "/next?id=" + id + (after < 0 ? "" : "&after=" + after);
                HttpURLConnection c = (HttpURLConnection) new URL(q).openConnection();
                conn = c;
                c.setConnectTimeout(10000);
                c.setReadTimeout(40000);
                StringBuilder body = new StringBuilder();
                try (BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = in.readLine()) != null) body.append(line);
                }
                JSONObject m = new JSONObject(body.toString());
                if (!online) { online = true; say("연결됨 · 신호 대기"); }
                if (after >= 0 && m.has("cmd")) handle(m);
                after = m.optLong("seq", after);
                continue;
            } catch (Exception e) {
                online = false;
                if (running) say("연결 끊김 · 다시 연결 중");
            }
            if (running) try { Thread.sleep(3000); } catch (InterruptedException ignored) { }
        }
    }

    private void handle(JSONObject m) {
        String cmd = m.optString("cmd");
        String title = m.optString("title");
        String u = m.optString("url");
        java.io.File local = cached.get(u.substring(u.lastIndexOf('/') + 1));
        if (local != null && local.exists()) u = Uri.fromFile(local).toString(); // 받아 둔 파일이면 바로
        else if (u.startsWith("/")) u = server + u;                               // 아직이면 서버에서 받아 가며
        String url = u;
        boolean loop = m.optBoolean("loop");
        ui.post(() -> {
            if (cmd.equals("play")) {
                status.setText("불러오는 중 · " + title);
                report("신호 받음 " + title + (url.startsWith("file:") ? " (받아 둔 파일)" : " (서버에서 받는 중)"));
                if (surface == null) { pending = url; pendingLoop = loop; report("화면 아직 준비 안 됨, 기다림"); }
                else play(url, loop);
            } else if (cmd.equals("stop")) {
                hide();
                status.setText("신호 대기");
            }
        });
    }

    private void play(String url, boolean loop) {
        release();
        MediaPlayer mp = new MediaPlayer();
        player = mp;
        try {
            mp.setDataSource(this, Uri.parse(url));
            mp.setSurface(surface);
            mp.setLooping(loop);
            mp.setOnPreparedListener(p -> {
                fit(p.getVideoWidth(), p.getVideoHeight());
                view.setAlpha(1f);
                status.setText("");
                p.start();
                report("재생 시작 " + p.getVideoWidth() + "x" + p.getVideoHeight() + " 화면 " + view.getWidth() + "x" + view.getHeight());
            });
            mp.setOnCompletionListener(p -> { hide(); status.setText("신호 대기"); report("재생 끝"); });
            mp.setOnErrorListener((p, what, extra) -> {
                status.setText("재생 실패 " + what + "/" + extra);
                report("재생 실패 " + what + "/" + extra);
                hide();
                return true;
            });
            mp.prepareAsync();
        } catch (Exception e) {
            status.setText("재생 실패 " + e.getClass().getSimpleName());
            report("재생 예외 " + e);
        }
    }

    /** 영상 비율을 지키며 화면 안에 맞춘다. */
    private void fit(int vw, int vh) {
        int w = view.getWidth(), h = view.getHeight();
        if (vw <= 0 || vh <= 0 || w <= 0 || h <= 0) return;
        float s = Math.min((float) w / vw, (float) h / vh);
        android.graphics.Matrix m = new android.graphics.Matrix();
        m.setScale(vw * s / w, vh * s / h, w / 2f, h / 2f);
        view.setTransform(m);
    }

    private void release() {
        if (player != null) { player.release(); player = null; }
    }

    /** 영상을 끄고 화면을 비운다(안경에서 투명). */
    private void hide() {
        release();
        view.setAlpha(0f);
    }

    private void say(String text) {
        ui.post(() -> { if (player == null) status.setText(text); });
    }

    /** 상태를 서버 기록에 남긴다(진단용). */
    private void report(String msg) {
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/log?id=" + id + "&m="
                        + URLEncoder.encode(msg, "UTF-8")).openConnection();
                c.setConnectTimeout(5000);
                c.getResponseCode();
                c.disconnect();
            } catch (Exception ignored) { }
        }).start();
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture t, int w, int h) {
        surface = new Surface(t);
        report("화면 준비 " + w + "x" + h);
        if (pending != null) { String u = pending; pending = null; play(u, pendingLoop); }
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture t, int w, int h) { }
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture t) { hide(); surface = null; return true; }
    @Override public void onSurfaceTextureUpdated(SurfaceTexture t) { }

    private void toggle() {
        if (player == null) return;
        if (player.isPlaying()) player.pause(); else player.start();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_SPACE || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
            toggle();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (e.getAction() == MotionEvent.ACTION_UP) { toggle(); return true; }
        return super.onTouchEvent(e);
    }
}
