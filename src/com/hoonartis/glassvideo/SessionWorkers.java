package com.hoonartis.glassvideo;

import java.net.HttpURLConnection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** Every task and connection belongs to one Activity session. A quick restart
 * cannot make an old loop or queued UI callback current again. */
final class SessionWorkers {
    private long generation;
    private boolean running;
    private final ThreadLocal<Long> owner=new ThreadLocal<>();
    private final Map<String,Thread> threads=new HashMap<>();
    private final Set<HttpURLConnection> connections=new HashSet<>();
    synchronized long ticket(){Long value=owner.get();return value==null?generation:value;}
    synchronized boolean current(long ticket){return running&&generation==ticket;}
    boolean active(){return current(ticket())&&!Thread.currentThread().isInterrupted();}
    synchronized void begin(){end();generation++;running=true;}
    synchronized void end(){
        running=false;generation++;
        for(HttpURLConnection c:connections)try{c.disconnect();}catch(RuntimeException ignored){}connections.clear();
        for(Thread thread:threads.values())thread.interrupt();
    }
    synchronized void start(String role,Runnable task){
        if(!running)return;
        final long ticket=generation;
        final Thread previous=threads.get(role);
        Thread thread=new Thread(()->{
            owner.set(ticket);
            try{
                if(previous!=null&&previous!=Thread.currentThread())previous.join(5000);
                if(active())task.run();
            }catch(InterruptedException ignored){Thread.currentThread().interrupt();}
            finally{owner.remove();synchronized(SessionWorkers.this){if(threads.get(role)==Thread.currentThread())threads.remove(role);}}
        },role);
        threads.put(role,thread);thread.start();
    }
    synchronized boolean track(HttpURLConnection connection){
        if(!active()){connection.disconnect();return false;}
        connections.add(connection);return true;
    }
    synchronized void release(HttpURLConnection connection){connections.remove(connection);connection.disconnect();}
    boolean pause(long ms){try{Thread.sleep(ms);return active();}catch(InterruptedException ignored){Thread.currentThread().interrupt();return false;}}
}
