package io.gr3.transfer.core;
import java.util.*;
/** Pure local gallery operations. Never changes the camera inventory or file paths. */
public final class GalleryRules {
    private GalleryRules() { }
    public static List<CameraRules.Photo> filter(List<CameraRules.Photo> photos, String query) {
        return filter(photos, query, "");
    }
    public static List<CameraRules.Photo> filter(List<CameraRules.Photo> photos, String query, String folder) {
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        List<CameraRules.Photo> result = new ArrayList<>();
        for (CameraRules.Photo photo : photos) if ((folder == null || folder.isEmpty() || folder.equals(photo.folder)) && (needle.isEmpty() || photo.key().toLowerCase(Locale.ROOT).contains(needle))) result.add(photo);
        return result;
    }
    public static Map<String,Integer> folders(List<CameraRules.Photo> photos) {
        Map<String,Integer> counts = new TreeMap<>();
        for (CameraRules.Photo photo : photos) counts.put(photo.folder, counts.getOrDefault(photo.folder, 0) + 1);
        return counts;
    }
}
