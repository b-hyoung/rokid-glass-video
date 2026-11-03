package com.hoonartis.glassvideo;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.VideoView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 서버 신호를 기다렸다가 그 영상을 서버에서 받아 재생한다.
 * 서버 /next 가 {"cmd":"play","url":"/v/whale.mp4"} 를 주면 재생, {"cmd":"stop"} 이면 끔.
 * 서버 주소는 빌드 때 넣은 기본값, 또는 한 번 넘겨 주면 기억한다:
 *   adb shell am start -n com.hoonartis.glassvideo/.MainActivity -d https://xxx.trycloudflare.com
 * 터치패드 탭·확인 키로 멈춤/재생.
 */
public class MainActivity extends Activity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private VideoView video;
    private TextView status;
    private String server;
    private volatile boolean running;
    private volatile HttpURLConnection conn;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK); // 검정 = 안경에서 투명
        video = new VideoView(this);
        video.setVisibility(View.INVISIBLE);
        root.addView(video, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        status = new TextView(this);
        status.setTextColor(Color.GREEN);
        status.setTextSize(14);
        root.addView(status, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
        setContentView(root);

        SharedPreferences prefs = getSharedPreferences("glass", MODE_PRIVATE);
        Uri given = getIntent().getData();
        if (given != null) prefs.edit().putString("server", given.toString()).apply();
        server = trim(prefs.getString("server", getString(R.string.default_server)));
        video.setOnCompletionListener(mp -> hide());
    }

    private static String trim(String s) {
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    @Override
    protected void onStart() {
        super.onStart();
        running = true;
        new Thread(this::listen, "events").start();
    }

    @Override
    protected void onStop() {
        super.onStop();
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        video.stopPlayback();
    }

    /**
     * 서버에 "새 신호 있나"를 묻고, 서버는 신호가 생길 때까지(최대 25초) 답을 붙잡는다(롱 폴링).
     * 처음엔 after 없이 물어 지금 번호만 받아서, 켜자마자 옛 신호를 다시 틀지 않는다. 끊기면 3초 뒤 다시.
     */
    private void listen() {
        String id = android.provider.Settings.Secure.getString(getContentResolver(),
                android.provider.Settings.Secure.ANDROID_ID);
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
        ui.post(() -> {
            if (cmd.equals("play")) {
                String u = m.optString("url");
                if (u.startsWith("/")) u = server + u;
                boolean loop = m.optBoolean("loop");
                status.setText("");
                video.setVisibility(View.VISIBLE);
                video.setVideoURI(Uri.parse(u));
                video.setOnPreparedListener(mp -> { mp.setLooping(loop); video.start(); });
            } else if (cmd.equals("stop")) {
                hide();
            }
        });
    }

    /** 영상을 끄고 화면을 비운다(안경에서 투명). */
    private void hide() {
        video.stopPlayback();
        video.setVisibility(View.INVISIBLE);
    }

    private void say(String text) {
        ui.post(() -> {
            if (video.getVisibility() != View.VISIBLE) status.setText(text);
        });
    }

    private void toggle() {
        if (video.getVisibility() != View.VISIBLE) return;
        if (video.isPlaying()) video.pause(); else video.start();
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
