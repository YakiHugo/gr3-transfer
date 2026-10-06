package io.gr3.transfer.core;
import java.io.File;
import java.util.*;
/** A process-local tray. Every new connection has a fresh, non-camera-identifying session. */
public final class TransferTray {
    public enum Status { QUEUED, TRANSFERRING, READY, SAVING, SAVED, FAILED, CANCELLED }
    public static final class Entry {
        public final String key, session;
        public final CameraRules.Photo photo;
        public final boolean demo;
        public Status status = Status.QUEUED;
        public int attempts;
        public long bytes, expected = -1;
        public String message = "等待导入", savedUri;
        public OriginalCopy.Receipt receipt;
        public File file;
        Entry(String session, CameraRules.Photo photo, boolean demo) { this.session = session; this.photo = photo; this.demo = demo; key = session + ":" + photo.key(); }
        public boolean retryable(String current) { return session.equals(current) && attempts < 3 && (status == Status.FAILED || status == Status.CANCELLED); }
        public boolean unsaved() { return receipt != null && savedUri == null; }
    }
    private final LinkedHashMap<String,Entry> entries = new LinkedHashMap<>();
    public List<Entry> all() { return new ArrayList<>(entries.values()); }
    public List<Entry> admit(String session, Collection<CameraRules.Photo> photos, boolean demo) throws TransferException {
        if (!session.matches("[a-f0-9-]{36}")) throw new TransferException("请先重新连接相机，再导入照片。");
        LinkedHashMap<String,CameraRules.Photo> unique = new LinkedHashMap<>();
        for (CameraRules.Photo p : photos) if (!entries.containsKey(session + ":" + p.key())) unique.put(p.key(), p);
        if (entries.size() + unique.size() > CameraRules.MAX_ENTRIES) throw new TransferException("导入记录最多保留 48 张。请先保存并清空已完成的记录，再添加照片。");
        List<Entry> added = new ArrayList<>();
        for (CameraRules.Photo p : unique.values()) { Entry entry = new Entry(session, p, demo); entries.put(entry.key, entry); added.add(entry); }
        return added;
    }
    public long stagedBytes() { long bytes = 0; for (Entry e : entries.values()) if (e.file != null && e.receipt != null) bytes += e.receipt.bytes; return bytes; }
    public long availableBytes() { return Math.max(0, CameraRules.MAX_STAGED_BYTES - stagedBytes()); }
    public List<Entry> retry(String session) {
        List<Entry> eligible = new ArrayList<>();
        for (Entry e : entries.values()) if (e.retryable(session)) { e.status = Status.QUEUED; e.message = "等待重新导入"; eligible.add(e); }
        return eligible;
    }
    /** Drops only confirmed saved records; never deletes a MediaStore URI. */
    public int clearSaved() {
        int removed=0;Iterator<Entry> iterator=entries.values().iterator();
        while(iterator.hasNext()) {
            Entry entry=iterator.next();
            if(entry.status!=Status.SAVED||entry.savedUri==null)continue;
            if(entry.file!=null&&entry.file.exists()&&!entry.file.delete())continue;
            iterator.remove();removed++;
        }
        return removed;
    }
    public void clear() { for (Entry e : entries.values()) if (e.file != null) e.file.delete(); entries.clear(); }
    public boolean hasUnsaved() { for (Entry e : entries.values()) if (e.unsaved()) return true; return false; }
}
