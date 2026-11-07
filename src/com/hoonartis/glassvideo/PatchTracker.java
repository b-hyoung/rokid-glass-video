package com.hoonartis.glassvideo;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Sparse, zero-mean patch matching with a robust similarity transform.
 * Position only: identity and its short lease always come from the recognizer.
 * No Android dependencies, so real image sequences can exercise the exact APK code.
 */
final class PatchTracker {
    static final int R = 3, PATCH = 49;
    static final class Point {
        final double x,y; final byte[] patch;
        Point(double x,double y,byte[] patch){this.x=x;this.y=y;this.patch=patch;}
    }
    static final class Track {
        final String id,name; final double[][] corners; final List<Point> points;
        final long identityUntil;
        Track(String id,String name,double[][] corners,List<Point> points,long until){
            this.id=id;this.name=name;this.corners=corners;this.points=points;this.identityUntil=until;
        }
    }
    static byte[] patch(byte[] image,int w,int h,int x,int y){
        if(x<R||y<R||x>=w-R||y>=h-R)return null;
        byte[] p=new byte[PATCH];int n=0;
        for(int dy=-R;dy<=R;dy++)for(int dx=-R;dx<=R;dx++)p[n++]=image[(y+dy)*w+x+dx];
        return p;
    }
    // Pearson correlation tolerates exposure / RGB-to-camera-luma differences.
    private static double score(byte[] p,byte[] image,int w,int x,int y,double mean,double energy){
        double sum=0,square=0,dot=0;int n=0;
        for(int dy=-R;dy<=R;dy++)for(int dx=-R;dx<=R;dx++){
            int v=image[(y+dy)*w+x+dx]&255;sum+=v;square+=v*v;dot+=((p[n++]&255)-mean)*v;
        }
        double variance=square-sum*sum/PATCH;
        return variance<100?-1:dot/Math.sqrt(energy*variance);
    }
    private static double[] match(Point p,byte[] image,int w,int h,int radius){
        double mean=0,energy=0;for(byte v:p.patch)mean+=v&255;mean/=PATCH;
        for(byte v:p.patch){double a=(v&255)-mean;energy+=a*a;}
        if(energy<400)return null;
        int x0=Math.max(R,(int)Math.round(p.x)-radius),x1=Math.min(w-R-1,(int)Math.round(p.x)+radius);
        int y0=Math.max(R,(int)Math.round(p.y)-radius),y1=Math.min(h-R-1,(int)Math.round(p.y)+radius);
        if(x0>x1||y0>y1)return null;
        double best=-1;int bx=0,by=0,n=0;double[] scores=new double[(x1-x0+1)*(y1-y0+1)];
        for(int y=y0;y<=y1;y++)for(int x=x0;x<=x1;x++){
            double s=score(p.patch,image,w,x,y,mean,energy);scores[n++]=s;
            if(s>best){best=s;bx=x;by=y;}
        }
        if(best<.79)return null;
        n=0;double second=-1;
        for(int y=y0;y<=y1;y++)for(int x=x0;x<=x1;x++){
            double s=scores[n++];if(Math.abs(x-bx)>2||Math.abs(y-by)>2)second=Math.max(second,s);
        }
        if(second>best-.055)return null; // repetitive texture is not a reliable location
        return new double[]{p.x,p.y,bx,by};
    }
    static Track advance(Track source,byte[] previous,byte[] image,int w,int h,boolean anchor,long now){
        if(source.identityUntil<=now||source.points.size()<4)return null;
        List<double[]> matches=new ArrayList<>();
        for(Point p:source.points){
            double[] m=match(p,image,w,h,anchor?24:10);if(m==null)continue;
            if(previous!=null){
                byte[] current=patch(image,w,h,(int)m[2],(int)m[3]);
                double[] back=match(new Point(m[0],m[1],current),previous,w,h,10);
                if(back==null||Math.hypot(back[2]-m[0],back[3]-m[1])>1.5)continue;
            }
            matches.add(m);
        }
        if(matches.size()<4)return null;
        double[] best=null;int support=0;
        for(int i=0;i<matches.size();i++)for(int j=i+1;j<matches.size();j++){
            double[] a=matches.get(i),b=matches.get(j);
            double dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;if(den<100)continue;
            double ux=b[2]-a[2],uy=b[3]-a[3],sc=(dx*ux+dy*uy)/den,rot=(dx*uy-dy*ux)/den;
            double scale=Math.hypot(sc,rot);if(scale<(anchor?.65:.8)||scale>(anchor?1.5:1.25)||Math.abs(Math.atan2(rot,sc))>(anchor?.4:.25))continue;
            double[] t={sc,rot,a[2]-sc*a[0]+rot*a[1],a[3]-rot*a[0]-sc*a[1]};
            int count=0;for(double[] m:matches)if(error(t,m)<2.5)count++;
            if(count>support){support=count;best=t;}
        }
        if(best==null||support<4||support<source.points.size()*.5)return null;
        // Least-squares similarity on the consensus, reducing integer-pixel jitter.
        double px=0,py=0,qx=0,qy=0;
        for(double[] m:matches)if(error(best,m)<2.5){px+=m[0];py+=m[1];qx+=m[2];qy+=m[3];}
        px/=support;py/=support;qx/=support;qy/=support;
        double dot=0,cross=0,den=0;
        for(double[] m:matches)if(error(best,m)<2.5){double x=m[0]-px,y=m[1]-py,u=m[2]-qx,v=m[3]-qy;dot+=x*u+y*v;cross+=x*v-y*u;den+=x*x+y*y;}
        if(den<100)return null;
        double a=dot/den,b=cross/den;double[] t={a,b,qx-a*px+b*py,qy-b*px-a*py};
        double[][] corners=new double[4][2];
        for(int i=0;i<4;i++){
            double x=source.corners[i][0]*w,y=source.corners[i][1]*h;
            corners[i][0]=(a*x-b*y+t[2])/w;corners[i][1]=(b*x+a*y+t[3])/h;
            if(corners[i][0]<0||corners[i][0]>1||corners[i][1]<0||corners[i][1]>1)return null;
        }
        List<Point> next=new ArrayList<>();
        for(double[] m:matches)if(error(t,m)<2.5){byte[] p=patch(image,w,h,(int)m[2],(int)m[3]);if(p!=null)next.add(new Point(m[2],m[3],p));}
        return next.size()<4?null:new Track(source.id,source.name,corners,next,source.identityUntil);
    }
    private static double error(double[] t,double[] m){return Math.hypot(t[0]*m[0]-t[1]*m[1]+t[2]-m[2],t[1]*m[0]+t[0]*m[1]+t[3]-m[3]);}
}
