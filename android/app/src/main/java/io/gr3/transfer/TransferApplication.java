package io.gr3.transfer;
import android.app.Application;
public final class TransferApplication extends Application {
    TransferController controller;
    @Override public void onCreate() { super.onCreate(); controller = new TransferController(this); }
}
