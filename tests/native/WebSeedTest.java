package com.hoonartis.glassvideo;
import java.nio.file.*;
import java.util.*;
import org.json.*;

/** Cross-language contract: actual Chrome/OpenCV patches must initialize the APK tracker. */
public class WebSeedTest {
 public static void main(String[] args)throws Exception{
  JSONObject fixture=new JSONObject(Files.readString(Path.of(args[0])));byte[] gray=Base64.getDecoder().decode(fixture.getString("gray"));JSONArray found=fixture.getJSONArray("found");
  byte[] shifted=new byte[180*320];for(int y=0;y<317;y++)for(int x=0;x<176;x++)shifted[(y+3)*180+x+4]=gray[y*180+x];
  for(int i=0;i<found.length();i++){
   JSONObject d=found.getJSONObject(i),seed=d.getJSONObject("seed");JSONArray points=seed.getJSONArray("points"),quad=d.getJSONArray("corners");
   List<PatchTracker.Point> p=new ArrayList<>();for(int j=0;j<points.length();j++){JSONObject point=points.getJSONObject(j);p.add(new PatchTracker.Point(point.getInt("x"),point.getInt("y"),Base64.getDecoder().decode(point.getString("patch"))));}
   double[][] corners=new double[4][2];for(int j=0;j<4;j++){corners[j][0]=quad.getJSONArray(j).getDouble(0);corners[j][1]=quad.getJSONArray(j).getDouble(1);}
   PatchTracker.Track original=new PatchTracker.Track(d.getString("id"),"target",corners,p,1800),current=PatchTracker.advance(original,null,shifted,180,320,true,1000);
   if(current==null)throw new AssertionError("Chrome seed rejected: "+original.id);
   if(Math.abs((current.corners[0][0]-original.corners[0][0])*180-4)>.6||Math.abs((current.corners[0][1]-original.corners[0][1])*320-3)>.6)throw new AssertionError("Wrong delayed-anchor position");
   System.out.println("PASS: actual OpenCV seed -> APK tracker, target "+original.id+", "+current.points.size()+" verified patches");
  }
 }
}
