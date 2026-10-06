package io.gr3.transfer;
import android.net.*;
import io.gr3.transfer.core.*;
import java.io.*;
import java.net.*;
import java.nio.*;
import java.nio.charset.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
/** Only per-connection routing; never changes Wi-Fi or the process/default network. */
final class CameraTransport {
    private final ConnectivityManager connectivity;
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    CameraTransport(ConnectivityManager connectivity) { this.connectivity = connectivity; }
    Network joinedWifi() throws IOException {
        Network selected = null;
        for (Network network : connectivity.getAllNetworks()) {
            if (!isWifi(network)) continue;
            if (selected != null) throw new TransferException("检测到多个 Wi-Fi 网络。请在手机设置中选择相机 Wi-Fi 后重试。");
            selected = network;
        }
        if (selected == null) throw new TransferException("请先在手机设置中连接 GR III Wi-Fi，即使没有互联网也保持连接，然后返回重试。");
        return selected;
    }
    private boolean isWifi(Network network) {
        NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }
    final class Response implements AutoCloseable {
        final HttpURLConnection connection;
        final InputStream body;
        final long length;
        private final CancelToken token;
        private final ScheduledFuture<?> deadline;
        Response(HttpURLConnection connection, InputStream body, long length, CancelToken token, ScheduledFuture<?> deadline) {
            this.connection = connection; this.body = body; this.length = length; this.token = token; this.deadline = deadline;
        }
        public void close() {
            deadline.cancel(false); token.detach();
            try { body.close(); } catch (IOException ignored) {} connection.disconnect();
        }
    }
    Response get(Network network, String path, long maximum, CancelToken token) throws IOException {
        token.check();
        String allowed = CameraRules.allowedUrl(path);
        if (network == null || !isWifi(network)) throw new TransferException("相机 Wi-Fi 已断开，已导入的原片会保留。请重新连接并选择未完成的照片。");
        HttpURLConnection connection = (HttpURLConnection) network.openConnection(new URL(allowed), java.net.Proxy.NO_PROXY);
        connection.setRequestMethod("GET"); connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
        connection.setConnectTimeout(12000); connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Accept", path.equals("/v1/props") || path.equals("/v1/photos") ? "application/json" : "image/jpeg, application/octet-stream");
        token.attach(() -> timer.execute(connection::disconnect));
        AtomicBoolean timedOut = new AtomicBoolean();
        ScheduledFuture<?> deadline = timer.schedule(() -> { timedOut.set(true); connection.disconnect(); }, path.equals("/v1/props") || path.equals("/v1/photos") ? 25 : 180, TimeUnit.SECONDS);
        try {
            int code = connection.getResponseCode(); token.check();
            if (code != 200) throw new TransferException("相机返回 HTTP " + code + "。已拒绝重定向或不完整响应，请保持相机唤醒后重试。");
            String encoding = connection.getHeaderField("Content-Encoding");
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) throw new TransferException("为保护原片，已拒绝经过额外编码的相机响应。");
            long length = CameraRules.contentLength(connection.getHeaderField("Content-Length"), maximum);
            InputStream checked = new FilterInputStream(connection.getInputStream()) {
                @Override public int read(byte[] b, int off, int len) throws IOException {
                    try { return super.read(b, off, len); } catch (IOException e) { token.check(); if (timedOut.get() || e instanceof SocketTimeoutException) throw new TransferException("相机响应超时，请保持相机唤醒后重试。"); throw e; }
                }
            };
            return new Response(connection, checked, length, token, deadline);
        } catch (IOException | RuntimeException e) {
            deadline.cancel(false); token.detach(); connection.disconnect(); token.check();
            if (e instanceof TransferException) throw (TransferException)e;
            if (timedOut.get() || e instanceof SocketTimeoutException) throw new TransferException("相机响应超时，请保持相机唤醒后重试。");
            throw new TransferException("未能读取 GR III。请保持相机唤醒、连接相机 Wi-Fi、关闭其他相机应用后重试；如访问受限，请检查 Android 网络权限。");
        }
    }
    Object json(Network network, String path, CancelToken token) throws IOException {
        try (Response response = get(network, path, CameraRules.MAX_JSON_BYTES, token)) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[16384]; int count;
            while ((count = response.body.read(buffer)) != -1) {
                token.check();
                if (bytes.size() + count > CameraRules.MAX_JSON_BYTES) throw new TransferException("相机响应过大，已停止读取。");
                bytes.write(buffer, 0, count);
            }
            token.check();
            if (response.length >= 0 && bytes.size() != response.length) throw new TransferException("相机响应不完整，请重新连接后重试。");
            try {
                String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
                return BoundedJson.parse(text);
            } catch (CharacterCodingException e) { throw new TransferException("相机响应文字格式无效。"); }
        }
    }
}
