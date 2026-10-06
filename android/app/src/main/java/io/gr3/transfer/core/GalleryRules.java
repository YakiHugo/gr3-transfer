package io.gr3.transfer.core;
import java.util.*;
/** Pure local gallery operations. Never changes the camera inventory or file paths. */
public final class GalleryRules {
    private GalleryRules() { }
    public static List<CameraRules.Photo> filter(List<CameraRules.Photo> photos, String query) {
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        List<CameraRules.Photo> result = new ArrayList<>();
        for (CameraRules.Photo photo : photos) if (needle.isEmpty() || photo.key().toLowerCase(Locale.ROOT).contains(needle)) result.add(photo);
        return result;
    }
}
