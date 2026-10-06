package io.gr3.transfer.core;
/** Bounded preview-only fit/zoom/pan. Never changes image bytes or save operations. */
public final class PreviewGeometry {
    private float imageWidth=1,imageHeight=1,viewWidth=1,viewHeight=1,zoom=1,x,y;
    private static float positive(float value) { return Float.isFinite(value)&&value>=1?Math.min(value,1000000f):1; }
    public void configure(float imageWidth,float imageHeight,float viewWidth,float viewHeight) {
        this.imageWidth=positive(imageWidth);this.imageHeight=positive(imageHeight);this.viewWidth=positive(viewWidth);this.viewHeight=positive(viewHeight);fit();
    }
    public void fit(){zoom=1;x=0;y=0;}
    public float zoom(){return zoom;}
    private float base(){return Math.min(viewWidth/imageWidth,viewHeight/imageHeight);}
    public void zoomBy(float factor,float focusX,float focusY){
        if(!Float.isFinite(factor)||factor<=0||!Float.isFinite(focusX)||!Float.isFinite(focusY))return;
        float next=Math.max(1,Math.min(4,zoom*factor)),ratio=next/zoom;
        float fx=focusX-viewWidth/2,fy=focusY-viewHeight/2;
        x=(x-fx)*ratio+fx;y=(y-fy)*ratio+fy;zoom=next;clamp();
    }
    public void panBy(float dx,float dy){if(!Float.isFinite(dx)||!Float.isFinite(dy))return;x+=dx;y+=dy;clamp();}
    private void clamp(){float maxX=Math.max(0,(imageWidth*base()*zoom-viewWidth)/2),maxY=Math.max(0,(imageHeight*base()*zoom-viewHeight)/2);x=Math.max(-maxX,Math.min(maxX,x));y=Math.max(-maxY,Math.min(maxY,y));}
    public float[] matrix(){float scale=base()*zoom;return new float[]{scale,0,(viewWidth-imageWidth*scale)/2+x,0,scale,(viewHeight-imageHeight*scale)/2+y,0,0,1};}
}
