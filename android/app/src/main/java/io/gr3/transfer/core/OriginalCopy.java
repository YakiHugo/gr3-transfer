package io.gr3.transfer.core;
import java.io.*;
import java.security.*;
public final class OriginalCopy {
    public interface Progress { void update(long bytes, long expected); }
    public static final class Receipt {
        public final long bytes;
        public final String sha256;
        Receipt(long bytes, String sha256) { this.bytes = bytes; this.sha256 = sha256; }
    }
    private static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); }
    }
    public static Receipt copy(InputStream in, OutputStream out, long expected, long maximum, CancelToken token, Progress progress) throws IOException {
        if (expected < -1 || expected > maximum) throw new TransferException("相机返回的文件超过大小限制。");
        JpegValidator validator = new JpegValidator(); MessageDigest hash = digest(); long bytes = 0;
        byte[] buffer = new byte[32768];
        while (true) {
            token.check(); int count = in.read(buffer); token.check();
            if (count < 0) break;
            if (count == 0) continue;
            bytes += count;
            if (bytes > maximum || expected >= 0 && bytes > expected) throw new TransferException("JPEG 大小超过声明长度或导入限制。");
            validator.push(buffer, 0, count); hash.update(buffer, 0, count); out.write(buffer, 0, count);
            progress.update(bytes, expected);
        }
        token.check(); validator.finish();
        if (expected >= 0 && bytes != expected) throw new TransferException("JPEG 接收不完整，文件长度不匹配。");
        out.flush(); return new Receipt(bytes, hex(hash.digest()));
    }
    public static Receipt inspect(InputStream in, long expected, CancelToken token) throws IOException {
        return copy(in, new OutputStream() { public void write(int b) {} public void write(byte[] b, int o, int n) {} }, expected, CameraRules.MAX_JPEG_BYTES, token, (bytes, total) -> {});
    }
    private static String hex(byte[] digest) {
        StringBuilder out = new StringBuilder(); for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return out.toString();
    }
}
