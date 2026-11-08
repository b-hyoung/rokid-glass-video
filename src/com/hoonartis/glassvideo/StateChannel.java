package com.hoonartis.glassvideo;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;
import java.net.URI;
import java.util.function.Supplier;

/** Server recognition state subscription. Actual drawn HUD uses HudChannel. */
final class StateChannel {
    interface Receiver {void accept(JSONObject state,long transitMs);}
    private final Supplier<String> server;
    private final String id;
    private final Receiver receiver;
    private WebSocketClient socket;
    private volatile long lastAt;
    private long generation;
    private boolean running;
    private String origin;
    private Thread worker;
    StateChannel(Supplier<String> server,String id,Receiver receiver){this.server=server;this.id=id;this.receiver=receiver;}
    synchronized void start(){if(running)return;running=true;long ticket=++generation;worker=new Thread(()->loop(ticket),"recognition-events");worker.start();}
    synchronized void stop(){running=false;generation++;if(worker!=null)worker.interrupt();close();}
    private synchronized boolean current(long ticket){return running&&ticket==generation;}
    private synchronized void close(){WebSocketClient old=socket;socket=null;lastAt=0;if(old!=null)old.closeConnection(1000,"State reconnect");}
    boolean healthy(){return lastAt!=0&&android.os.SystemClock.elapsedRealtime()-lastAt<12000;}
    private void loop(long ticket){
        int failures=0;
        while(current(ticket)){
            final String address=server.get();
            final long[] ping={0},offset={0},bestRtt={Long.MAX_VALUE};
            final long openedAt=android.os.SystemClock.elapsedRealtime();
            WebSocketClient client=new WebSocketClient(URI.create(address.replaceFirst("^http","ws")+"/recognition/events?role=device&id="+id+"&app="+BuildInfo.VERSION),new org.java_websocket.drafts.Draft_6455(),java.util.Collections.emptyMap(),5000){
                @Override public void onOpen(ServerHandshake handshake){}
                @Override public void onMessage(String text){
                    synchronized(StateChannel.this){
                        if(!current(ticket)||socket!=this||!address.equals(server.get()))return;
                        try{
                            JSONObject message=new JSONObject(text);long now=android.os.SystemClock.elapsedRealtime();
                            if("pong".equals(message.optString("type"))&&message.optLong("pong")==ping[0]){
                                long rtt=now-ping[0];if(rtt<bestRtt[0]){bestRtt[0]=rtt;offset[0]=message.optLong("serverNow")-(ping[0]+now)/2;}
                            }
                            if("state".equals(message.optString("type"))){
                                JSONObject state=message.getJSONObject("recognition");lastAt=now;
                                long transit=bestRtt[0]==Long.MAX_VALUE?Math.min(2000,now-openedAt):Math.max(0,now+offset[0]-state.optLong("serverNow"))+bestRtt[0]/2;
                                receiver.accept(state,transit);
                                send(new JSONObject().put("type","ack").put("seq",message.getLong("seq")).toString());
                            }
                        }catch(Exception ignored){}
                    }
                }
                @Override public void onClose(int code,String reason,boolean remote){}
                @Override public void onError(Exception error){}
            };
            synchronized(this){if(!current(ticket))return;socket=client;origin=address;}
            client.setConnectionLostTimeout(10);client.setTcpNoDelay(true);client.connect();
            try{
                while(current(ticket)&&address.equals(server.get())&&!client.isClosed()){
                    long now=android.os.SystemClock.elapsedRealtime();
                    if(client.isOpen()&&now-ping[0]>=5000){ping[0]=now;client.send(new JSONObject().put("type","ping").put("ping",now).toString());}
                    if(now-openedAt>15000&&!healthy())break;
                    if(healthy())failures=0;
                    Thread.sleep(250);
                }
            }catch(InterruptedException ignored){Thread.currentThread().interrupt();return;}
             catch(Exception ignored){}
            finally{synchronized(this){if(socket==client)close();else client.closeConnection(1000,"Old state session");}}
            if(!current(ticket))return;
            long delay=Math.min(30000,1000L<<Math.min(5,failures++));
            try{Thread.sleep((long)(delay*(.9+Math.random()*.2)));}catch(InterruptedException ignored){Thread.currentThread().interrupt();return;}
        }
    }
}
