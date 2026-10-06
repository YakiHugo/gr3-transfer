package io.gr3.transfer.core;

import java.io.*;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.security.*;
import java.util.*;

/** Bounded, private completed originals. Only a committed record can restore a JPEG.
 * Atomic rename protects process interruption; this is not a device/power-loss backup. */
public final class StagedOriginals {
    private static final String UUID_PATTERN = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    private static final int MAGIC = 0x47523301, REMOVED = 0x47523302, MAX_RECORD = 4096;
    private final File directory;
    public interface Boundary {
        void beforeReplace() throws IOException;
        default void beforeDelete(File file) throws IOException { }
    }
    private final Boundary boundary;
    private final Set<String> unavailable = new HashSet<>();
    public int unavailableCount() { return unavailable.size(); }
    public static final class Usage {
        public final int files; public final long bytes;
        Usage(int files, long bytes) { this.files = files; this.bytes = bytes; }
    }
    /** Physical copies count even when quarantined, unfinished, or logically removed but not yet unlinked. */
    public Usage usage() throws IOException {
        checkDirectory(); File[] files = directory.listFiles(); if (files == null) throw new IOException("无法读取原片目录。");
        int count = 0; long bytes = 0;
        for (File file : files) if (file.getName().matches(UUID_PATTERN + "\\.(jpg|part)")) {
            count++;
            if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return new Usage(CameraRules.MAX_ENTRIES, CameraRules.MAX_STAGED_BYTES);
            long length = Files.size(file.toPath());
            bytes += Math.min(length, Long.MAX_VALUE - bytes);
        }
        return new Usage(count, bytes);
    }
    private void delete(File file) throws IOException { boundary.beforeDelete(file); Files.deleteIfExists(file.toPath()); }
    public static final class Recovery {
        public final List<TransferTray.Entry> entries;
        public final int rejected;
        Recovery(List<TransferTray.Entry> entries, int rejected) { this.entries = entries; this.rejected = rejected; }
    }
    public StagedOriginals(File directory) throws IOException { this(directory, () -> {}); }
    /** Injectable pre-commit fault boundary used by production-transaction tests. */
    public StagedOriginals(File directory, Boundary boundary) throws IOException {
        if (Files.isSymbolicLink(directory.toPath())) throw new IOException("不安全的原片目录。");
        Files.createDirectories(directory.toPath());
        this.directory = directory.getCanonicalFile(); this.boundary = boundary; checkDirectory();
    }
    public File directory() { return directory; }
    private void checkDirectory() throws IOException {
        if (!Files.isDirectory(directory.toPath(), LinkOption.NOFOLLOW_LINKS) || !directory.getCanonicalFile().equals(directory)) throw new IOException("原片目录不可用。");
    }
    private File path(String id, String suffix) throws IOException {
        checkDirectory();
        if (id == null || !id.matches(UUID_PATTERN)) throw new IOException("原片记录标识无效。");
        return new File(directory, id + suffix);
    }
    private String id(File file, String suffix) throws IOException {
        if (file == null || !file.getAbsoluteFile().getParentFile().equals(directory) || !file.getName().endsWith(suffix)) throw new IOException("已拒绝目录以外的原片。");
        String id = file.getName().substring(0, file.getName().length() - suffix.length()); path(id, suffix); return id;
    }
    public File createPart() throws IOException {
        Usage usage = usage();
        if (usage.files >= CameraRules.MAX_ENTRIES || usage.bytes >= CameraRules.MAX_STAGED_BYTES) throw new IOException("应用内原片空间已满，请保存或清理副本。");
        File part = path(UUID.randomUUID().toString(), ".part"); Files.createFile(part.toPath()); return part;
    }
    public OutputStream openPart(File part) throws IOException {
        id(part, ".part");
        FileChannel channel = FileChannel.open(part.toPath(), StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        return new FilterOutputStream(Channels.newOutputStream(channel)) {
            @Override public void write(byte[] bytes, int offset, int length) throws IOException { out.write(bytes, offset, length); }
            @Override public void close() throws IOException { try { flush(); channel.force(true); } finally { super.close(); } }
        };
    }
    public static InputStream openOriginal(File file) throws IOException {
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("原片文件不可用。");
        return Channels.newInputStream(FileChannel.open(file.toPath(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS));
    }
    private static OriginalCopy.Receipt inspect(File file, long bytes, String hash) throws IOException {
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) || bytes <= 0 || bytes > CameraRules.MAX_JPEG_BYTES || !hash.matches("[a-f0-9]{64}") || Files.size(file.toPath()) != bytes) throw new IOException("原片大小或校验值无效。");
        try (InputStream in = openOriginal(file)) {
            OriginalCopy.Receipt actual = OriginalCopy.inspect(in, bytes, new CancelToken());
            if (!actual.sha256.equals(hash)) throw new IOException("原片校验失败。");
            return actual;
        }
    }
    public void complete(TransferTray.Entry entry, File part, OriginalCopy.Receipt receipt, Collection<TransferTray.Entry> retained) throws IOException {
        String id = id(part, ".part"); long total = receipt.bytes; int count = 1;
        for (TransferTray.Entry other : retained) if (other != entry && other.file != null && other.receipt != null) { total += other.receipt.bytes; count++; }
        Usage physical = usage();
        if (count > CameraRules.MAX_ENTRIES || total > CameraRules.MAX_STAGED_BYTES || physical.files > CameraRules.MAX_ENTRIES || physical.bytes > CameraRules.MAX_STAGED_BYTES) throw new IOException("原片保留空间已满。");
        inspect(part, receipt.bytes, receipt.sha256);
        File original = path(id, ".jpg");
        Files.move(part.toPath(), original.toPath(), StandardCopyOption.ATOMIC_MOVE);
        entry.stagingId = id; entry.file = original; entry.receipt = receipt;
        try { write(entry, null); }
        catch (IOException error) {
            try { delete(original); }
            catch (IOException cleanup) { unavailable.add(id); error.addSuppressed(cleanup); }
            finally { entry.stagingId = null; entry.file = null; entry.receipt = null; }
            throw error;
        }
    }
    public static boolean validSavedUri(String uri) {
        return uri != null && uri.matches("content://media/external_primary/images/media/[1-9][0-9]*");
    }
    /** Must commit before the destination can publish, so an ambiguous save can never auto-duplicate. */
    public void rememberSave(TransferTray.Entry entry, String uri) throws IOException {
        if (!validSavedUri(uri)) throw new IOException("保存地址无效。");
        write(entry, uri); entry.pendingSaveUri = uri;
    }
    /** Called only after the exact destination has been proven absent/unpublished and cleaned. */
    public void resetSave(TransferTray.Entry entry) throws IOException { write(entry, null); entry.pendingSaveUri = null; }
    private void write(TransferTray.Entry entry, String uri) throws IOException {
        validate(entry.session, entry.photo.folder, entry.photo.name, entry.attempts, entry.receipt.bytes, entry.receipt.sha256, uri);
        File original = path(entry.stagingId, ".jpg");
        if (!original.equals(entry.file) || !Files.isRegularFile(original.toPath(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("原片文件不可用。");
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(buffer)) {
            out.writeUTF(entry.session); out.writeUTF(entry.photo.folder); out.writeUTF(entry.photo.name); out.writeBoolean(entry.demo);
            int raw = 0; for (CameraRules.RawFormat format : entry.photo.rawFormats) raw |= 1 << format.ordinal();
            out.writeByte(raw); out.writeByte(entry.attempts); out.writeLong(entry.receipt.bytes); out.writeUTF(entry.receipt.sha256); out.writeUTF(uri == null ? "" : uri);
        }
        byte[] payload = buffer.toByteArray(); File temporary = path(entry.stagingId, ".record.part"), record = path(entry.stagingId, ".record");
        // Delete only this private name, never follow an old temporary symlink.
        Files.deleteIfExists(temporary.toPath());
        try {
            try (FileChannel channel = FileChannel.open(temporary.toPath(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                DataOutputStream out = new DataOutputStream(Channels.newOutputStream(channel));
                out.writeInt(MAGIC); out.writeInt(payload.length); out.write(payload); out.write(digest(payload)); out.flush(); channel.force(true);
            }
            boundary.beforeReplace();
            Files.move(temporary.toPath(), record.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }
    private static byte[] digest(byte[] bytes) {
        try { return MessageDigest.getInstance("SHA-256").digest(bytes); } catch (NoSuchAlgorithmException e) { throw new AssertionError(e); }
    }
    private static void validate(String session, String folder, String name, int attempts, long bytes, String hash, String uri) throws IOException {
        if (!session.matches(UUID_PATTERN) || attempts < 1 || attempts > 3 || bytes <= 0 || bytes > CameraRules.MAX_JPEG_BYTES || !hash.matches("[a-f0-9]{64}") || uri != null && !validSavedUri(uri)) throw new IOException("原片记录无效。");
        new CameraRules.Photo(folder, name);
    }
    private TransferTray.Entry read(File record, long remaining) throws IOException {
        String id = id(record, ".record");
        if (!Files.isRegularFile(record.toPath(), LinkOption.NOFOLLOW_LINKS) || Files.size(record.toPath()) > MAX_RECORD) throw new IOException("原片记录过大。");
        byte[] payload;
        try (DataInputStream in = new DataInputStream(openOriginal(record))) {
            if (in.readInt() != MAGIC) throw new IOException("未知原片记录。");
            int length = in.readInt(); if (length <= 0 || length > MAX_RECORD - 40) throw new IOException("原片记录长度无效。");
            payload = new byte[length]; in.readFully(payload); byte[] hash = new byte[32]; in.readFully(hash);
            if (in.read() != -1 || !MessageDigest.isEqual(hash, digest(payload))) throw new IOException("原片记录不完整。");
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(payload))) {
            String session = in.readUTF(), folder = in.readUTF(), name = in.readUTF(); int demo = in.readUnsignedByte(), raw = in.readUnsignedByte(), attempts = in.readUnsignedByte();
            long bytes = in.readLong(); String hash = in.readUTF(), uri = in.readUTF(); if (uri.isEmpty()) uri = null;
            validate(session, folder, name, attempts, bytes, hash, uri);
            if (bytes > remaining) throw new IOException("恢复原片超过保留空间上限。");
            if (demo > 1 || (raw & ~3) != 0 || in.read() != -1) throw new IOException("原片元数据无效。");
            EnumSet<CameraRules.RawFormat> formats = EnumSet.noneOf(CameraRules.RawFormat.class);
            for (CameraRules.RawFormat format : CameraRules.RawFormat.values()) if ((raw & 1 << format.ordinal()) != 0) formats.add(format);
            TransferTray.Entry entry = new TransferTray.Entry(session, new CameraRules.Photo(folder, name, null, formats), demo == 1);
            entry.file = path(id, ".jpg"); entry.receipt = inspect(entry.file, bytes, hash); entry.bytes = bytes; entry.expected = bytes;
            entry.stagingId = id; entry.pendingSaveUri = uri; entry.attempts = attempts; entry.recovered = true;
            entry.status = TransferTray.Status.READY; entry.message = "已恢复并校验原片，可离线保存；不会重试之前的相机连接。";
            return entry;
        }
    }
    private boolean removalCommitted(String id) throws IOException {
        File marker = path(id, ".gone");
        if (!Files.isRegularFile(marker.toPath(), LinkOption.NOFOLLOW_LINKS) || Files.size(marker.toPath()) != 4) return false;
        try (DataInputStream in = new DataInputStream(openOriginal(marker))) { return in.readInt() == REMOVED; }
    }
    private void commitRemoval(String id) throws IOException {
        File temporary = path(id, ".gone.part");
        delete(temporary);
        try (FileChannel channel = FileChannel.open(temporary.toPath(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
            DataOutputStream out = new DataOutputStream(Channels.newOutputStream(channel)); out.writeInt(REMOVED); out.flush(); channel.force(true);
        }
        boundary.beforeReplace();
        Files.move(temporary.toPath(), path(id, ".gone").toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
    /** Once the tombstone commits, cleanup failure never changes the logical removal result. */
    private boolean cleanRemoved(String id) {
        try {
            delete(path(id, ".record")); delete(path(id, ".record.part")); delete(path(id, ".jpg")); delete(path(id, ".part"));
            delete(path(id, ".gone.part")); delete(path(id, ".gone")); return true;
        } catch (IOException error) { return false; }
    }
    public Recovery restore() throws IOException {
        checkDirectory(); File[] files = directory.listFiles(); if (files == null) throw new IOException("无法读取原片目录。");
        Arrays.sort(files, Comparator.comparing(File::getName)); List<TransferTray.Entry> entries = new ArrayList<>(); Set<String> keys = new HashSet<>(), accepted = new HashSet<>(), removed = new HashSet<>(); long bytes = 0;
        unavailable.clear();
        for (File file : files) if (file.getName().matches(UUID_PATTERN + "\\.gone")) {
            String id = id(file, ".gone");
            if (removalCommitted(id)) { removed.add(id); cleanRemoved(id); }
            else unavailable.add(id); // A damaged removal marker is never permission to restore or delete.
        }
        for (File file : files) {
            if (!file.getName().matches(UUID_PATTERN + "\\.record")) continue;
            String id = id(file, ".record"); if (removed.contains(id) || unavailable.contains(id)) continue;
            try {
                if (entries.size() == CameraRules.MAX_ENTRIES) throw new IOException("恢复记录超过数量上限。");
                TransferTray.Entry entry = read(file, CameraRules.MAX_STAGED_BYTES - bytes);
                if (!keys.add(entry.key)) throw new IOException("恢复记录重复。");
                entries.add(entry); bytes += entry.receipt.bytes; accepted.add(id);
            } catch (IOException | IllegalArgumentException error) { unavailable.add(id); }
        }
        for (File file : files) {
            if (file.getName().matches(UUID_PATTERN + "\\.jpg")) {
                String id = id(file, ".jpg");
                if (!accepted.contains(id) && !removed.contains(id)) unavailable.add(id);
            }
            // Only these files are provably uncommitted. Completed JPEGs with missing/corrupt
            // records are preserved, consume the physical budget and need explicit discard.
            if (file.getName().matches(UUID_PATTERN + "\\.(part|record\\.part|gone\\.part)")) {
                try { delete(file); } catch (IOException ignored) { /* Physical usage still counts .part bytes. */ }
            }
        }
        return new Recovery(entries, unavailable.size());
    }
    public boolean forget(TransferTray.Entry entry) throws IOException {
        if (entry.stagingId == null) return true;
        String id = entry.stagingId; path(id, ".jpg");
        commitRemoval(id);
        // This is the logical commit point. Never tell the user the original is retained after this.
        entry.stagingId = null; entry.file = null; unavailable.remove(id);
        return cleanRemoved(id);
    }
    /** Only for an explicitly confirmed clear of all app-private originals, including quarantine. */
    public boolean discardUnavailable() throws IOException {
        boolean clean = true;
        for (String id : new HashSet<>(unavailable)) {
            commitRemoval(id); unavailable.remove(id); clean &= cleanRemoved(id);
        }
        return clean;
    }
}
