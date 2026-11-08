package com.hoonartis.glassvideo;

/** UI-thread playback policy, also used by the JVM regression tests. */
final class PlaybackGate {
    void serverChanged(){id="";busy=false;awaitingStop=false;barrier=-1;}
    private String id="";
    private boolean busy,awaitingStop;
    private long barrier=-1;
    boolean accept(String token,long seq,boolean automatic){
        if(automatic&&(busy||awaitingStop||seq<=barrier))return false;
        id=token;busy=true;awaitingStop=false;return true;
    }
    String id(){return id;}
    boolean busy(){return busy;}
    void stop(){busy=false;awaitingStop=true;}
    void acknowledged(String token,long seq){if(!busy&&id.equals(token)){barrier=Math.max(barrier,seq);awaitingStop=false;}}
    boolean current(String token){return busy&&id.equals(token);}
}
