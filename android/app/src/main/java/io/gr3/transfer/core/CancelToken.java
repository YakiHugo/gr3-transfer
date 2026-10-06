package io.gr3.transfer.core;
import java.io.InterruptedIOException;
public final class CancelToken {
    private volatile boolean cancelled;
    private Runnable close;
    public synchronized void attach(Runnable close) throws InterruptedIOException {
        check(); this.close = close;
    }
    public synchronized void detach() { close = null; }
    public void cancel() {
        Runnable action;
        synchronized (this) { cancelled = true; action = close; close = null; }
        if (action != null) action.run();
    }
    public boolean isCancelled() { return cancelled; }
    public void check() throws InterruptedIOException {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("操作已取消，已导入的原片会保留，可稍后重试未完成的照片。");
    }
}
