package com.hoonartis.glassvideo;

import android.os.SystemClock;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Network thread publishes bounded seeds; camera analysis thread owns tracking.
 * Published snapshots are immutable and read directly by the HUD on the UI thread.
 */
final class LocalTracking {
    static final class Snapshot {
        final List<PatchTracker.Track> tracks; final long at; final double ms;
        Snapshot(List<PatchTracker.Track> tracks,long at,double ms){this.tracks=tracks;this.at=at;this.ms=ms;}
    }
    private volatile Snapshot snapshot=new Snapshot(new ArrayList<>(),0,0);
    private volatile List<PatchTracker.Track> pending=new ArrayList<>();
    private volatile boolean enabled,available;
    private volatile int height=320;
    private volatile long generation;
    private long appliedGeneration=-1,lastFrame,lastSeedFrame=-1,lastEpoch=-1;
    private byte[] previous;
    private final Map<String,PatchTracker.Track> tracks=new LinkedHashMap<>();
    private final Runnable redraw;
    LocalTracking(Runnable redraw){this.redraw=redraw;}
    synchronized void camera(boolean available,int height){
        this.available=available;this.height=height;generation++;pending=new ArrayList<>();
        snapshot=new Snapshot(new ArrayList<>(),0,0);lastSeedFrame=-1;redraw.run();
    }
    boolean available(){return available;}
    boolean wantsFrames(){return enabled&&available;}
    Snapshot snapshot(){return snapshot;}
    synchronized void update(JSONObject state,long roundTripMs){
        long now=SystemClock.elapsedRealtime();
        boolean active=state!=null&&state.optBoolean("enabled")&&!(state.optJSONObject("guide")!=null&&state.optJSONObject("guide").optBoolean("enabled"));
        long epoch=state==null?-1:state.optLong("epoch");
        if(!active||epoch!=lastEpoch){generation++;lastSeedFrame=-1;snapshot=new Snapshot(new ArrayList<>(),0,0);pending=new ArrayList<>();}
        lastEpoch=epoch;enabled=active;
        if(!active||!available)return;
        long frameAt=state.optLong("frameAt");
        if(frameAt<=lastSeedFrame)return;lastSeedFrame=frameAt;
        long serverNow=state.optLong("serverNow"),age=serverNow-frameAt+roundTripMs;
        List<PatchTracker.Track> seeds=new ArrayList<>();
        JSONArray found=state.optJSONArray("detections");
        if(age<0||age>1500||found==null){pending=seeds;return;}
        for(int i=0;i<Math.min(4,found.length());i++)try{
            JSONObject d=found.getJSONObject(i),seed=d.optJSONObject("seed");
            if(seed==null||seed.optInt("w")!=180||seed.optInt("h")!=height)continue;
            long remaining=1800-(serverNow-d.optLong("matchedAt")+roundTripMs);
            if(remaining<=0||remaining>1800)continue;
            double[][] corners=new double[4][2];JSONArray quad=d.getJSONArray("corners");
            for(int j=0;j<4;j++){corners[j][0]=quad.getJSONArray(j).getDouble(0);corners[j][1]=quad.getJSONArray(j).getDouble(1);}
            List<PatchTracker.Point> points=new ArrayList<>();JSONArray p=seed.getJSONArray("points");
            for(int j=0;j<Math.min(12,p.length());j++){
                JSONObject v=p.getJSONObject(j);int x=v.getInt("x"),y=v.getInt("y");byte[] patch=Base64.decode(v.getString("patch"),Base64.NO_WRAP);
                if(patch.length==49&&x>=3&&y>=3&&x<177&&y<height-3)points.add(new PatchTracker.Point(x,y,patch));
            }
            if(points.size()>=4)seeds.add(new PatchTracker.Track(d.getString("id"),d.optString("name","대상"),corners,points,now+remaining));
        }catch(Exception ignored){}
        pending=seeds;
    }
    void frame(byte[] image,int w,int h){
        long started=SystemClock.elapsedRealtime(),version=generation;
        if(appliedGeneration!=version||started-lastFrame>250||previous==null||previous.length!=image.length){tracks.clear();previous=null;appliedGeneration=version;}
        if(!wantsFrames()){tracks.clear();previous=null;return;}
        for(String id:new ArrayList<>(tracks.keySet())){
            PatchTracker.Track next=previous==null?null:PatchTracker.advance(tracks.get(id),previous,image,w,h,false,started);
            if(next==null)tracks.remove(id);else tracks.put(id,next);
        }
        List<PatchTracker.Track> seeds;
        synchronized(this){seeds=pending;pending=new ArrayList<>();}
        for(PatchTracker.Track seed:seeds){
            PatchTracker.Track next=PatchTracker.advance(seed,null,image,w,h,true,started);
            if(next!=null)tracks.put(next.id,next);
        }
        previous=image;lastFrame=started;
        if(version!=generation||!wantsFrames())return;
        snapshot=new Snapshot(new ArrayList<>(tracks.values()),started,SystemClock.elapsedRealtime()-started);redraw.run();
    }
    boolean centered(String id,double cx,double cy){
        Snapshot s=snapshot;if(SystemClock.elapsedRealtime()-s.at>250)return false;
        for(PatchTracker.Track t:s.tracks)if(t.id.equals(id)&&t.identityUntil>SystemClock.elapsedRealtime()){
            double sign=0;
            for(int i=0;i<4;i++){
                double[] a=t.corners[i],b=t.corners[(i+1)%4];double cross=Math.signum((b[0]-a[0])*(cy-a[1])-(b[1]-a[1])*(cx-a[0]));
                if(cross!=0&&sign!=0&&cross!=sign)return false;if(cross!=0)sign=cross;
            }
            return sign!=0;
        }
        return false;
    }
}
