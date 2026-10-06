package io.gr3.transfer;
import android.content.*;
import android.net.*;
import android.os.*;
import io.gr3.transfer.core.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
final class TransferController {
    private final Context context;
    private final CameraTransport transport;
    private final MediaSaver saver;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final TransferTray tray = new TransferTray();
    private final File staging;
    private CancelToken token;
    private Network network;
    private Runnable listener;
    private long lastProgress;
    String session = "", status = "请先连接相机 Wi-Fi";
    boolean busy, connected, demo;
    CameraRules.Inventory inventory = new CameraRules.Inventory(new ArrayList<>(), 0, 0, 0);
    final LinkedHashMap<String,byte[]> thumbnails = new LinkedHashMap<>();
    TransferController(Context context) {
        this.context = context.getApplicationContext();
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        transport = new CameraTransport(manager); saver = new MediaSaver(context);
        staging = new File(context.getCacheDir(), "originals"); staging.mkdirs();
        worker.execute(() -> { File[] files = staging.listFiles(); if (files != null) for (File file : files) file.delete(); saver.cleanInterrupted(); });
        manager.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), new ConnectivityManager.NetworkCallback() {
            @Override public void onLost(Network lost) { main.post(() -> lost(lost)); }
        });
    }
    synchronized void listen(Runnable listener) { this.listener = listener; }
    private void changed() { main.post(() -> { Runnable current; synchronized (this) { current = listener; } if (current != null) current.run(); }); }
    synchronized List<TransferTray.Entry> entries() { return tray.all(); }
    synchronized boolean hasUnsaved() { return tray.hasUnsaved(); }
    synchronized long stagedBytes() { return tray.stagedBytes(); }
    private synchronized void lost(Network lost) {
        if (!lost.equals(network)) return;
        if (token != null) token.cancel();
        network = null; connected = false; session = ""; thumbnails.clear();
        inventory = new CameraRules.Inventory(new ArrayList<>(), 0, 0, 0);
        status = "相机 Wi-Fi 已断开，已导入的原片仍保留。请重新连接并选择未完成的照片。"; changed();
    }
    private synchronized CancelToken begin(String message) {
        if (busy) return null;
        busy = true; status = message; token = new CancelToken(); changed(); return token;
    }
    private synchronized void end(CancelToken operation) { if (token == operation) { busy = false; token = null; } changed(); }
    synchronized void cancel() { if (token != null) { token.cancel(); status = "正在取消，已导入的原片会保留…"; changed(); } }
    synchronized void disconnect() {
        if (token != null) token.cancel();
        connected = false; demo = false; session = ""; network = null; thumbnails.clear();
        inventory = new CameraRules.Inventory(new ArrayList<>(), 0, 0, 0);
        status = "已断开连接，已导入的原片仍保留。"; changed();
    }
    void connect(boolean synthetic) {
        CancelToken operation = begin(synthetic ? "正在打开演示照片…" : "正在通过 Wi-Fi 连接相机…"); if (operation == null) return;
        synchronized (this) { connected = false; demo = synthetic; session = ""; network = null; thumbnails.clear(); inventory = new CameraRules.Inventory(new ArrayList<>(), 0, 0, 0); }
        worker.execute(() -> {
            boolean identityChecked = false;
            try {
                CameraRules.Inventory result;
                Network wifi = null;
                if (synthetic) result = demoInventory();
                else {
                    wifi = transport.joinedWifi();
                    synchronized (this) { network = wifi; }
                    CameraRules.requireModel(transport.json(wifi, "/v1/props", operation)); identityChecked = true;
                    synchronized (this) { status = "已识别 GR III，正在读取照片…"; } changed();
                    result = CameraRules.inventory(transport.json(wifi, "/v1/photos", operation));
                }
                operation.check();
                synchronized (this) {
                    operation.check(); inventory = result; network = wifi; session = UUID.randomUUID().toString(); connected = true;
                    status = synthetic ? "演示模式 · 使用生成的图片" : "已连接 RICOH GR III · Wi-Fi 直连";
                    if (result.photos.isEmpty()) status += result.raw > 0 ? " 当前只有 RAW，请使用读卡器导入。" : " 暂无 JPEG 照片。";
                }
            } catch (Exception e) {
                synchronized (this) { connected = false; network = null; status = (identityChecked ? "已识别 GR III，但未能读取照片列表。" : "") + message(e, operation); }
            } finally { end(operation); }
        });
    }
    void refresh() {
        CancelToken operation; String sourceSession; Network source; boolean synthetic;
        synchronized (this) {
            if (busy || !connected) return;
            sourceSession=session;source=network;synthetic=demo;operation=begin("正在刷新照片列表，已选照片会保留…");
        }
        worker.execute(() -> {
            boolean identityRejected=false;
            try {
                CameraRules.Inventory result;
                if(synthetic)result=demoInventory();
                else {
                    Object properties=transport.json(source,"/v1/props",operation);
                    try { CameraRules.requireModel(properties); } catch(TransferException error) { identityRejected=true;throw error; }
                    result=CameraRules.inventory(transport.json(source,"/v1/photos",operation));
                }
                operation.check();
                synchronized(this) {
                    operation.check();if(!connected||!sourceSession.equals(session)||!Objects.equals(source,network))return;
                    inventory=result;
                    Set<String> available=new HashSet<>();for(CameraRules.Photo photo:result.photos)available.add(photo.key());thumbnails.keySet().retainAll(available);
                    status=(synthetic?"演示照片已刷新":"相机照片已刷新")+" · "+result.photos.size()+" 张 JPEG；仍在列表中的选择已保留。";
                }
                changed();
            } catch(Exception error) {
                synchronized(this) {
                    if(sourceSession.equals(session)) {
                        if(identityRejected){disconnect();status="设备型号发生变化，请重新连接。";}
                        else status="未能刷新，上一份照片列表和选择已保留。"+message(error,operation);
                    }
                }
                changed();
            } finally { end(operation); }
        });
    }
    private CameraRules.Inventory demoInventory() throws IOException {
        String text;
        try (InputStream in = context.getAssets().open("manifest.json")) { ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n; while ((n = in.read(buffer)) != -1) { if (bytes.size() + n > CameraRules.MAX_JSON_BYTES) throw new TransferException("演示照片列表过大。"); bytes.write(buffer, 0, n); } text = bytes.toString("UTF-8"); }
        Object parsed = BoundedJson.parse(text); List<CameraRules.Photo> photos = new ArrayList<>();
        for (Object value : (List<?>) parsed) {
            Map<?,?> p = (Map<?,?>) value;
            photos.add(new CameraRules.Photo((String)p.get("folder"), (String)p.get("name"), (String)p.get("id")));
        }
        return new CameraRules.Inventory(photos, 0, 0, 0);
    }
    void transfer(Collection<String> selected) {
        List<TransferTray.Entry> batch; CancelToken operation;
        synchronized (this) {
            if (!connected || busy) return;
            List<CameraRules.Photo> photos = new ArrayList<>();
            for (CameraRules.Photo photo : inventory.photos) if (selected.contains(photo.key())) photos.add(photo);
            try { batch = tray.admit(session, photos, demo); }
            catch (TransferException e) { status = e.getMessage(); changed(); return; }
            if (batch.isEmpty()) { status = "所选照片已在导入记录中。未完成的照片可点「重试」。"; changed(); return; }
            operation = begin("正在导入所选原片…");
        }
        worker.execute(() -> downloadBatch(batch, operation));
    }
    void retry() {
        List<TransferTray.Entry> batch; CancelToken operation;
        synchronized (this) {
            if (busy || !connected) return;
            batch = tray.retry(session);
            if (batch.isEmpty()) { status = "当前没有可重试的照片。重新连接后请再次选片；每张最多尝试 3 次。"; changed(); return; }
            operation = begin("正在重新导入未完成的原片…");
        }
        worker.execute(() -> downloadBatch(batch, operation));
    }
    // Conservative free-space check: do not request eviction of other apps’ cached data.
    @android.annotation.SuppressLint("UsableSpace")
    private void downloadBatch(List<TransferTray.Entry> batch, CancelToken operation) {
        int ready = 0;
        try {
            for (TransferTray.Entry entry : batch) {
                if (operation.isCancelled()) break;
                File file = null;
                try {
                    long maximum; Network source;
                    synchronized (this) {
                        if (!connected || !entry.session.equals(session)) throw new TransferException("照片来源已改变，请重新连接并再次选片。");
                        maximum = Math.min(CameraRules.MAX_JPEG_BYTES, tray.availableBytes()); source = network;
                        entry.status = TransferTray.Status.TRANSFERRING; entry.attempts++; entry.bytes = 0; entry.expected = -1; entry.message = "正在读取完整原片";
                    }
                    changed(); operation.check();
                    if (maximum <= 0) throw new TransferException("临时空间已满（256 MiB）。请先保存已导入的原片，再重试。");
                    if (staging.getUsableSpace() < Math.min(maximum, 16L * 1024 * 1024)) throw new TransferException("手机存储空间不足，请先保存或清理临时原片，再重试。");
                    file = File.createTempFile("original-", ".jpg", staging);
                    OriginalCopy.Receipt receipt;
                    OriginalCopy.Progress progress = (bytes, expected) -> {
                        synchronized (this) { entry.bytes = bytes; entry.expected = expected; }
                        long now = SystemClock.elapsedRealtime(); if (now - lastProgress > 180) { lastProgress = now; changed(); }
                    };
                    if (entry.demo) {
                        try (InputStream in = context.getAssets().open(entry.photo.asset + ".jpg"); OutputStream out = new FileOutputStream(file)) {
                            receipt = OriginalCopy.copy(in, out, -1, maximum, operation, progress);
                        }
                    } else {
                        try (CameraTransport.Response response = transport.get(source, entry.photo.originalPath(), maximum, operation); OutputStream out = new FileOutputStream(file)) {
                            receipt = OriginalCopy.copy(response.body, out, response.length, maximum, operation, progress);
                        }
                    }
                    operation.check();
                    synchronized (this) {
                        operation.check(); entry.file = file; entry.receipt = receipt; entry.status = TransferTray.Status.READY; entry.message = "原片已导入，等待保存到相册"; ready++;
                    }
                    file = null;
                } catch (Exception e) {
                    synchronized (this) { entry.status = operation.isCancelled() ? TransferTray.Status.CANCELLED : TransferTray.Status.FAILED; entry.message = message(e, operation); }
                } finally { if (file != null) file.delete(); changed(); }
            }
        } finally {
            synchronized (this) {
                for (TransferTray.Entry entry : batch) if (entry.status == TransferTray.Status.QUEUED) { entry.status = TransferTray.Status.CANCELLED; entry.message = "已取消，尚未开始导入"; }
                status = (operation.isCancelled() ? "导入已取消，" : "导入完成，") + ready + " 张原片待保存到相册。";
            }
            end(operation);
        }
    }
    void saveReady() {
        List<TransferTray.Entry> batch = new ArrayList<>(); CancelToken operation;
        synchronized (this) {
            if (busy) return;
            for (TransferTray.Entry entry : tray.all()) if (entry.status == TransferTray.Status.READY) batch.add(entry);
            if (batch.isEmpty()) return;
            operation = begin("正在保存到相册并校验原片…");
        }
        worker.execute(() -> {
            int saved = 0;
            try {
                for (TransferTray.Entry entry : batch) {
                    if (operation.isCancelled()) break;
                    synchronized (this) { entry.status = TransferTray.Status.SAVING; entry.message = "正在写入临时照片"; } changed();
                    try {
                        android.net.Uri uri = saver.save(entry.file, CameraRules.saveName(entry.session, entry.photo, entry.demo), entry.receipt, entry.demo, operation);
                        synchronized (this) { entry.savedUri = uri.toString(); entry.status = TransferTray.Status.SAVED; entry.message = "已保存到相册，原片校验通过"; entry.file.delete(); entry.file = null; saved++; }
                    } catch (Exception e) {
                        synchronized (this) {
                            if (entry.file == null || !entry.file.isFile()) {
                                entry.file = null; entry.receipt = null; entry.status = TransferTray.Status.FAILED;
                                entry.message = "Android 已移除这张临时原片。请重新导入；重新连接后需再次选片。";
                            } else { entry.status = TransferTray.Status.READY; entry.message = "保存未完成，临时原片已保留。" + message(e, operation); }
                        }
                    }
                    changed();
                }
            } finally {
                synchronized (this) { status = saved + " 张原片已保存到相册；相机文件未改变。"; }
                end(operation);
            }
        });
    }
    void loadThumbnails(List<CameraRules.Photo> page) {
        CancelToken operation; String sourceSession; Network source; boolean synthetic;
        synchronized (this) {
            if (busy || !connected) return;
            operation = begin("正在加载本页预览…"); sourceSession = session; source = network; synthetic = demo;
            thumbnails.clear();
        }
        worker.execute(() -> {
            int loaded = 0;
            try {
                for (CameraRules.Photo photo : page) {
                    operation.check(); byte[] bytes;
                    if (synthetic) { try (InputStream in = context.getAssets().open(photo.asset + "-thumb.jpg")) { bytes = smallImage(in, operation); } }
                    else { try (CameraTransport.Response response = transport.get(source, photo.thumbnailPath(), 2 * 1024 * 1024, operation)) { bytes = smallImage(response.body, operation); } }
                    synchronized (this) { if (!sourceSession.equals(session)) break; thumbnails.put(photo.key(), bytes); loaded++; } changed();
                }
                synchronized (this) { status = loaded + " 张预览已加载"; }
            } catch (Exception e) { synchronized (this) { status = "预览加载已停止，仍可按文件名选片导入。" + message(e, operation); } }
            finally { end(operation); }
        });
    }
    private byte[] smallImage(InputStream in, CancelToken token) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
        while ((count = in.read(buffer)) != -1) { token.check(); if (bytes.size() + count > 2 * 1024 * 1024) throw new TransferException("预览图片过大。"); bytes.write(buffer, 0, count); }
        return bytes.toByteArray();
    }
    synchronized void clearSaved() {
        if(busy)return;
        int count=tray.clearSaved();status="已清理 "+count+" 条已保存记录，未保存原片和相册照片均保留。";changed();
    }
    synchronized void clear() { if (busy) return; tray.clear(); status = "导入记录已清空，已保存的照片不受影响。"; changed(); }
    private static String message(Exception error, CancelToken token) {
        if (token.isCancelled()) return "操作已取消，可重新连接或重试。";
        if (error instanceof TransferException) return error.getMessage();
        if (error instanceof java.net.SocketTimeoutException) return "相机响应超时，请保持相机唤醒后重试。";
        return "操作未完成。请检查相机 Wi-Fi 和手机存储空间后重试，已导入的原片会保留。";
    }
}
