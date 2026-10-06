import io.gr3.transfer.core.*;
import java.util.*;
public final class PreviewTests {
    private static int count;
    private static void check(boolean value,String label){if(!value)throw new AssertionError(label);count++;}
    private static boolean near(float a,float b){return Math.abs(a-b)<.001f;}
    public static void main(String[] args)throws Exception {
        PreviewGeometry geometry=new PreviewGeometry();geometry.configure(1200,800,300,300);
        check(near(geometry.matrix()[0],.25f)&&near(geometry.matrix()[2],0)&&near(geometry.matrix()[5],50),"fit centers derivative with unchanged aspect ratio");
        geometry.panBy(999,999);check(near(geometry.matrix()[2],0)&&near(geometry.matrix()[5],50),"fit image cannot be panned out of view");
        geometry.zoomBy(2,150,150);check(geometry.zoom()==2&&near(geometry.matrix()[0],.5f),"center zoom doubles scale");
        geometry.panBy(999,999);check(near(geometry.matrix()[2],0)&&near(geometry.matrix()[5],0),"pan clamps at near edges");
        geometry.panBy(-999,-999);check(near(geometry.matrix()[2],-300)&&near(geometry.matrix()[5],-100),"pan clamps at far edges");
        geometry.zoomBy(100,150,150);check(geometry.zoom()==4,"zoom capped at four times fit");
        geometry.zoomBy(.001f,150,150);check(geometry.zoom()==1&&near(geometry.matrix()[5],50),"zoom cannot shrink below fit");
        geometry.zoomBy(Float.NaN,0,0);geometry.zoomBy(2,Float.NaN,0);geometry.panBy(Float.NaN,1);check(geometry.zoom()==1,"nonfinite gestures ignored");
        geometry.configure(0,Float.POSITIVE_INFINITY,-1,Float.MAX_VALUE);for(float value:geometry.matrix())check(Float.isFinite(value),"degenerate viewport remains finite");
        geometry.configure(100,100,200,200);geometry.zoomBy(2,0,0);check(near(geometry.matrix()[2],0)&&near(geometry.matrix()[5],0),"off-center pinch preserves focus until bounds clamp");
        geometry.fit();check(geometry.zoom()==1&&near(geometry.matrix()[0],2),"fit resets zoom and translation");
        List<CameraRules.Photo> photos=Arrays.asList(new CameraRules.Photo("100RICOH","R1.JPG"),new CameraRules.Photo("101RICOH","R1.JPG"),new CameraRules.Photo("101RICOH","R2.JPG"));
        check(GalleryRules.previewIndex(photos,"101RICOH/R1.JPG")==1,"duplicate names retain folder identity");
        check(GalleryRules.previewNeighbor(photos,photos.get(0).key(),-1)==null,"no previous before first");
        check(GalleryRules.previewNeighbor(photos,photos.get(2).key(),1)==null,"no next after last");
        check(GalleryRules.previewNeighbor(photos,photos.get(0).key(),1)==photos.get(1),"next follows filtered ordering");
        check(GalleryRules.previewNeighbor(photos,"missing",1)==null&&GalleryRules.previewNeighbor(photos,photos.get(0).key(),2)==null,"stale and invalid navigation cannot jump");
        List<CameraRules.Photo> filtered=GalleryRules.filter(photos,"","101RICOH");check(GalleryRules.previewNeighbor(filtered,photos.get(0).key(),1)==null,"hidden old selection does not navigate a new filter");
        PreviewCache<Integer> cache=new PreviewCache<>();for(int i=0;i<40;i++)cache.put("p"+i,i);
        check(cache.size()==24&&!cache.containsKey("p15")&&cache.containsKey("p16"),"derivative cache evicts old entries at fixed limit");
        cache.get("p16");cache.put("new",99);check(cache.containsKey("p16")&&!cache.containsKey("p17"),"recently viewed derivative survives LRU eviction");
        cache.put("p16",100);check(cache.size()==24&&cache.get("p16")==100,"reloading an existing derivative never grows cache");
        cache.clear();check(cache.isEmpty(),"source change can clear cached derivatives");
        System.out.println("PASS "+count+" native preview geometry/navigation assertions; no image bytes rewritten");
    }
}
