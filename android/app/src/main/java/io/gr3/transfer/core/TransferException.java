package io.gr3.transfer.core;
import java.io.IOException;
public final class TransferException extends IOException {
    public TransferException(String message) { super(message); }
}
