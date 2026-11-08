package com.hoonartis.glassvideo;

import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** A credential belongs to one origin. Discovery and reconnects must never
 * forward it to another host, scheme, or port. */
final class DeviceAccess {
    private static final class Access {final String origin,token;Access(String origin,String token){this.origin=origin;this.token=token;}}
    private static volatile Access current=new Access("","");
    static String server(String value){
        try{URI u=new URI(value.trim());if(u.getRawQuery()!=null||u.getRawFragment()!=null||u.getUserInfo()!=null||u.getHost()==null||!(u.getScheme().equalsIgnoreCase("http")||u.getScheme().equalsIgnoreCase("https"))||!(u.getPath()==null||u.getPath().isEmpty()||u.getPath().equals("/")))throw new Exception();
            String result=origin(value);if(result.isEmpty())throw new Exception();return result;
        }catch(Exception e){throw new IllegalArgumentException("http 또는 https 서버 주소와 포트를 확인하세요.");}
    }
    private static String origin(String value){
        try{URI u=new URI(value);String scheme=u.getScheme().toLowerCase(Locale.ROOT).replace("wss","https").replace("ws","http");
            if(!scheme.equals("http")&&!scheme.equals("https")||u.getHost()==null||u.getUserInfo()!=null)return "";
            int port=u.getPort();if(port==0||port>65535)return "";
            boolean standard=port==-1||scheme.equals("https")&&port==443||scheme.equals("http")&&port==80;
            return scheme+"://"+u.getHost().toLowerCase(Locale.ROOT)+(standard?"":":"+port);
        }catch(Exception e){return "";}
    }
    static void configure(String server,String token){current=new Access(origin(server),token!=null&&token.matches("[A-Za-z0-9_.-]{1,2048}")?token:"");}
    static Map<String,String> headers(String url){
        Map<String,String> result=new HashMap<>();result.put("User-Agent","RokidGlassVideo/"+BuildInfo.VERSION);
        Access access=current;if(!access.token.isEmpty()&&!access.origin.isEmpty()&&access.origin.equals(origin(url)))result.put("Authorization","Bearer "+access.token);
        return result;
    }
    static void apply(HttpURLConnection connection){for(Map.Entry<String,String> entry:headers(connection.getURL().toString()).entrySet())connection.setRequestProperty(entry.getKey(),entry.getValue());}
    static String cacheKey(String server){
        try{Access access=current;byte[] hash=MessageDigest.getInstance("SHA-256").digest((origin(server)+"\n"+access.token).getBytes(StandardCharsets.UTF_8));StringBuilder result=new StringBuilder();for(int i=0;i<16;i++)result.append(String.format(Locale.ROOT,"%02x",hash[i]&255));return result.toString();}catch(Exception e){throw new IllegalStateException(e);}
    }
}
