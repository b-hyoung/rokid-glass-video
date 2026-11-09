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
 * 서버 주소는 빌드 시 고정한다. 기기 연결 승인과 촬영·인식 설정은 웹에서 제어한다.
 * 터치패드 탭·확인 키로 영상 종료. 안 만져도 신호가 오면 저절로 튼다.
 * {"cmd":"cam",...} 이면 카메라 전송 시험(CameraStreamer). 카메라 권한이 없으면 처음 켤 때 묻는다.
 *
 * VideoView(SurfaceView) 대신 TextureView 를 쓴다: 첫 버전은 안경에서 영상을 받아 갔는데도 화면에 안 보였다(11-03).
 */
public class MainActivity extends Activity implements TextureView.SurfaceTextureListener {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextureView view;
    private TextView status;
    private MediaPlayer player;
    private Surface surface;
    private volatile String server;
    private String id;
    private SharedPreferences prefs;
    private String pending; // 화면 준비 전에 온 영상 주소
    private boolean pendingLoop;
    private volatile boolean running;
    private final SessionWorkers workers=new SessionWorkers();
    private final java.util.concurrent.ArrayBlockingQueue<String> reports=new java.util.concurrent.ArrayBlockingQueue<>(20);
    private StateChannel stateChannel;
    private volatile HttpURLConnection conn;
    private CameraStreamer cam;
    private volatile RtcCamera rtcCamera;
    private final Object cameraOwnership=new Object();
    private String cameraStatus="",connectionStatus="연결 확인 중";
    private final Runnable deviceStatus=new Runnable(){
        @Override public void run(){
            if(!running)return;
            restoreDeviceStatus();
            ui.postDelayed(this,2000);
        }
    };
    private RecognitionOverlay recognitionOverlay;
    private LocalTracking localTracking;
    private HudChannel hudChannel;
    private final PlaybackGate playbackGate=new PlaybackGate();
    private String playbackToken="";
    private PlaybackReporter playbackReporter;
    private String playbackTitle="";
    private boolean renderedVideo;
    private double aimX=.5,aimY=.5;

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
        recognitionOverlay = new RecognitionOverlay(this);
        root.addView(recognitionOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        status = new TextView(this);
        status.setTextColor(Color.GREEN);
        status.setTextSize(16);
        status.setText("연결 중… (v"+BuildInfo.VERSION+")");
        status.setGravity(Gravity.CENTER);
        root.addView(status, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
        setContentView(root);

        prefs = getSharedPreferences("glass", MODE_PRIVATE);
        // The service origin is fixed at build time. No on-glasses setup flow.
        server=DeviceAccess.server(getString(R.string.default_server));
        DeviceAccess.configure(server,prefs.getString("token:"+server,""));
        id = android.provider.Settings.Secure.getString(getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
        playbackReporter=new PlaybackReporter(()->server,(origin,token,event)->playbackPost(origin,token,event).optLong("seq"),(origin,token,seq)->postSession(()->{if(origin.equals(server))playbackGate.acknowledged(token,seq);}));
        localTracking=new LocalTracking(()->recognitionOverlay.postInvalidateOnAnimation());
        hudChannel=new HudChannel(()->server);
        recognitionOverlay.attach(localTracking,hudChannel);
        cam = new CameraStreamer(this, () -> server, id, new CameraStreamer.Out() {
            @Override public void report(String m) { MainActivity.this.report(m); }
            @Override public void status(String m) {
                postSession(() -> {
                    cameraStatus="신호 대기".equals(m)?"":m;
                    restoreDeviceStatus();
                });
            }
        },localTracking);
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, 1);
    }

    private static String host(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return url; }
    }

    private static String why(Exception e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null ? "" : ": " + (m.length() > 60 ? m.substring(0, 60) : m));
    }

    @Override
    protected void onStart() {
        super.onStart();
        startConnections();
    }

    private void startConnections(){
        workers.begin();
        running = true;
        ui.post(deviceStatus);
        if(!DeviceAccess.hasCredential(server)&&!prefs.getBoolean("legacy:"+server,false)){
            connectionStatus="연결 확인 중";
            workers.start("enrollment",this::enrollmentLoop);return;
        }
        workers.start("next",this::listen);
        workers.start("sync",this::syncLoop);
        workers.start("recognition",this::recognitionLoop);
        workers.start("logs",this::logLoop);
        stateChannel=new StateChannel(()->server,id,this::applyRecognition);
        stateChannel.start();
        hudChannel.start();
        playbackReporter.start();
        report("앱 시작");
    }

    private void enrollmentLoop(){
        int failures=0;
        while(workers.active()){
            try{
                HttpURLConnection info=(HttpURLConnection)new URL(server+"/access/info").openConnection();
                if(!workers.track(info))return;
                info.setConnectTimeout(4000);info.setReadTimeout(4000);
                int code;String mode="";
                try{
                    code=info.getResponseCode();
                    if(code==200)try(BufferedReader in=new BufferedReader(new InputStreamReader(info.getInputStream(),StandardCharsets.UTF_8))){mode=new JSONObject(in.readLine()).optString("mode");}
                }finally{workers.release(info);}
                if(code==404){postSession(()->activateConnection("",true));return;}
                if(code!=200||!mode.equals("paired"))throw new java.io.IOException("Service unavailable");
                String key=prefs.getString("install:"+server,"");
                if(key.isEmpty()){
                    byte[] bytes=new byte[32];new java.security.SecureRandom().nextBytes(bytes);
                    key=android.util.Base64.encodeToString(bytes,android.util.Base64.URL_SAFE|android.util.Base64.NO_WRAP|android.util.Base64.NO_PADDING);
                    prefs.edit().putString("install:"+server,key).apply();
                }
                HttpURLConnection hello=(HttpURLConnection)new URL(server+"/access/hello").openConnection();
                if(!workers.track(hello))return;
                JSONObject result;
                try{
                    hello.setConnectTimeout(4000);hello.setReadTimeout(4000);hello.setRequestMethod("POST");hello.setDoOutput(true);hello.setRequestProperty("Content-Type","application/json");
                    byte[] body=new JSONObject().put("installKey",key).put("label",android.os.Build.MODEL+" · "+(id==null?"안경":id.substring(Math.max(0,id.length()-4)))).put("app",BuildInfo.VERSION).put("protocol",BuildInfo.PROTOCOL).toString().getBytes(StandardCharsets.UTF_8);
                    hello.setFixedLengthStreamingMode(body.length);try(java.io.OutputStream out=hello.getOutputStream()){out.write(body);}
                    try(BufferedReader in=new BufferedReader(new InputStreamReader(hello.getInputStream(),StandardCharsets.UTF_8))){result=new JSONObject(in.readLine());}
                }finally{workers.release(hello);}
                if(!workers.active())return;
                if(result.optString("state").equals("connected")){
                    if(result.optInt("protocol")!=BuildInfo.PROTOCOL||!"device".equals(result.optString("role")))throw new java.io.IOException("App protocol mismatch");
                    String token=result.getString("token");postSession(()->activateConnection(token,false));return;
                }
                say("웹에서 안경 연결을 선택하세요");failures=0;
                if(!workers.pause(3000))return;
            }catch(Exception e){say("자동 연결 중 · Wi-Fi·서버 상태 확인");if(!workers.pause(Math.min(30000,1000L<<Math.min(5,failures++))))return;}
        }
    }

    private void activateConnection(String token,boolean legacy){
        stopConnections();
        prefs.edit().putString("token:"+server,token).putBoolean("legacy:"+server,legacy).apply();
        DeviceAccess.configure(server,token);
        cached.clear();reports.clear();playbackGate.serverChanged();queuePlayback("","");
        localTracking.update(null,0);recognitionOverlay.update(null);connectionStatus="자동 연결 중";
        startConnections();
    }

    private void accessRejected(HttpURLConnection connection)throws java.io.IOException{
        int code=connection.getResponseCode();
        if((code==401||code==403)&&(DeviceAccess.hasCredential(server)||prefs.getBoolean("legacy:"+server,false))){
            postSession(()->activateConnection("",false));
            throw new java.io.IOException("Web approval required");
        }
    }

    private void postSession(Runnable action){
        long ticket=workers.ticket();
        ui.post(()->{if(workers.current(ticket))action.run();});
    }

    private void applyRecognition(JSONObject result,long transitMs){
        String origin=server;
        postSession(()->{
            if(!origin.equals(server))return;
            localTracking.update(result,transitMs);
            recognitionOverlay.update(result,transitMs);
            if(playbackGate.busy())publishVideoHud();
            JSONObject guide=result.optJSONObject("guide"),camera=guide==null?null:guide.optJSONObject("camera");
            boolean calibrated=guide!=null&&guide.optBoolean("calibrated");
            aimX=calibrated&&camera!=null?camera.optDouble("cx",.5):.5;
            aimY=calibrated&&camera!=null?camera.optDouble("cy",.5):.5;
        });
    }

    private void recognitionLoop() {
        int failures=0;
        while(workers.active()){
            long delay=2000;
            if(stateChannel==null||!stateChannel.healthy())try{
                long sent=android.os.SystemClock.elapsedRealtime();
                String origin=server;
                JSONObject result=new JSONObject(get(origin+"/recognition/status?hud=2&estimate=label&app="+BuildInfo.VERSION));
                if(!workers.active())return;
                if(!origin.equals(server))continue;
                applyRecognition(result,android.os.SystemClock.elapsedRealtime()-sent);failures=0;
            }catch(Exception e){delay=Math.min(30000,1000L<<Math.min(5,failures++));}
            if(!workers.pause((long)(delay*(.9+Math.random()*.2))))return;
        }
    }

    /** 서버 영상 파일 이름 → 안경에 받아 둔 파일. 신호가 오면 이걸 먼저 튼다(받는 시간 없음). */
    private final java.util.Map<String, java.io.File> cached = new java.util.concurrent.ConcurrentHashMap<>();

    /** 켤 때, 그 뒤 2분마다 서버 목록을 보고 없거나 바뀐 영상만 미리 받는다. */
    private void syncLoop() {
        while (workers.active()) {
            try { sync(); } catch (Exception e) { report("미리 받기 실패 " + e); }
            for (int i = 0; i < 120 && workers.active(); i++) try { Thread.sleep(1000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt();return; }
        }
    }

    private void sync() throws Exception {
        java.io.File dir = new java.io.File(getFilesDir(), "videos/"+DeviceAccess.cacheKey(server));
        dir.mkdirs();
        JSONObject list = new JSONObject(get(server + "/videos.json"));
        int fresh = 0;
        java.util.Iterator<String> keys = list.keys();
        java.util.Set<String> keep = new java.util.HashSet<>();
        while (keys.hasNext() && workers.active()) {
            JSONObject v = list.getJSONObject(keys.next());
            String file = v.getString("file");
            long size = v.optLong("size", -1);
            java.io.File local = new java.io.File(dir, v.optLong("ver") + "_" + file);
            keep.add(local.getName());
            if (!local.exists() || local.length() != size) {
                java.io.File part = new java.io.File(dir, local.getName() + ".part");
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/v/" + file).openConnection();
        DeviceAccess.apply(c);
                if(!workers.track(c))return;
                c.setConnectTimeout(10000);
                c.setReadTimeout(30000);
                try (java.io.InputStream in = c.getInputStream(); java.io.FileOutputStream out = new java.io.FileOutputStream(part)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while (workers.active()&&(n = in.read(buf)) > 0) out.write(buf, 0, n);
                }finally{workers.release(c);}
                if(!workers.active())return;
                if (part.length() != size || !part.renameTo(local)) { part.delete(); continue; }
                fresh++;
            }
            cached.put(file, local);
        }
        if(!workers.active())return;
        java.io.File[] old = dir.listFiles();
        if (old != null) for (java.io.File f : old) if (!keep.contains(f.getName())) f.delete(); // 서버에서 바뀌거나 빠진 영상
        if (fresh > 0) report("미리 받기 " + fresh + "개 새로, 총 " + cached.size() + "개 준비");
    }

    private String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        DeviceAccess.apply(c);
        if(!workers.track(c))throw new InterruptedException("Expired session");
        c.setConnectTimeout(10000);c.setReadTimeout(15000);
        StringBuilder body = new StringBuilder();
        try{
            accessRejected(c);
            try(BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))){
            String line;while(workers.active()&&(line=in.readLine())!=null)body.append(line).append('\n');
            if(!workers.active())throw new InterruptedException("Expired response");
            return body.toString();
            }
        }finally{workers.release(c);}
    }

    @Override
    protected void onStop() {
        super.onStop();
        stopConnections();
    }

    private void stopConnections(){
        endPlayback("stopped");
        running = false;
        if(playbackReporter!=null)playbackReporter.stop();
        workers.end();
        if(stateChannel!=null)stateChannel.stop();
        ui.removeCallbacks(deviceStatus);
        synchronized(cameraOwnership){cam.stop(true);}
        stopRtc(false);
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        hudChannel.stop();
    }

    /** Web commands reconnect to the same configured service origin. */
    private void listen() {
        long after = -1;
        long t0 = System.currentTimeMillis(); int tries = 0;
        boolean online = false;
        String listeningServer = null;
        while (workers.active()) {
            try {
                String currentServer = server;
                if (!currentServer.equals(listeningServer)) { listeningServer = currentServer; after = -1; }
                String q = currentServer + "/next?id=" + id + (after < 0 ? "" : "&after=" + after);
                HttpURLConnection c = (HttpURLConnection) new URL(q).openConnection();
        DeviceAccess.apply(c);
                if(!workers.track(c))return;
                conn = c;
                StringBuilder body = new StringBuilder();
                try{
                c.setConnectTimeout(10000);
                c.setReadTimeout(40000);
                accessRejected(c);
                try (BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = in.readLine()) != null) body.append(line);
                }
                }finally{workers.release(c);if(conn==c)conn=null;}
                JSONObject m = new JSONObject(body.toString());
                if(!workers.active())return;
                if (!online) { online = true; say("서버 연결됨"); report("연결됨 " + (System.currentTimeMillis() - t0) + "ms, 시도 " + (tries + 1) + "번"); }
                if (!currentServer.equals(server)) continue;
                if (after >= 0 && m.has("cmd")) handle(m);
                after = m.optLong("seq", after);
                continue;
            } catch (Exception e) {
                if (online) { t0 = System.currentTimeMillis(); tries = 0; }
                online = false;
                if (running) say("연결 끊김 · 다시 연결 중 (" + tries + ")\n" + host(server) + "\n" + why(e)); // 어디로 붙으려는지·왜 안 되는지 화면에
            }
            tries++;
            if (!workers.active())return;
            if(!workers.pause((long)(Math.min(30000,1000L<<Math.min(5,tries-1))*(.9+Math.random()*.2))))return;
        }
    }

    private void handle(JSONObject m) {
        if(!workers.active())return;
        String cmd = m.optString("cmd");
        if (cmd.equals("cam")) { // 카메라 전송 시험: fps 0 이면 끔
            int fps = m.optInt("fps");
            postSession(() -> {cameraStatus="";restoreDeviceStatus();});
            stopRtc(true);
            synchronized(cameraOwnership){
            if (!workers.active()) return;
            if (fps > 0 && "webrtc".equals(m.optString("transport"))) {
                cam.stop(false);
                rtcCamera = new RtcCamera(this, server, m.optLong("test"), fps,
                        m.optInt("kbps", 2000), m.optInt("sec"), this::report);
                return;
            }
            if (fps <= 0) cam.stop(true);
            else cam.start(m.optString("mode", "photo"), fps, m.optInt("sec", 5), (float) m.optDouble("crop", 0.5),
                    m.optInt("q", 80), m.optInt("kbps", 2000), m.optLong("test"), "websocket".equals(m.optString("transport")));
            }
            return;
        }
        String title = m.optString("title");
        String u = m.optString("url");
        java.io.File local = cached.get(u.substring(u.lastIndexOf('/') + 1));
        if (local != null && local.exists()) u = Uri.fromFile(local).toString(); // 받아 둔 파일이면 바로
        else if (u.startsWith("/")) u = server + u;                               // 아직이면 서버에서 받아 가며
        String url = u;
        boolean loop = m.optBoolean("loop");
        postSession(() -> {
            if(!running)return;
            if (cmd.equals("play")) {
                boolean automatic="recognition".equals(m.optString("source"));
                String token=m.optString("playbackId","legacy-"+m.optLong("seq"));
                if(automatic&&localTracking.available()&&!localTracking.centered(m.optString("targetId"),aimX,aimY)){
                    report("자동 재생 건너뜀 · 현재 안경 중앙에서 대상 확인 안 됨");
                    rejectPlayback(token);return;
                }
                if(!playbackGate.accept(token,m.optLong("seq"),automatic)){rejectPlayback(token);return;}
                hide();playbackTitle=title;playbackToken=token;queuePlayback(token,"loading");renderedVideo=false;
                recognitionOverlay.setVisibility(android.view.View.INVISIBLE);
                publishVideoHud();
                status.setText("불러오는 중 · " + title);
                report("신호 받음 " + title + (url.startsWith("file:") ? " (받아 둔 파일)" : " (서버에서 받는 중)"));
                if (surface == null) { pending = url; pendingLoop = loop; report("화면 아직 준비 안 됨, 기다림"); }
                else play(url, loop);
            } else if (cmd.equals("stop")) {
                endPlayback("stopped");
            }
        });
    }

    private void stopRtc(boolean wait) {
        RtcCamera previous;
        synchronized(cameraOwnership){previous=rtcCamera;rtcCamera=null;}
        if (previous != null) {
            previous.stop();
            if (wait) previous.awaitStop();
        }
    }

    private void play(String url, boolean loop) {
        release();
        final String token=playbackGate.id();
        MediaPlayer mp = new MediaPlayer();
        player = mp;
        try {
            mp.setDataSource(this, Uri.parse(url),DeviceAccess.headers(url));
            mp.setSurface(surface);
            mp.setLooping(loop);
            mp.setOnPreparedListener(p -> {
                if(player!=p||!playbackGate.current(token))return;
                fit(p.getVideoWidth(), p.getVideoHeight());
                view.setAlpha(1f);
                recognitionOverlay.setVisibility(android.view.View.INVISIBLE);
                status.setText("");
                p.start();
                queuePlayback(token,"playing");
                report("재생 시작 " + p.getVideoWidth() + "x" + p.getVideoHeight() + " 화면 " + view.getWidth() + "x" + view.getHeight());
            });
            mp.setOnInfoListener((p,what,extra)->{if(player==p&&what==MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START){renderedVideo=true;publishVideoHud();}return false;});
            mp.setOnCompletionListener(p -> { if(player==p&&playbackGate.current(token)){endPlayback("completed");report("재생 끝");} });
            mp.setOnErrorListener((p, what, extra) -> {
                if(player!=p||!playbackGate.current(token))return true;
                status.setText("재생 실패 " + what + "/" + extra);
                report("재생 실패 " + what + "/" + extra);
                endPlayback("error");
                return true;
            });
            mp.prepareAsync();
        } catch (Exception e) {
            status.setText("재생 실패 " + e.getClass().getSimpleName());
            report("재생 예외 " + e);
            endPlayback("error");
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
        pending=null;renderedVideo=false;
        recognitionOverlay.setVisibility(android.view.View.VISIBLE);
        release();
        view.setAlpha(0f);
    }

    private void say(String text) {
        postSession(() -> {connectionStatus=text;restoreDeviceStatus();});
    }

    private void restoreDeviceStatus() {
        if(!running||playbackGate.busy()||status==null)return;
        RtcCamera rtc=rtcCamera;
        if(rtc==null&&!cameraStatus.isEmpty()){status.setText(cameraStatus);return;}
        android.content.Intent battery=registerReceiver(null,new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
        String line=rtc==null?connectionStatus:rtc.statusLine();
        if(battery!=null){
            int level=battery.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL,-1);
            int scale=battery.getIntExtra(android.os.BatteryManager.EXTRA_SCALE,100);
            int temperature=battery.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE,-1);
            if(level>=0&&scale>0)line+=" · 배터리 "+Math.round(level*100f/scale)+"%";
            if(temperature>0)line+=String.format(java.util.Locale.ROOT," · %.1f°C",temperature/10f);
        }
        status.setText(line);
    }

    /** 상태를 서버 기록에 남긴다(진단용). */
    private void report(String msg) {
        if(!running)return;
        if(!reports.offer(msg)){reports.poll();reports.offer(msg);}
    }
    private void logLoop(){
        int failures=0;
        while(workers.active()){
            try{
                String message=reports.poll(1,java.util.concurrent.TimeUnit.SECONDS);
                if(message==null)continue;
                get(server+"/log?id="+id+"&m="+URLEncoder.encode(message,"UTF-8"));failures=0;
            }catch(InterruptedException ignored){Thread.currentThread().interrupt();return;}
             catch(Exception ignored){if(!workers.pause(Math.min(30000,1000L<<Math.min(5,failures++))))return;}
        }
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture t, int w, int h) {
        surface = new Surface(t);
        report("화면 준비 " + w + "x" + h);
        if (pending != null) { String u = pending; pending = null; play(u, pendingLoop); }
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture t, int w, int h) { }
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture t) { endPlayback("stopped");if(surface!=null)surface.release();surface = null;return true; }
    @Override public void onSurfaceTextureUpdated(SurfaceTexture t) {if(playbackGate.busy())publishVideoHud();}

    private void endPlayback(String event){
        hide();
        if(playbackGate.busy()){
            playbackGate.stop();queuePlayback(playbackToken,event);
            report("영상 종료 · "+event);
        }
        recognitionOverlay.invalidate();
        restoreDeviceStatus();
    }
    private void stopFromButton(){if(playbackGate.busy())endPlayback("stopped");}
    private void publishVideoHud(){
        if(hudChannel==null||!playbackGate.busy())return;
        try{JSONObject state=new JSONObject();state.put("mode",renderedVideo?"playback":"loading");state.put("width",view.getWidth());state.put("height",view.getHeight());state.put("objects",new org.json.JSONArray());state.put("title",playbackTitle);state.put("playbackId",playbackToken);hudChannel.drawn(state);}catch(Exception ignored){}
    }
    private JSONObject playbackPost(String origin,String token,String event)throws Exception{
        HttpURLConnection c=(HttpURLConnection)new URL(origin+"/recognition/playback").openConnection();
        DeviceAccess.apply(c);
        try{
            c.setConnectTimeout(3000);c.setReadTimeout(3000);c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");
            byte[] body=new JSONObject().put("id",token).put("event",event).toString().getBytes(StandardCharsets.UTF_8);c.setFixedLengthStreamingMode(body.length);
            try(java.io.OutputStream out=c.getOutputStream()){out.write(body);}
            try(BufferedReader in=new BufferedReader(new InputStreamReader(c.getInputStream(),StandardCharsets.UTF_8))){return new JSONObject(in.readLine());}
        }finally{c.disconnect();}
    }
    private void rejectPlayback(String token){
        // No media callback and no change to the video already playing.
        String origin=server;
        new Thread(()->{try{playbackPost(origin,token,"rejected");}catch(Exception ignored){}},"playback-rejected").start();
    }
    private void queuePlayback(String token,String event){if(playbackReporter!=null)playbackReporter.update(token,event);}

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_SPACE || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                || code == KeyEvent.KEYCODE_MEDIA_STOP || (code == KeyEvent.KEYCODE_BACK && playbackGate.busy())) {
            if(e.getRepeatCount()==0)stopFromButton();
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if(e.getAction()==MotionEvent.ACTION_DOWN&&playbackGate.busy())return true;
        if (e.getAction() == MotionEvent.ACTION_UP) { stopFromButton(); return true; }
        return super.onTouchEvent(e);
    }
}
