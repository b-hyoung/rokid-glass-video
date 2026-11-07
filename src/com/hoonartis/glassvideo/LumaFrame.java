package com.hoonartis.glassvideo;
import java.nio.ByteBuffer;

final class LumaFrame {
    static byte[] centerCropRotate(ByteBuffer y,int width,int height,int row,int pixel,int outWidth,int outHeight){
        double aspect=(double)outHeight/outWidth;
        int cw=width,ch=height;
        if((double)width/height>aspect)cw=(int)Math.round(height*aspect);else ch=(int)Math.round(width/aspect);
        ByteBuffer crop=y.duplicate();crop.position(y.position()+((height-ch)/2)*row+((width-cw)/2)*pixel);
        return rotateAndResize(crop,cw,ch,row,pixel,outWidth,outHeight);
    }
    /** Average downsample followed by the web viewer's exact -90 degree rotation. */
    static byte[] rotateAndResize(ByteBuffer y,int width,int height,int row,int pixel,int outWidth,int outHeight){
        byte[] result=new byte[outWidth*outHeight];int base=y.position();
        for(int ry=0;ry<outWidth;ry++)for(int rx=0;rx<outHeight;rx++){
            int x0=rx*width/outHeight,x1=Math.max(x0+1,(rx+1)*width/outHeight);
            int y0=ry*height/outWidth,y1=Math.max(y0+1,(ry+1)*height/outWidth),sum=0,count=0;
            for(int sy=y0;sy<y1;sy++)for(int sx=x0;sx<x1;sx++){sum+=y.get(base+sy*row+sx*pixel)&255;count++;}
            result[(outHeight-1-rx)*outWidth+ry]=(byte)(sum/count);
        }
        return result;
    }
}
