package com.hoonartis.glassvideo;
import java.util.function.Supplier;

/** One sender with a replaceable latest report. Stop reports may drain for ten
 * seconds, and a restart wakes the same owner instead of starting a second loop. */
final class PlaybackReporter {
    interface Sender {long send(String origin,String token,String event)throws Exception;}
    interface Observer {void acknowledged(String origin,String token,long sequence);}
    private static final class Report {
        final String origin,token,event;
        Report(String origin,String token,String event){this.origin=origin;this.token=token;this.event=event;}
    }
    private final Supplier<String> origin;
    private final Sender sender;
    private final Observer observer;
    private Report latest=new Report("","","");
    private Thread worker;
    private boolean running;
    private long stoppedAt;
    PlaybackReporter(Supplier<String> origin,Sender sender,Observer observer){this.origin=origin;this.sender=sender;this.observer=observer;}
    private static long now(){return System.nanoTime()/1000000;}
    synchronized void update(String token,String event){latest=new Report(origin.get(),token,event);notifyAll();}
    synchronized void start(){
        // A stop acknowledgement queued in the previous Activity generation
        // may have been discarded. Re-send it to establish the new barrier.
        if(!running&&!latest.token.isEmpty())latest=new Report(latest.origin,latest.token,latest.event);
        running=true;
        if(worker==null||!worker.isAlive()){
            worker=new Thread(()->{try{loop();}finally{synchronized(this){if(worker==Thread.currentThread()){worker=null;if(running)start();}}}},"playback-state");worker.start();
        }
        notifyAll();
    }
    synchronized void stop(){running=false;stoppedAt=now();notifyAll();}
    private void loop(){
        Report sent=null;long lastSent=0;int failures=0;
        while(true){
            Report report;
            synchronized(this){report=latest;if(!running&&(report.token.isEmpty()||report==sent||now()-stoppedAt>=10000))return;}
            boolean busy=report.event.equals("loading")||report.event.equals("playing");long delay=500;
            if(!report.token.isEmpty()&&(report!=sent||busy&&now()-lastSent>=5000))try{
                long sequence=sender.send(report.origin,report.token,report.event);sent=report;lastSent=now();failures=0;
                if(!busy)observer.acknowledged(report.origin,report.token,sequence);
            }catch(Exception ignored){delay=Math.min(30000,1000L<<Math.min(5,failures++));}
            synchronized(this){
                if(report!=latest)continue;
                if(!running&&(report==sent||report.token.isEmpty()))return;
                if(!running)delay=Math.min(delay,Math.max(1,10000-(now()-stoppedAt)));
                try{wait(delay);}catch(InterruptedException ignored){Thread.currentThread().interrupt();return;}
            }
        }
    }
}
