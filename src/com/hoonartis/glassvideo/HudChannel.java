package com.hoonartis.glassvideo;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.WebSocketImpl;
import org.json.JSONObject;
import java.net.URI;
import java.util.function.Supplier;

/** Independent metadata connection. At most one unacknowledged packet; newest
 * draw replaces old state. Never waits on, captures, or encodes the video surface. */
final class HudChannel {
    private final Supplier<String> server;
    private volatile String latest="{\"mode\":\"idle\",\"objects\":[]}";
    private volatile long drawnAt;
    private volatile boolean running;
    private WebSocketClient socket;
    private Thread worker;
    private long generation;
    private String origin;
    private long sequence,waiting,waitAt,attemptAt;
    HudChannel(Supplier<String> server){this.server=server;}
    void drawn(JSONObject state){latest=state.toString();drawnAt=android.os.SystemClock.elapsedRealtime();}
    synchronized void start(){if(running)return;running=true;long ticket=++generation;worker=new Thread(()->loop(ticket),"hud-status");worker.start();}
    synchronized void stop(){running=false;generation++;if(worker!=null)worker.interrupt();close();}
    private synchronized void close(){WebSocketClient old=socket;socket=null;waiting=0;if(old!=null)old.closeConnection(1000,"HUD reconnect");}
    private synchronized void tick(){
        long now=android.os.SystemClock.elapsedRealtime();String address=server.get();
        if(socket!=null&&(!address.equals(origin)||(waiting!=0&&now-waitAt>2000)))close();
        if(socket==null){
            if(now-attemptAt<2000)return;attemptAt=now;origin=address;
            WebSocketClient client=new WebSocketClient(URI.create(address.replaceFirst("^http","ws")+"/recognition/device"),new org.java_websocket.drafts.Draft_6455(),java.util.Collections.emptyMap(),5000){
                @Override public void onOpen(ServerHandshake h){}
                @Override public void onMessage(String m){try{long ack=new JSONObject(m).optLong("ack");synchronized(HudChannel.this){if(socket==this&&ack==waiting)waiting=0;}}catch(Exception ignored){}}
                @Override public void onClose(int c,String r,boolean remote){synchronized(HudChannel.this){if(socket==this){socket=null;waiting=0;}}}
                @Override public void onError(Exception e){}
            };
            client.setConnectionLostTimeout(5);client.setTcpNoDelay(true);socket=client;client.connect();return;
        }
        if(!socket.isOpen()||waiting!=0)return;
        try{
            if(((WebSocketImpl)socket.getConnection()).outQueue.size()>0)return;
            JSONObject packet=new JSONObject(latest);
            if(now-drawnAt>1500){packet=new JSONObject("{\"mode\":\"idle\",\"objects\":[],\"visible\":false}");}
            else packet.put("visible",true);
            waiting=++sequence;waitAt=now;packet.put("seq",waiting);packet.put("app",BuildInfo.VERSION);
            socket.send(packet.toString());
        }catch(Exception ignored){close();}
    }
    private void loop(long ticket){while(true){synchronized(this){if(!running||generation!=ticket)return;tick();}try{Thread.sleep(250);}catch(InterruptedException ignored){Thread.currentThread().interrupt();return;}}}
}
