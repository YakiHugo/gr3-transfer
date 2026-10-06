package io.gr3.transfer;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import io.gr3.transfer.core.*;
import java.io.*;
import java.util.*;
/** Only creates new app-owned media. Never queries the user's whole photo library. */
final class MediaSaver {
    private final ContentResolver resolver;
    private final android.content.SharedPreferences journal;
    MediaSaver(Context context) { resolver = context.getContentResolver(); journal = context.getSharedPreferences("pending-saves", Context.MODE_PRIVATE); }
    private synchronized void remember(Uri uri, boolean add) throws IOException {
        Set<String> values = new HashSet<>(journal.getStringSet("uris", Collections.emptySet()));
        if (add) values.add(uri.toString()); else values.remove(uri.toString());
        if (!journal.edit().putStringSet("uris", values).commit()) throw new IOException("无法记录待保存的照片。");
    }
    // After process death remove only our recorded, still-pending rows. Never delete a published JPEG.
    void cleanInterrupted() {
        for (String value : new HashSet<>(journal.getStringSet("uris", Collections.emptySet()))) {
            Uri uri = Uri.parse(value);
            if (!StagedOriginals.validSavedUri(value)) continue;
            try {
                boolean pending = false;
                try (Cursor cursor = resolver.query(uri, new String[]{MediaStore.Images.Media.IS_PENDING}, null, null, null)) {
                    if (cursor == null) continue;
                    if (cursor.moveToFirst()) pending = cursor.getInt(0) == 1;
                }
                if (pending && resolver.delete(uri, MediaStore.Images.Media.IS_PENDING + " = ?", new String[]{"1"}) != 1) continue;
                remember(uri, false);
            } catch (Exception ignored) { /* Leave journal for next startup; MediaStore also expires pending rows. */ }
        }
    }
    enum SavedState { MISSING, PUBLISHED, UNKNOWN }
    // Query only our journaled exact item, never names or the entire photo library.
    SavedState savedState(String value, OriginalCopy.Receipt receipt) {
        if (!StagedOriginals.validSavedUri(value)) return SavedState.UNKNOWN;
        Uri uri = Uri.parse(value);
        try {
            try (Cursor cursor = resolver.query(uri, new String[]{MediaStore.Images.Media.IS_PENDING}, null, null, null)) {
                if (cursor == null) return SavedState.UNKNOWN;
                if (!cursor.moveToFirst()) return SavedState.MISSING;
                if (cursor.isNull(0) || cursor.getInt(0) != 0) return SavedState.UNKNOWN;
            }
            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) return SavedState.UNKNOWN;
                OriginalCopy.Receipt actual = OriginalCopy.inspect(in, receipt.bytes, new CancelToken());
                return actual.sha256.equals(receipt.sha256) ? SavedState.PUBLISHED : SavedState.UNKNOWN;
            }
        } catch (Exception ignored) { return SavedState.UNKNOWN; }
    }
    Uri save(File original, String name, OriginalCopy.Receipt receipt, boolean demo, CancelToken token, PendingSave.Destination destination) throws IOException {
        PendingSave.Store store = new PendingSave.Store() {
            public String createPending(String displayName, boolean synthetic) throws IOException {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, displayName);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + (synthetic ? "/GR III Transfer Demo" : "/GR III Transfer"));
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
                if (uri == null) throw new IOException("Android 无法创建待保存照片，请检查存储空间。");
                return uri.toString();
            }
            public void remember(String id) throws IOException { MediaSaver.this.remember(Uri.parse(id), true); }
            public OutputStream openOutput(String id) throws IOException { return resolver.openOutputStream(Uri.parse(id), "w"); }
            public InputStream openInput(String id) throws IOException { return resolver.openInputStream(Uri.parse(id)); }
            public void publish(String id) throws IOException {
                ContentValues values = new ContentValues(); values.put(MediaStore.Images.Media.IS_PENDING, 0);
                if (resolver.update(Uri.parse(id), values, null, null) != 1) throw new IOException("Android 未能完成照片保存。");
            }
            public void forget(String id) throws IOException { MediaSaver.this.remember(Uri.parse(id), false); }
            public void discardPending(String id) throws IOException {
                try { resolver.delete(Uri.parse(id), MediaStore.Images.Media.IS_PENDING + " = ?", new String[]{"1"}); } catch (RuntimeException e) { throw new IOException("将在下次启动时重新清理未完成的照片。"); }
            }
        };
        return Uri.parse(PendingSave.save(store, () -> StagedOriginals.openOriginal(original), name, demo, receipt, token, destination));
    }
}
