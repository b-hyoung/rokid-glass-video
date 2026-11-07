package com.hoonartis.glassvideo;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.SystemClock;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;

/** Camera coordinates are an approximate HUD map, not calibrated spatial AR. */
final class RecognitionOverlay extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private JSONObject state;
    private long guideUntil,stateUntil;
    private LocalTracking tracking;
    private HudChannel hudChannel;
    void attach(LocalTracking tracking,HudChannel channel){this.tracking=tracking;this.hudChannel=channel;}
    private void reportHud(String mode,JSONArray objects){
        if(hudChannel==null)return;
        try{hudChannel.drawn(new JSONObject().put("mode",mode).put("width",getWidth()).put("height",getHeight()).put("objects",objects).put("tracking",tracking!=null&&tracking.available()));}catch(Exception ignored){}
    }
    RecognitionOverlay(Context context) { super(context); }
    void update(JSONObject value) {
        state=value;guideUntil=0;stateUntil=value==null?0:SystemClock.elapsedRealtime()+Math.max(0,2200-(value.optLong("serverNow")-value.optLong("at")));
        JSONObject guide=value==null?null:value.optJSONObject("guide");
        if(guide!=null&&guide.optBoolean("enabled"))guideUntil=SystemClock.elapsedRealtime()+Math.max(0,Math.min(5000,guide.optLong("expiresAt")-value.optLong("serverNow")));
        invalidate();
    }
    private float number(JSONObject value,String key,float fallback) {
        double n=value==null?fallback:value.optDouble(key,fallback);
        return Double.isNaN(n)||Double.isInfinite(n)?fallback:(float)Math.max(.05,Math.min(.95,n));
    }
    private boolean drawGuide(Canvas c) {
        JSONObject guide=state==null?null:state.optJSONObject("guide");
        if(guide==null||!guide.optBoolean("enabled")||SystemClock.elapsedRealtime()>=guideUntil)return false;
        JSONObject hud=guide.optJSONObject("hud");float w=getWidth(),h=getHeight();
        float x=number(hud,"cx",.5f)*w,y=number(hud,"cy",.5f)*h;
        float rw=number(hud,"width",.6f)*w,rh=number(hud,"height",.35f)*h;
        paint.setColor(Color.GREEN);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(3);
        if("circle".equals(guide.optString("shape"))){float radius=number(hud,"width",.6f)*Math.min(w,h)/2;c.drawCircle(x,y,radius,paint);rw=rh=radius*2;}
        else c.drawRect(x-rw/2,y-rh/2,x+rw/2,y+rh/2,paint);
        c.drawLine(x-5,y,x+5,y,paint);c.drawLine(x,y-5,x,y+5,paint);
        float left=Math.max(8,x-rw/2),right=Math.min(w-8,x+rw/2),bottom=Math.min(h-80,y+rh/2+12);
        paint.setStrokeWidth(2);c.drawLine(left,bottom,right,bottom,paint);paint.setStrokeWidth(5);
        c.drawLine(left,bottom,left+(right-left)*(float)Math.max(0,Math.min(1,guide.optDouble("progress"))),bottom,paint);
        paint.setStyle(Paint.Style.FILL);paint.setTextSize(15);paint.setTextAlign(Paint.Align.CENTER);
        String message=guide.optString("message","테두리 안에 물체를 맞춰 주세요");
        // Fit long server guidance without letting it disappear beyond the HUD edge.
        while(paint.measureText(message)>w-16&&paint.getTextSize()>10)paint.setTextSize(paint.getTextSize()-1);
        c.drawText(message,w/2,Math.min(h-50,bottom+24),paint);paint.setTextAlign(Paint.Align.LEFT);
        postInvalidateDelayed(500);return true;
    }
    @Override protected void onDraw(Canvas c) {
        super.onDraw(c);
        if(drawGuide(c)){reportHud("guide",new JSONArray());return;}
        if (state == null || !state.optBoolean("enabled")){reportHud("idle",new JSONArray());postInvalidateDelayed(500);return;}
        float w = getWidth(), h = getHeight(), x = w / 2f, y = h / 2f;
        JSONObject guide=state.optJSONObject("guide"),hud=guide==null?null:guide.optJSONObject("hud"),camera=guide==null?null:guide.optJSONObject("camera");
        boolean calibrated=guide!=null&&guide.optBoolean("calibrated");
        if(calibrated){x=number(hud,"cx",.5f)*w;y=number(hud,"cy",.5f)*h;}
        paint.setColor(Color.GREEN); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(2f);
        c.drawCircle(x, y, 15, paint); c.drawLine(x-5,y,x+5,y,paint); c.drawLine(x,y-5,x,y+5,paint);
        paint.setStrokeWidth(4f);
        c.drawArc(x-20,y-20,x+20,y+20,-90,(float)state.optDouble("progress",0)*360,false,paint);
        JSONArray detections=new JSONArray(),shown=new JSONArray();
        boolean local=tracking!=null&&tracking.available();
        long now=SystemClock.elapsedRealtime();
        if(local){
            LocalTracking.Snapshot snapshot=tracking.snapshot();
            if(now-snapshot.at<=250)for(PatchTracker.Track t:snapshot.tracks){
                if(now>=t.identityUntil)continue;
                try{JSONArray corners=new JSONArray();for(double[] p:t.corners)corners.put(new JSONArray().put(p[0]).put(p[1]));detections.put(new JSONObject().put("id",t.id).put("name",t.name).put("corners",corners));}catch(Exception ignored){}
            }
        }else if(now<stateUntil){JSONArray server=state.optJSONArray("detections");if(server!=null)detections=server;}
        postInvalidateDelayed(100);
        paint.setStyle(Paint.Style.FILL); paint.setTextSize(15f);
        for (int i=0; i<detections.length(); i++) {
            JSONObject d=detections.optJSONObject(i); if (d==null) continue;
            JSONArray points=d.optJSONArray("corners"); if (points==null || points.length()!=4) continue;
            float sx=0,sy=0; boolean ok=true;
            for (int j=0;j<4;j++) { JSONArray point=points.optJSONArray(j); if(point==null) {ok=false;break;} sx+=(float)point.optDouble(0); sy+=(float)point.optDouble(1); }
            if (!ok) continue;
            float nx=sx/4,ny=sy/4;
            if(calibrated){
                float hw=number(hud,"width",.6f),hh=number(hud,"height",.35f);
                if("circle".equals(guide.optString("shape"))){float diameter=hw*Math.min(w,h);hw=diameter/w;hh=diameter/h;}
                nx=number(hud,"cx",.5f)+(nx-number(camera,"cx",.5f))*hw/number(camera,"width",.6f);
                ny=number(hud,"cy",.5f)+(ny-number(camera,"cy",.5f))*hh/number(camera,"height",.35f);
            }
            float px=Math.max(4,Math.min(w-70,nx*w)), py=Math.max(18,Math.min(h-4,ny*h));
            String name=d.optString("name","대상");
            c.drawText(name,px,py,paint);
            try{shown.put(new JSONObject().put("id",d.optString("id")).put("x",px/w).put("y",py/h));}catch(Exception ignored){}
        }
        reportHud("recognition",shown);
    }
}
