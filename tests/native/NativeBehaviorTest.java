package com.hoonartis.glassvideo;
import java.nio.ByteBuffer;
import java.util.*;

public class NativeBehaviorTest {
    static final int W=180,H=320;
    static void check(boolean ok,String what){if(!ok)throw new AssertionError(what);}
    static byte[] scene(int step){
        byte[] image=new byte[W*H];Arrays.fill(image,(byte)20);
        for(int object=0;object<2;object++){
            Random r=new Random(41+object);
            int ox=20+object*80+(object==0?step*2:-step),oy=50+object*130+step;
            for(int y=0;y<90;y++)for(int x=0;x<50;x++)image[(oy+y)*W+ox+x]=(byte)(40+r.nextInt(170));
        }
        return image;
    }
    static PatchTracker.Track seed(byte[] image,int object){
        int x=20+object*80,y=50+object*130;
        List<PatchTracker.Point> points=new ArrayList<>();
        for(int dy=15;dy<=75;dy+=20)for(int dx=10;dx<=40;dx+=15)points.add(new PatchTracker.Point(x+dx,y+dy,PatchTracker.patch(image,W,H,x+dx,y+dy)));
        return new PatchTracker.Track("id"+object,"object"+object,new double[][]{{x/(double)W,y/(double)H},{(x+50)/(double)W,y/(double)H},{(x+50)/(double)W,(y+90)/(double)H},{x/(double)W,(y+90)/(double)H}},points,1800);
    }
    public static void main(String[] args){
        byte[] first=scene(0),previous=first;PatchTracker.Track a=seed(first,0),b=seed(first,1);
        long start=System.nanoTime();
        for(int n=1;n<=8;n++){
            byte[] current=scene(n);a=PatchTracker.advance(a,previous,current,W,H,false,n*66);b=PatchTracker.advance(b,previous,current,W,H,false,n*66);
            check(a!=null&&b!=null,"two independent objects must remain tracked at step "+n);
            check(Math.abs(a.corners[0][0]*W-(20+n*2))<.5,"first object position");
            check(Math.abs(b.corners[0][0]*W-(100-n))<.5,"second object position");previous=current;
        }
        check(PatchTracker.advance(a,previous,new byte[W*H],W,H,false,700)==null,"occlusion must remove label");
        check(PatchTracker.advance(a,previous,previous,W,H,false,1801)==null,"identity lease cannot be renewed by tracking");
        PatchTracker.Track delayed=PatchTracker.advance(seed(first,0),null,scene(6),W,H,true,900);
        check(delayed!=null&&Math.abs(delayed.corners[0][0]*W-32)<.5,"delayed anchor aligns to current image, not old coordinates");
        check(PatchTracker.advance(seed(first,0),null,new byte[W*H],W,H,true,900)==null,"unverified seed must never show");
        byte[] exposed=first.clone();for(int i=0;i<exposed.length;i++)exposed[i]=(byte)Math.min(255,(exposed[i]&255)*.85+20);
        check(PatchTracker.advance(seed(first,0),null,exposed,W,H,true,900)!=null,"exposure differences tolerate camera luma versus browser RGB");
        ByteBuffer padded=ByteBuffer.allocate(24);padded.position(2);for(int y=0;y<2;y++)for(int x=0;x<3;x++)padded.put(2+y*10+x*2,(byte)(1+y*3+x));
        check(Arrays.equals(LumaFrame.rotateAndResize(padded,3,2,10,2,2,3),new byte[]{3,6,2,5,1,4}),"camera stride and -90 degree rotation agree with web");
        PlaybackGate gate=new PlaybackGate();check(gate.accept("a",10,true),"first autoplay");
        check(!gate.accept("b",11,true),"block second video while loading");
        gate.stop();check(!gate.busy(),"button immediately stops loading or playing");check(!gate.accept("b",12,true),"stop waits for server cancellation barrier");
        gate.acknowledged("a",15);check(!gate.accept("old",14,true),"delayed automatic command cannot restart after button");
        check(gate.accept("new",16,true),"fresh automatic selection after server rearm");
        check(gate.accept("manual",17,false),"explicit manual replacement remains available");gate.acknowledged("new",20);check(gate.current("manual"),"old completion cannot affect replacement");
        double[] lead=BoxMotion.offset(.4,0,100);
        check(Math.abs(lead[0]-.04)<1e-9&&lead[1]==0,"a box moving 40%/s is led 4% for 100ms of age");
        check(Math.abs(BoxMotion.offset(.2,0,2000)[0]-.2*BoxMotion.MAX_LEAD_MS/1000)<1e-9,"lead time is capped");
        double[] capped=BoxMotion.offset(3,0,250);check(Math.abs(capped[0]-BoxMotion.MAX_SHIFT)<1e-9,"lead distance is capped");
        check(BoxMotion.offset(.01,0,200)[0]==0,"slow drift is not extrapolated");
        check(BoxMotion.offset(Double.NaN,0,200)[0]==0&&BoxMotion.offset(.4,0,-5)[0]==0,"invalid velocity or age is ignored");
        System.out.printf(Locale.ROOT,"PASS: 2-object motion, delayed anchor, loss, expiry, exposure, rotation/strides, playback gate and box lead; %.1f ms JVM total%n",(System.nanoTime()-start)/1e6);
    }
}
