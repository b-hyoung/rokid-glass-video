package com.hoonartis.glassvideo;
public class DeviceAccessTest {
    static void check(boolean condition){if(!condition)throw new AssertionError();}
    public static void main(String[] args){
        DeviceAccess.configure("https://example.test:443","signed.token");
        check(DeviceAccess.headers("wss://example.test/recognition/events").containsKey("Authorization"));
        for(String url:new String[]{"http://example.test/status","https://other.test/status","https://example.test:444/status","file:///videos/a.mp4","https://user@example.test/status"})check(!DeviceAccess.headers(url).containsKey("Authorization"));
        check(DeviceAccess.server("http://192.168.0.14:8791/").equals("http://192.168.0.14:8791"));
        for(String url:new String[]{"http://host:0","http://host:99999","http://user:pass@host","https://host/path","https://host?key=x","file:///tmp"}){try{DeviceAccess.server(url);throw new AssertionError("invalid server accepted");}catch(IllegalArgumentException expected){}}
        String previous=DeviceAccess.cacheKey("https://example.test");DeviceAccess.configure("https://example.test","other.token");check(!previous.equals(DeviceAccess.cacheKey("https://example.test")));
        PlaybackGate gate=new PlaybackGate();check(gate.accept("old",20,true));gate.stop();gate.serverChanged();check(gate.accept("new-space",1,true));gate.acknowledged("old",100);check(gate.current("new-space"));
        System.out.println("Origin-bound credentials, cache isolation and workspace playback reset: PASS");
    }
}
