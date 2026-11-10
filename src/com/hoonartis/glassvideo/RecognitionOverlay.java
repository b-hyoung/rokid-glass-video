package com.hoonartis.glassvideo;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.Path;
import android.os.SystemClock;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;

/** Camera coordinates are an approximate HUD map, not calibrated spatial AR. */
final class RecognitionOverlay extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final DashPathEffect targetDash = new DashPathEffect(new float[]{8,5},0);
    private static final int MAX_TARGETS = 12;
    private JSONObject state;
    private long guideUntil,stateUntil,stateReceivedAt,stateAge,frameAge;
    private String animatedFocus = "";
    private String animatedTrack = "";
    private long animatedFocusStart, lastProgressFrame;
    private float displayedProgress;
    private LocalTracking tracking;
    private HudChannel hudChannel;
    void attach(LocalTracking tracking,HudChannel channel){this.tracking=tracking;this.hudChannel=channel;}
    private void reportHud(String mode,JSONArray objects){
        if(hudChannel==null)return;
        try{hudChannel.drawn(new JSONObject().put("mode",mode).put("width",getWidth()).put("height",getHeight()).put("objects",objects).put("tracking",tracking!=null&&tracking.available()));}catch(Exception ignored){}
    }
    RecognitionOverlay(Context context) { super(context); }
    // The play badge identifies a recognized object with a linked video.
    private void drawTargetLabel(Canvas c,String name,float left,float baseline,float width) {
        paint.setStyle(Paint.Style.FILL);paint.setTextSize(15f);paint.setColor(Color.GREEN);
        float available=Math.max(0,width-left-20);
        String label=android.text.TextUtils.ellipsize(name,new android.text.TextPaint(paint),available,android.text.TextUtils.TruncateAt.END).toString();
        float cy=baseline-5;
        paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(1.5f);c.drawCircle(left+7,cy,6,paint);
        paint.setStyle(Paint.Style.FILL);
        Path triangle=new Path();triangle.moveTo(left+6,cy-3);triangle.lineTo(left+6,cy+3);triangle.lineTo(left+10,cy);triangle.close();c.drawPath(triangle,paint);
        c.drawText(label,left+17,baseline,paint);
    }
    void update(JSONObject value) {update(value,0);}
    void update(JSONObject value,long transitMs) {
        state=value;guideUntil=0;stateReceivedAt=SystemClock.elapsedRealtime();
        stateAge=value==null?0:Math.max(0,value.optLong("serverNow")-value.optLong("at")+transitMs);
        // Age of the analyzed camera frame on arrival; drives motion compensation.
        frameAge=value==null?0:Math.max(0,value.optLong("serverNow")-value.optLong("frameAt",value.optLong("at"))+transitMs);
        stateUntil=value==null?0:stateReceivedAt+Math.max(0,2200-stateAge);
        JSONObject guide=value==null?null:value.optJSONObject("guide");
        if(guide!=null&&guide.optBoolean("enabled"))guideUntil=SystemClock.elapsedRealtime()+Math.max(0,Math.min(5000,guide.optLong("expiresAt")-value.optLong("serverNow")-transitMs));
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
        if("align".equals(guide.optString("phase"))){
            paint.setStyle(Paint.Style.FILL);paint.setTextSize(14);
            c.drawText("1",x+5,y-rh/2+15,paint);
            c.drawText("2",x+rw/2-13,y-5,paint);
            c.drawText("3",x+5,y+rh/2-5,paint);
            c.drawText("4",x-rw/2+5,y-5,paint);
            paint.setStyle(Paint.Style.STROKE);
        }
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
        if(drawGuide(c)){animatedFocus="";displayedProgress=0;reportHud("guide",new JSONArray());return;}
        if (state == null || !state.optBoolean("enabled")){animatedFocus="";displayedProgress=0;reportHud("idle",new JSONArray());postInvalidateDelayed(500);return;}
        float w = getWidth(), h = getHeight(), x = w / 2f, y = h / 2f;
        JSONObject guide=state.optJSONObject("guide"),hud=guide==null?null:guide.optJSONObject("hud"),camera=guide==null?null:guide.optJSONObject("camera");
        boolean calibrated=guide!=null&&guide.optBoolean("calibrated");
        if(calibrated){x=number(hud,"cx",.5f)*w;y=number(hud,"cy",.5f)*h;}
        paint.setColor(Color.GREEN); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(2f);
        c.drawCircle(x, y, 15, paint); c.drawLine(x-5,y,x+5,y,paint); c.drawLine(x,y-5,x,y+5,paint);
        paint.setStrokeWidth(4f);
        long now=SystemClock.elapsedRealtime();
        String focused = state.isNull("focused") ? "" : state.optString("focused");
        long focusStart = state.optLong("focusStartedAt");
        long serverNow=state.optLong("serverNow");
        long expires=state.optLong("focusExpiresAt",serverNow+Math.max(0,2500-stateAge));
        boolean activeFocus = DwellDisplay.visible(expires,serverNow,now-stateReceivedAt,
                !focused.isEmpty(),focused.equals(state.optString("locked")));
        boolean advancing=activeFocus&&!state.optBoolean("focusMissing")&&stateAge+now-stateReceivedAt<750;
        double serverProgress = activeFocus ? state.optDouble("progress", 0) : 0;
        float goal = (float)Math.max(0, Math.min(.99, serverProgress));
        String focusTrack=state.optString("focusTrackId");
        boolean newFocus = activeFocus && (!focused.equals(animatedFocus) || !focusTrack.equals(animatedTrack) || focusStart != animatedFocusStart);
        if (newFocus) {
            displayedProgress = 0;
            lastProgressFrame = now;
        }
        long frameMs = Math.min(50, now - lastProgressFrame);
        displayedProgress += (goal - displayedProgress) * (float)(1 - Math.exp(-frameMs / 65.0));
        if (Math.abs(goal - displayedProgress) < .001f) displayedProgress = goal;
        lastProgressFrame = now;
        animatedFocus = activeFocus ? focused : "";
        animatedTrack = activeFocus ? focusTrack : "";
        animatedFocusStart = focusStart;
        c.drawArc(x-20,y-20,x+20,y+20,-90,displayedProgress*360,false,paint);
        if (displayedProgress != goal) {
            postInvalidateOnAnimation();
        } else {
            postInvalidateDelayed(100);
        }
        JSONArray detections=new JSONArray(),shown=new JSONArray();
        boolean local=tracking!=null&&tracking.available();
        JSONArray server=now<stateUntil?state.optJSONArray("detections"):null;
        if(server!=null){
            detections=server;
        }else if(local){
            LocalTracking.Snapshot snapshot=tracking.snapshot();
            if(now-snapshot.at<=250)for(PatchTracker.Track t:snapshot.tracks){
                if(now>=t.identityUntil)continue;
                try{JSONArray corners=new JSONArray();for(double[] p:t.corners)corners.put(new JSONArray().put(p[0]).put(p[1]));detections.put(new JSONObject().put("id",t.id).put("name",t.name).put("corners",corners));}catch(Exception ignored){}
            }
        }
        paint.setStyle(Paint.Style.FILL); paint.setTextSize(15f);
        float scaleX=1,scaleY=1,offsetX=0,offsetY=0;
        if(calibrated){
            float hw=number(hud,"width",.6f),hh=number(hud,"height",.35f);
            if("circle".equals(guide.optString("shape"))){float diameter=hw*Math.min(w,h);hw=diameter/w;hh=diameter/h;}
            scaleX=hw/number(camera,"width",.6f);
            scaleY=hh/number(camera,"height",.35f);
            offsetX=number(hud,"cx",.5f)-number(camera,"cx",.5f)*scaleX;
            offsetY=number(hud,"cy",.5f)-number(camera,"cy",.5f)*scaleY;
        }
        java.util.Set<String> drawn=new java.util.HashSet<>();
        boolean leading=false;
        for (int i=0; i<detections.length()&&shown.length()<MAX_TARGETS; i++) {
            JSONObject d=detections.optJSONObject(i); if (d==null) continue;
            String id=d.optString("id");
            if(drawn.contains(id))continue;
            JSONArray points=d.optJSONArray("corners"); if (points==null || points.length()!=4) continue;
            JSONArray velocity=server!=null&&!d.optBoolean("held")?d.optJSONArray("velocity"):null;
            long age=frameAge+now-stateReceivedAt;
            double[] lead=velocity!=null&&velocity.length()==2
                    ?BoxMotion.offset(velocity.optDouble(0),velocity.optDouble(1),age):new double[]{0,0};
            if((lead[0]!=0||lead[1]!=0)&&age<BoxMotion.MAX_LEAD_MS)leading=true;
            float sx=0,sy=0,left=Float.POSITIVE_INFINITY,right=Float.NEGATIVE_INFINITY;
            float top=Float.POSITIVE_INFINITY,bottom=Float.NEGATIVE_INFINITY;
            boolean ok=true;
            for (int j=0;j<4;j++) {
                JSONArray point=points.optJSONArray(j);
                if(point==null) {ok=false;break;}
                float px=(float)point.optDouble(0),py=(float)point.optDouble(1);
                if(!Float.isFinite(px)||!Float.isFinite(py)){ok=false;break;}
                px=offsetX+clamp01(px+(float)lead[0])*scaleX;py=offsetY+clamp01(py+(float)lead[1])*scaleY;
                sx+=px;sy+=py;
                left=Math.min(left,px);right=Math.max(right,px);
                top=Math.min(top,py);bottom=Math.max(bottom,py);
            }
            if(!ok||left>=1||right<=0||top>=1||bottom<=0)continue;
            float nx=sx/4,ny=sy/4;
            boolean approximate=d.optBoolean("approximate");
            if(!approximate){
                paint.setColor(Color.GREEN);paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(id.equals(animatedFocus)?3f:2f);
                paint.setPathEffect(targetDash);
                c.drawRect(left*w,top*h,right*w,bottom*h,paint);
                paint.setPathEffect(null);
            }
            String name=d.optString("name","대상")+(approximate?" · 위치 추정":"");
            float labelWidth=paint.measureText(name)+20;
            float px=approximate?Math.max(4,Math.min(w-labelWidth-4,nx*w-labelWidth/2)):right*w+6;
            if(px+labelWidth>w-4)px=left*w-6-labelWidth;
            if(px<4)px=Math.max(4,Math.min(w-70,nx*w));
            float py=Math.max(18,Math.min(h-4,ny*h));
            drawTargetLabel(c,name,px,py,w);
            drawn.add(id);
            try{
                JSONObject item=new JSONObject().put("id",id).put("x",px/w).put("y",py/h).put("playBadge",true)
                        .put("approximate",approximate);
                if(!approximate)item.put("corners",new JSONArray().put(point(left,top)).put(point(right,top))
                        .put(point(right,bottom)).put(point(left,bottom)));
                shown.put(item);
            }catch(Exception ignored){}
        }
        JSONArray targets=state.optJSONArray("targets");
        if(advancing&&!drawn.contains(animatedFocus)&&shown.length()<MAX_TARGETS&&targets!=null){
            for(int i=0;i<targets.length();i++){
                JSONObject target=targets.optJSONObject(i);
                if(target==null||!animatedFocus.equals(target.optString("id")))continue;
                String name=target.optString("name","");
                float width=paint.measureText(name)+17;
                float left=x+25+width<=w-4?x+25:Math.max(4,x-25-width);
                drawTargetLabel(c,name,left,y+5,w);
                try{shown.put(new JSONObject().put("id",animatedFocus).put("x",left/w).put("y",(y+5)/h).put("playBadge",true));}catch(Exception ignored){}
                break;
            }
        }
        // Keep redrawing while a box is still being led along its velocity.
        if(leading)postInvalidateOnAnimation();
        reportHud("recognition",shown);
    }

    private static float clamp01(float value){return Math.max(0,Math.min(1,value));}
    private static JSONArray point(float x,float y)throws org.json.JSONException{
        return new JSONArray().put((double)clamp01(x)).put((double)clamp01(y));
    }
}
