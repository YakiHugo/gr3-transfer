package io.gr3.transfer.core;
import java.util.*;
/** Pure local gallery operations. Never changes the camera inventory or file paths. */
public final class GalleryRules {
    private GalleryRules() { }
    public enum SortOrder { CAMERA, NAME_ASC, NAME_DESC, FOLDER_ASC;
        public static SortOrder restore(String value) { try { return valueOf(value); } catch (IllegalArgumentException | NullPointerException ignored) { return CAMERA; } }
    }
    public static List<CameraRules.Photo> sort(List<CameraRules.Photo> photos, SortOrder order) {
        List<CameraRules.Photo> result = new ArrayList<>(photos);
        Comparator<CameraRules.Photo> name = (a,b) -> {
            int compared = naturalCompare(a.name,b.name);
            if (compared == 0) compared = naturalCompare(a.folder,b.folder);
            return compared == 0 ? a.key().compareTo(b.key()) : compared;
        };
        if (order == SortOrder.NAME_ASC) result.sort(name);
        else if (order == SortOrder.NAME_DESC) result.sort(name.reversed());
        else if (order == SortOrder.FOLDER_ASC) result.sort((a,b) -> { int compared = naturalCompare(a.folder,b.folder); return compared == 0 ? name.compare(a,b) : compared; });
        return result;
    }
    /** Compares digit runs without parsing an integer, including 64-character names. */
    public static int naturalCompare(String left, String right) {
        int i = 0, j = 0;
        while (i < left.length() && j < right.length()) {
            char a = Character.toLowerCase(left.charAt(i)), b = Character.toLowerCase(right.charAt(j));
            if (a >= '0' && a <= '9' && b >= '0' && b <= '9') {
                int endA = i, endB = j;
                while (endA < left.length() && left.charAt(endA) >= '0' && left.charAt(endA) <= '9') endA++;
                while (endB < right.length() && right.charAt(endB) >= '0' && right.charAt(endB) <= '9') endB++;
                int startA = i, startB = j;
                while (startA < endA && left.charAt(startA) == '0') startA++;
                while (startB < endB && right.charAt(startB) == '0') startB++;
                int compared = Integer.compare(endA-startA,endB-startB);
                if (compared != 0) return compared;
                for (int n=0; n<endA-startA; n++) if (left.charAt(startA+n) != right.charAt(startB+n)) return Character.compare(left.charAt(startA+n),right.charAt(startB+n));
                compared = Integer.compare(endA-i,endB-j);
                if (compared != 0) return compared;
                i=endA; j=endB;
            } else { if (a != b) return Character.compare(a,b); i++; j++; }
        }
        return Integer.compare(left.length()-i,right.length()-j);
    }
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
