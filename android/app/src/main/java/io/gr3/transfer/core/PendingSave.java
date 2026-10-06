package io.gr3.transfer.core;
import java.io.*;
/** Testable save transaction. The Store adapter owns only rows created by this app. */
public final class PendingSave {
    public interface Destination { void remember(String id) throws IOException; }
    public interface Source { InputStream open() throws IOException; }
    public interface Store {
        String createPending(String name, boolean demo) throws IOException;
        void remember(String id) throws IOException;
        OutputStream openOutput(String id) throws IOException;
        InputStream openInput(String id) throws IOException;
        void publish(String id) throws IOException;
        void forget(String id) throws IOException;
        void discardPending(String id) throws IOException;
    }
    public static String save(Store store, Source source, String name, boolean demo, OriginalCopy.Receipt receipt, CancelToken token) throws IOException {
        return save(store, source, name, demo, receipt, token, id -> {});
    }
    public static String save(Store store, Source source, String name, boolean demo, OriginalCopy.Receipt receipt, CancelToken token, Destination destination) throws IOException {
        token.check(); String id = store.createPending(name, demo); boolean published = false;
        try {
            store.remember(id);
            destination.remember(id);
            try (InputStream in = source.open(); OutputStream out = store.openOutput(id)) {
                if (out == null) throw new IOException("Android 无法打开待保存的照片。");
                OriginalCopy.Receipt copied = OriginalCopy.copy(in, out, receipt.bytes, CameraRules.MAX_JPEG_BYTES, token, (b, total) -> {});
                if (!copied.sha256.equals(receipt.sha256)) throw new TransferException("原片在保存前发生变化，未写入相册。");
            }
            try (InputStream saved = store.openInput(id)) {
                if (saved == null) throw new IOException("Android 无法校验已写入的照片。");
                OriginalCopy.Receipt readBack = OriginalCopy.inspect(saved, receipt.bytes, token);
                if (!readBack.sha256.equals(receipt.sha256)) throw new TransferException("保存校验未通过，未写入相册。");
            }
            token.check(); store.publish(id); published = true;
            // Publication is the commit point. A later cancel or journal error never deletes a saved JPEG.
            try { store.forget(id); } catch (IOException ignored) { /* Startup checks pending state. */ }
            return id;
        } finally {
            if (!published) try { store.discardPending(id); store.forget(id); } catch (IOException ignored) { /* Keep journal for startup cleanup / system expiry. */ }
        }
    }
}
