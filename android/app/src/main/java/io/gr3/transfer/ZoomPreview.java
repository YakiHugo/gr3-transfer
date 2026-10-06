package io.gr3.transfer;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.widget.ImageView;
import io.gr3.transfer.core.PreviewGeometry;
/** A derivative-image viewer. Original transfer/save bytes never pass through this view. */
final class ZoomPreview extends ImageView {
    private final PreviewGeometry geometry=new PreviewGeometry();
    private final ScaleGestureDetector gestures;
    private Bitmap bitmap;
    private float lastX,lastY;
    private int dragPointer=-1;
    ZoomPreview(Context context){
        super(context);setScaleType(ScaleType.MATRIX);setFocusable(true);setClickable(true);
        gestures=new ScaleGestureDetector(context,new ScaleGestureDetector.SimpleOnScaleGestureListener(){
            @Override public boolean onScale(ScaleGestureDetector detector){geometry.zoomBy(detector.getScaleFactor(),detector.getFocusX(),detector.getFocusY());apply();return true;}
        });
    }
    void show(Bitmap value){if(bitmap==value)return;bitmap=value;setImageBitmap(value);resetGeometry();}
    private void resetGeometry(){geometry.configure(bitmap==null?1:bitmap.getWidth(),bitmap==null?1:bitmap.getHeight(),getWidth(),getHeight());apply();}
    @Override protected void onSizeChanged(int w,int h,int oldW,int oldH){super.onSizeChanged(w,h,oldW,oldH);resetGeometry();}
    void zoomBy(float factor){geometry.zoomBy(factor,getWidth()/2f,getHeight()/2f);apply();}
    void fit(){geometry.fit();apply();}
    float zoomFactor(){return geometry.zoom();}
    private void apply(){Matrix matrix=new Matrix();matrix.setValues(geometry.matrix());setImageMatrix(matrix);setContentDescription("相机预览图，缩放"+String.format(java.util.Locale.ROOT,"%.1f",geometry.zoom())+"倍，可双指放大和拖动；不是原片");}
    @Override public boolean onTouchEvent(MotionEvent event){
        gestures.onTouchEvent(event);
        switch(event.getActionMasked()){
            case MotionEvent.ACTION_DOWN:dragPointer=event.getPointerId(0);anchor(event,0);if(getParent()!=null)getParent().requestDisallowInterceptTouchEvent(true);return true;
            case MotionEvent.ACTION_POINTER_DOWN:{int index=event.findPointerIndex(dragPointer);if(index>=0)anchor(event,index);return true;}
            case MotionEvent.ACTION_POINTER_UP:{
                int lifted=event.getActionIndex(),index=event.findPointerIndex(dragPointer);
                if(index==lifted||index<0){index=lifted==0?1:0;dragPointer=event.getPointerId(index);}
                anchor(event,index);return true;
            }
            case MotionEvent.ACTION_MOVE:{
                int index=event.findPointerIndex(dragPointer);if(index<0){index=0;dragPointer=event.getPointerId(index);anchor(event,index);}
                if(!gestures.isInProgress()&&event.getPointerCount()==1){geometry.panBy(event.getX(index)-lastX,event.getY(index)-lastY);apply();}
                anchor(event,index);return true;
            }
            case MotionEvent.ACTION_UP:dragPointer=-1;performClick();if(getParent()!=null)getParent().requestDisallowInterceptTouchEvent(false);return true;
            case MotionEvent.ACTION_CANCEL:dragPointer=-1;if(getParent()!=null)getParent().requestDisallowInterceptTouchEvent(false);return true;
            default:return true;
        }
    }
    private void anchor(MotionEvent event,int index){lastX=event.getX(index);lastY=event.getY(index);}

    @Override public boolean performClick(){super.performClick();return true;}
}
