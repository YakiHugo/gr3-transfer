package io.gr3.transfer.core;
import java.util.HashSet;
import java.util.Set;
/** Marker-level validation ported from the desktop validator. Never rewrites bytes. */
public final class JpegValidator {
    private enum State { SOI1, SOI2, PREFIX, MARKER, LENGTH1, LENGTH2, SEGMENT, SCAN, SCAN_MARKER, DONE }
    private State state = State.SOI1;
    private int marker, remaining, length, headerSize;
    private final int[] header = new int[20];
    private boolean frame, scan, entropy;
    private final Set<Integer> components = new HashSet<>();
    private void fail() throws TransferException { throw new TransferException("JPEG 文件不完整或格式有误，请重新导入。"); }
    private void markerCode(int value) throws TransferException {
        if (value == 255) { state = State.MARKER; return; }
        if (value == 217) { if (!frame || !scan || !entropy) fail(); state = State.DONE; return; }
        if (value == 0 || value == 216 || value >= 208 && value <= 215) fail();
        if (value == 1) { state = State.PREFIX; return; }
        marker = value; headerSize = 0; state = State.LENGTH1;
    }
    private void endSegment() throws TransferException {
        if (marker >= 192 && marker <= 207 && marker != 196 && marker != 200 && marker != 204) {
            if (headerSize < 6) fail();
            int count = header[5];
            if (count < 1 || count > 4 || length != 8 + 3 * count || (header[1] << 8 | header[2]) == 0 || (header[3] << 8 | header[4]) == 0) fail();
            components.clear();
            for (int i = 0; i < count; i++) components.add(header[6 + i * 3]);
            if (components.size() != count) fail();
            frame = true;
        }
        if (marker == 218) {
            if (headerSize < 1) fail();
            int count = header[0];
            if (!frame || count < 1 || count > 4 || length != 6 + 2 * count) fail();
            Set<Integer> scanComponents = new HashSet<>();
            for (int i = 0; i < count; i++) {
                int id = header[1 + i * 2];
                if (!components.contains(id)) fail();
                scanComponents.add(id);
            }
            if (scanComponents.size() != count) fail();
            scan = true; state = State.SCAN;
        } else state = State.PREFIX;
    }
    public void push(byte[] bytes, int offset, int count) throws TransferException {
        for (int i = offset; i < offset + count; i++) {
            int b = bytes[i] & 255;
            switch (state) {
                case SOI1: if (b != 255) fail(); state = State.SOI2; break;
                case SOI2: if (b != 216) fail(); state = State.PREFIX; break;
                case PREFIX: if (b != 255) fail(); state = State.MARKER; break;
                case MARKER: markerCode(b); break;
                case LENGTH1: length = b << 8; state = State.LENGTH2; break;
                case LENGTH2: length |= b; remaining = length - 2; if (remaining < 0) fail(); state = State.SEGMENT; if (remaining == 0) endSegment(); break;
                case SEGMENT: if (headerSize < 20) header[headerSize++] = b; if (--remaining == 0) endSegment(); break;
                case SCAN: if (b == 255) state = State.SCAN_MARKER; else entropy = true; break;
                case SCAN_MARKER: if (b == 0 || b >= 208 && b <= 215) { entropy = true; state = State.SCAN; } else if (b != 255) markerCode(b); break;
                case DONE: break; // Preserve vendor trailer; HTTP size is checked independently.
            }
        }
    }
    public void finish() throws TransferException { if (state != State.DONE) fail(); }
}
