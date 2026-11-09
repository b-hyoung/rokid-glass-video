package com.hoonartis.glassvideo;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
public class PlaybackReporterTest {
    public static void main(String[] args)throws Exception{
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1),ack=new CountDownLatch(1),again=new CountDownLatch(1);AtomicInteger active=new AtomicInteger(),maximum=new AtomicInteger(),ackCount=new AtomicInteger();
        PlaybackReporter reporter=new PlaybackReporter(()->"http://first.test",(origin,token,event)->{
            int n=active.incrementAndGet();maximum.accumulateAndGet(n,Math::max);
            try{if(event.equals("loading")){entered.countDown();if(!release.await(2,TimeUnit.SECONDS))throw new AssertionError("sender did not release");}return 20;}
            finally{active.decrementAndGet();}
        },(origin,token,seq)->{if(origin.equals("http://first.test")&&token.equals("video")&&seq==20){ack.countDown();if(ackCount.incrementAndGet()>1)again.countDown();}});
        reporter.update("video","loading");reporter.start();if(!entered.await(2,TimeUnit.SECONDS))throw new AssertionError("no sender");
        for(int i=0;i<50;i++){reporter.stop();reporter.start();}
        reporter.update("video","stopped");reporter.stop();release.countDown();
        if(!ack.await(2,TimeUnit.SECONDS)||maximum.get()!=1)throw new AssertionError("restart duplicated sender or lost cancellation");
        reporter.start();reporter.stop();if(!again.await(2,TimeUnit.SECONDS))throw new AssertionError("restart lost cancellation barrier acknowledgement");
        System.out.println("Playback sender: 50 restarts, one owner, final cancellation delivered");
    }
}
