package com.hoonartis.glassvideo;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.VideoView;

/**
 * 안경에서 영상 하나를 반복 재생한다.
 * 주소 없이 켜면 앱에 넣어 둔 영상, 주소를 넘기면 그 영상을 튼다:
 *   adb shell am start -n com.hoonartis.glassvideo/.MainActivity -d https://.../video.mp4
 * 터치패드 탭이나 확인 키로 멈춤/재생.
 */
public class MainActivity extends Activity {
    private VideoView video;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK); // 검정 = 안경에서 투명
        video = new VideoView(this);
        root.addView(video, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        setContentView(root);

        Uri src = getIntent().getData();
        if (src == null) src = Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.video);
        video.setVideoURI(src);
        video.setOnPreparedListener(mp -> { mp.setLooping(true); video.start(); });
    }

    private void toggle() {
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

    @Override
    protected void onPause() {
        super.onPause();
        video.pause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        video.start();
    }
}
