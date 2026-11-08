package com.hoonartis.glassvideo;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class SessionWorkersTest {
    static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        SessionWorkers owner=new SessionWorkers();AtomicInteger active=new AtomicInteger(),maximum=new AtomicInteger(),callbacks=new AtomicInteger();
        for(int round=0;round<50;round++){
            owner.begin();long ticket=owner.ticket();CountDownLatch entered=new CountDownLatch(1),released=new CountDownLatch(1);
            owner.start("recognition",()->{int n=active.incrementAndGet();maximum.accumulateAndGet(n,Math::max);entered.countDown();try{while(owner.active())if(!owner.pause(10000))break;}finally{active.decrementAndGet();if(owner.current(ticket))callbacks.incrementAndGet();released.countDown();}});
            check(entered.await(2,TimeUnit.SECONDS),"worker starts");owner.end();
            check(!owner.current(ticket),"old callbacks cannot become current");check(released.await(2,TimeUnit.SECONDS),"stop interrupts blocked sleep");
        }
        check(maximum.get()==1&&callbacks.get()==0,"one current worker, zero stale callbacks");
        owner.begin();final boolean[] disconnected={false};
        HttpURLConnection connection=new HttpURLConnection(new URL("http://invalid.test")){
            public void connect(){}public boolean usingProxy(){return false;}public void disconnect(){disconnected[0]=true;}
        };
        check(owner.track(connection),"current HTTP tracked");owner.end();check(disconnected[0],"stop cancels HTTP");
        owner.begin();check(owner.active(),"new session starts independently");owner.end();
        System.out.println("50 session restarts: one worker, no stale callbacks; HTTP cancelled");
    }
}
