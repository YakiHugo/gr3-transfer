package io.gr3.transfer.core;
import java.util.*;
import java.util.regex.Pattern;
public final class CameraRules {
    public static final String ORIGIN = "http://192.168.0.1";
    public static final long MAX_JPEG_BYTES = 128L * 1024 * 1024;
    public static final long MAX_STAGED_BYTES = 256L * 1024 * 1024;
    public static final int MAX_JSON_BYTES = 8 * 1024 * 1024, MAX_ENTRIES = 48;
    private static final Pattern FOLDER = Pattern.compile("[A-Za-z0-9_-]{1,64}"), JPEG = Pattern.compile("[A-Za-z0-9_-]{1,64}\\.jpe?g", Pattern.CASE_INSENSITIVE);
    public static final class Photo {
        public final String folder, name, asset;
        public Photo(String folder, String name) throws TransferException { this(folder, name, null); }
        public Photo(String folder, String name, String asset) throws TransferException {
            if (!FOLDER.matcher(folder).matches() || !JPEG.matcher(name).matches()) throw new TransferException("已拒绝不安全的相机文件名。");
            this.folder = folder; this.name = name; this.asset = asset;
        }
        public String key() { return folder + "/" + name; }
        public String originalPath() { return "/v1/photos/" + key(); }
        public String thumbnailPath() { return originalPath() + "?size=thumb"; }
    }
    public static final class Inventory {
        public final List<Photo> photos;
        public final int raw, other, duplicate;
        public Inventory(List<Photo> photos, int raw, int other, int duplicate) { this.photos = Collections.unmodifiableList(photos); this.raw = raw; this.other = other; this.duplicate = duplicate; }
        public String summary() { return photos.size() + " JPEGs · " + raw + " RAW excluded · " + other + " other · " + duplicate + " repeated entries"; }
    }
    private static Map<?,?> object(Object value) throws TransferException {
        if (!(value instanceof Map)) throw new TransferException("无法识别相机响应，请重新连接后重试。");
        Map<?,?> result = (Map<?,?>) value;
        if (result.containsKey("errCode") && (!(result.get("errCode") instanceof Number) || ((Number) result.get("errCode")).doubleValue() != 200)) throw new TransferException("相机报告错误，请保持相机唤醒后重试。");
        return result;
    }
    public static void requireModel(Object response) throws TransferException {
        Object model = object(response).get("model");
        if (!(model instanceof String) || !((String) model).trim().replaceAll("\\s+", " ").equalsIgnoreCase("RICOH GR III")) throw new TransferException("仅支持 RICOH GR III，当前设备并非这一型号。");
        // Ignore everything else: props may contain credentials, serial numbers and location.
    }
    public static Inventory inventory(Object response) throws TransferException {
        Object dirs = object(response).get("dirs");
        if (!(dirs instanceof List)) throw new TransferException("无法识别相机照片列表，请重新连接后重试。");
        Map<String,Photo> photos = new LinkedHashMap<>(); Set<String> seen = new HashSet<>();
        int raw = 0, other = 0, duplicate = 0, entries = 0;
        for (Object value : (List<?>) dirs) {
            Map<?,?> dir = object(value); Object folder = dir.get("name"), files = dir.get("files");
            if (!(folder instanceof String) || !FOLDER.matcher((String) folder).matches() || !(files instanceof List)) throw new TransferException("无法识别相机文件夹。");
            for (Object file : (List<?>) files) {
                if (!(file instanceof String) || ((String) file).length() > 512 || ++entries > 100000) throw new TransferException("相机列表格式有误或超过 100,000 条记录。");
                String name = (String) file, key = folder + "/" + name, lower = name.toLowerCase(Locale.ROOT);
                if (!seen.add(key)) { duplicate++; continue; }
                if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) { Photo photo = new Photo((String) folder, name); photos.put(key, photo); }
                else if (lower.endsWith(".dng") || lower.endsWith(".pef")) raw++;
                else other++;
                if (photos.size() > 50000) throw new TransferException("存储卡中的 JPEG 超过 50,000 张，暂时无法读取。");
            }
        }
        List<Photo> sorted = new ArrayList<>(photos.values());
        sorted.sort(Comparator.comparing((Photo p) -> p.folder).thenComparing(p -> p.name).reversed());
        return new Inventory(sorted, raw, other, duplicate);
    }
    public static String allowedUrl(String path) throws TransferException {
        if (!path.matches("/v1/(props|photos(/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}\\.[jJ][pP][eE]?[gG](\\?size=thumb)?)?)")) throw new TransferException("已拒绝未获允许的相机访问路径。");
        return ORIGIN + path;
    }
    public static long contentLength(String text, long maximum) throws TransferException {
        if (text == null) return -1;
        if (!text.matches("[0-9]{1,19}")) throw new TransferException("相机返回的文件长度无效。");
        try { long size = Long.parseLong(text); if (size > maximum) throw new TransferException("相机返回的文件超过大小限制。"); return size; }
        catch (NumberFormatException e) { throw new TransferException("相机返回的文件长度无效。"); }
    }
    public static String saveName(String session, Photo photo, boolean synthetic) {
        if (!session.matches("[a-f0-9-]{36}")) throw new IllegalArgumentException("连接会话无效");
        return (synthetic ? "DEMO_" : "") + photo.folder + "__" + session.substring(0, 8) + "__" + photo.name;
    }
}
