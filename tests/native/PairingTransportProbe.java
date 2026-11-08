package com.hoonartis.glassvideo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;

/** Real native HTTP and the same WebSocket library as the APK. Credentials
 * arrive on stdin, never command-line arguments or diagnostic output. */
public class PairingTransportProbe {
    public static void main(String[] args)throws Exception{
        BufferedReader input=new BufferedReader(new InputStreamReader(System.in));String origin=input.readLine(),token=input.readLine();DeviceAccess.configure(origin,token);
        HttpURLConnection c=(HttpURLConnection)new URL(origin+"/status").openConnection();DeviceAccess.apply(c);c.setConnectTimeout(5000);c.setReadTimeout(5000);try{if(c.getResponseCode()!=200)throw new AssertionError("Native HTTP authentication failed");}finally{c.disconnect();}
        CountDownLatch state=new CountDownLatch(1),pong=new CountDownLatch(1);URI uri=URI.create(origin.replaceFirst("^http","ws")+"/recognition/events?role=device&id=native-probe&app="+BuildInfo.VERSION);
        WebSocketClient socket=new WebSocketClient(uri,new Draft_6455(),DeviceAccess.headers(uri.toString()),5000){
            private boolean pingSent;
            public void onOpen(ServerHandshake handshake){}
            public void onMessage(String message){
                if(message.contains("\"type\":\"state\"")){Matcher match=Pattern.compile("\"seq\":(\\d+)").matcher(message);if(match.find())send("{\"type\":\"ack\",\"seq\":"+match.group(1)+"}");state.countDown();if(!pingSent){pingSent=true;send("{\"type\":\"ping\",\"ping\":71}");}}
                if(message.contains("\"type\":\"pong\"")&&message.contains("\"pong\":71"))pong.countDown();
            }
            public void onClose(int code,String reason,boolean remote){}
            public void onError(Exception error){}
        };
        try{if(!socket.connectBlocking(5,TimeUnit.SECONDS)||!state.await(5,TimeUnit.SECONDS)||!pong.await(5,TimeUnit.SECONDS))throw new AssertionError("Native authenticated state channel failed");System.out.println("Native paired HTTP and WebSocket state/ack/ping: PASS");}
        finally{socket.closeBlocking();}
    }
}
