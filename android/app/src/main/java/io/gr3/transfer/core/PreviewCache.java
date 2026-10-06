package io.gr3.transfer.core;
import java.util.LinkedHashMap;
import java.util.Map;
/** Shared small derivative-cache bound; never stores original-file bytes. */
public final class PreviewCache<V> extends LinkedHashMap<String,V> {
    private static final long serialVersionUID=1L;
    public static final int MAX_ITEMS=24;
    public PreviewCache(){super(MAX_ITEMS,.75f,true);}
    @Override protected boolean removeEldestEntry(Map.Entry<String,V> eldest){return size()>MAX_ITEMS;}
}
