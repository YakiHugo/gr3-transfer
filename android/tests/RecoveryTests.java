package io.gr3.transfer.core;

import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Runs the production file journal and save transaction without Android or a camera. */
public final class RecoveryTests {
    private static int assertions;
    private static final String SESSION = "d2719fc1-f5b3-4b34-93bb-287b250ac9da";
    private static final String URI = "content://media/external_primary/images/media/42";
    private static final byte[] JPEG = {(byte)255,(byte)216,(byte)255,(byte)192,0,11,8,0,1,0,1,1,1,0x11,0,(byte)255,(byte)218,0,8,1,1,0,0,63,0,1,(byte)255,(byte)217};
    private interface Action { void run() throws Exception; }
    private static void check(boolean value, String label) { assertions++; if (!value) throw new AssertionError(label); }
    private static void rejects(Action action, String label) throws Exception { assertions++; try { action.run(); } catch (IOException | IllegalArgumentException expected) { return; } throw new AssertionError(label); }
    private static OriginalCopy.Receipt receipt() throws IOException { return OriginalCopy.inspect(new ByteArrayInputStream(JPEG), JPEG.length, new CancelToken()); }
    private static TransferTray.Entry entry(String name, boolean demo) throws IOException {
        TransferTray.Entry entry = new TransferTray.Entry(SESSION, new CameraRules.Photo("100RICOH", name, null, EnumSet.of(CameraRules.RawFormat.DNG, CameraRules.RawFormat.PEF)), demo);
        entry.attempts = 2; return entry;
    }
    private static TransferTray.Entry complete(StagedOriginals store, String name, boolean demo) throws IOException {
        TransferTray.Entry entry = entry(name, demo); File part = store.createPart();
        try (OutputStream out = store.openPart(part)) { out.write(JPEG); }
        store.complete(entry, part, receipt(), Collections.emptyList()); entry.status = TransferTray.Status.READY; return entry;
    }
    private static StagedOriginals store(Path root, String name) throws IOException { return new StagedOriginals(root.resolve(name).toFile()); }
    private static int rejected(StagedOriginals store) throws IOException {
        int rejected = store.restore().rejected; store.discardUnavailable(); return rejected;
    }
    private static File record(StagedOriginals store, TransferTray.Entry entry) { return new File(store.directory(), entry.stagingId + ".record"); }
    private static void editRecord(File record, String old, String replacement) throws Exception {
        byte[] original = Files.readAllBytes(record.toPath());
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(original))) {
            int magic = in.readInt(), length = in.readInt(); byte[] payload = new byte[length]; in.readFully(payload);
            byte[] from = old.getBytes(java.nio.charset.StandardCharsets.UTF_8), to = replacement.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            if (from.length != to.length) throw new AssertionError("test mutation length");
            int index = -1;
            outer: for (int i=0; i<=payload.length-from.length; i++) { for (int j=0;j<from.length;j++) if(payload[i+j]!=from[j]) continue outer; index=i; break; }
            if(index<0)throw new AssertionError("test mutation absent"); System.arraycopy(to,0,payload,index,to.length);
            try (DataOutputStream out = new DataOutputStream(new FileOutputStream(record))) { out.writeInt(magic); out.writeInt(payload.length); out.write(payload); out.write(MessageDigest.getInstance("SHA-256").digest(payload)); }
        }
    }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gr3-recovery-tests-");
        try {
            StagedOriginals store = store(root, "roundtrip"); TransferTray.Entry source = complete(store, "R1.JPG", true);
            StagedOriginals.Recovery recovered = new StagedOriginals(store.directory()).restore(); TransferTray.Entry entry = recovered.entries.get(0);
            check(recovered.entries.size()==1 && recovered.rejected==0, "completed original restores after new store instance");
            check(entry.recovered && entry.demo && entry.attempts==2 && entry.session.equals(SESSION), "source and demo metadata restored explicitly old");
            check(entry.photo.rawLabel().equals("DNG / PEF") && entry.photo.asset==null, "raw enum labels survive without camera or asset paths");
            check(entry.status==TransferTray.Status.READY && entry.receipt.sha256.equals(receipt().sha256) && Arrays.equals(Files.readAllBytes(entry.file.toPath()),JPEG), "actual JPEG hash length bytes recomputed and saveable");
            TransferTray tray = new TransferTray(); tray.restore(entry); entry.status=TransferTray.Status.FAILED;
            check(tray.retry(SESSION).isEmpty() && !entry.retryable(SESSION), "restored original can never retry even with matching old session");
            entry.status=TransferTray.Status.READY; rejects(()->tray.restore(entry), "duplicate restored key rejected");
            store.rememberSave(entry, URI);
            check(new StagedOriginals(store.directory()).restore().entries.get(0).pendingSaveUri.equals(URI), "exact destination persists before publish");
            check(!entry.retryable(SESSION), "pending result cannot camera retry");
            StagedOriginals failing = new StagedOriginals(store.directory(), () -> { throw new IOException("simulated crash before replace"); });
            rejects(()->failing.resetSave(entry), "atomic replacement failure reported");
            check(new StagedOriginals(store.directory()).restore().entries.get(0).pendingSaveUri.equals(URI), "failed replacement preserves prior exact destination");
            check(!new File(store.directory(),entry.stagingId+".record.part").exists(), "failed transaction cleans scratch record");
            store.resetSave(entry);
            check(new StagedOriginals(store.directory()).restore().entries.get(0).pendingSaveUri==null, "proven absent save may return to explicit saving");
            for(String uri:List.of("content://media/external/images/media/42", "content://media/external_primary/images/media", "content://media/external_primary/images/media/42?evil=1", "file:///etc/passwd", "content://elsewhere/external_primary/images/media/1", URI+"/../1")) rejects(()->store.rememberSave(entry,uri),"reject untrusted destination "+uri);
            check(!StagedOriginals.validSavedUri(null), "null destination not proof of saved image");
            store.forget(entry); check(new StagedOriginals(store.directory()).restore().entries.isEmpty() && !source.file.exists(), "explicit removal cannot resurrect");

            StagedOriginals atomic = store(root,"atomic"); TransferTray.Entry uncommitted = entry("R2.JPG",false); File part=atomic.createPart(); Files.write(part.toPath(),JPEG);
            StagedOriginals interrupted = new StagedOriginals(atomic.directory(), () -> { throw new IOException("interruption"); });
            rejects(()->interrupted.complete(uncommitted,part,receipt(),Collections.emptyList()),"complete fails without journal commit");
            check(atomic.restore().entries.isEmpty() && uncommitted.file==null && uncommitted.receipt==null, "incomplete journal never appears ready");
            File leftover=atomic.createPart(); Files.write(leftover.toPath(),JPEG);
            File orphan=new File(atomic.directory(),UUID.randomUUID()+".jpg");Files.write(orphan.toPath(),JPEG);
            File unfinished=new File(atomic.directory(),UUID.randomUUID()+".record.part");Files.write(unfinished.toPath(),new byte[]{1,2,3});
            check(atomic.restore().entries.isEmpty() && !leftover.exists() && orphan.exists() && !unfinished.exists(), "restart discards only proven partial files and preserves orphan completed bytes");
            check(atomic.unavailableCount()==1&&atomic.usage().bytes==JPEG.length,"orphan completed file remains quarantined and counted");
            atomic.discardUnavailable();check(!orphan.exists(),"explicit clear can remove quarantined original");

            StagedOriginals corrupt = store(root,"corrupt"); TransferTray.Entry corruptEntry=complete(corrupt,"R3.JPG",false);
            byte[] changed=JPEG.clone();changed[changed.length-3]^=1;Files.write(corruptEntry.file.toPath(),changed);
            check(rejected(corrupt)==1 && corrupt.restore().entries.isEmpty(), "structurally valid corrupt hash rejected");
            corruptEntry=complete(corrupt,"R3.JPG",false);Files.write(corruptEntry.file.toPath(),new byte[JPEG.length]);
            check(rejected(corrupt)==1, "invalid actual JPEG rejected despite same length");
            corruptEntry=complete(corrupt,"R3.JPG",false);Files.delete(corruptEntry.file.toPath());
            check(rejected(corrupt)==1,"missing original rejects record");
            corruptEntry=complete(corrupt,"R3.JPG",false);Files.write(corruptEntry.file.toPath(),Arrays.copyOf(JPEG,JPEG.length-1));
            check(rejected(corrupt)==1,"truncated original rejects record");
            corruptEntry=complete(corrupt,"R3.JPG",false);Files.write(record(corrupt,corruptEntry).toPath(),new byte[]{0x47,0x52,0x33,1});
            check(corrupt.restore().rejected==1&&corrupt.restore().entries.isEmpty(),"truncated metadata does not restore original");
            check(Arrays.equals(Files.readAllBytes(corruptEntry.file.toPath()),JPEG)&&corrupt.usage().bytes==JPEG.length,"corrupt metadata preserves intact completed JPEG and physical accounting");
            corrupt.discardUnavailable();check(!corruptEntry.file.exists(),"only explicit discard removes quarantined complete JPEG");
            corruptEntry=complete(corrupt,"R3.JPG",false);byte[] recordBytes=Files.readAllBytes(record(corrupt,corruptEntry).toPath());recordBytes[recordBytes.length-1]^=1;Files.write(record(corrupt,corruptEntry).toPath(),recordBytes);
            check(rejected(corrupt)==1,"metadata checksum protects mode/source/save evidence");
            corruptEntry=complete(corrupt,"R3.JPG",false);editRecord(record(corrupt,corruptEntry),"R3.JPG","../JPG");
            check(rejected(corrupt)==1,"path traversal metadata rejected even with valid record checksum");
            corruptEntry=complete(corrupt,"R3.JPG",false);Files.write(record(corrupt,corruptEntry).toPath(),new byte[4097]);
            check(rejected(corrupt)==1,"oversized metadata rejected before parsing");

            StagedOriginals links=store(root,"links"); TransferTray.Entry linked=complete(links,"R4.JPG",false); Path outside=root.resolve("outside.jpg");Files.write(outside,JPEG);Files.delete(linked.file.toPath());Files.createSymbolicLink(linked.file.toPath(),outside);
            check(rejected(links)==1 && Arrays.equals(Files.readAllBytes(outside),JPEG),"JPEG symlink rejected without modifying target");
            linked=complete(links,"R4.JPG",false);Path outsideRecord=root.resolve("outside.record");Files.copy(record(links,linked).toPath(),outsideRecord);Files.delete(record(links,linked).toPath());Files.createSymbolicLink(record(links,linked).toPath(),outsideRecord);
            check(rejected(links)==1 && Files.exists(outsideRecord),"record symlink rejected without modifying target");
            File linkedPart=links.createPart();Files.delete(linkedPart.toPath());Files.createSymbolicLink(linkedPart.toPath(),outside);
            rejects(()->{try(OutputStream out=links.openPart(linkedPart)){out.write(7);}},"part writes cannot follow a symlink");
            rejects(()->{try(InputStream in=StagedOriginals.openOriginal(linkedPart)){in.read();}},"saving cannot follow a substituted original symlink");
            check(Arrays.equals(Files.readAllBytes(outside),JPEG),"rejected symlink operations preserve external target");
            Path alias=root.resolve("alias");Files.createSymbolicLink(alias,links.directory().toPath());rejects(()->new StagedOriginals(alias.toFile()),"store rejects symlink root");
            TransferTray.Entry escape=entry("R4.JPG",false); rejects(()->links.complete(escape,outside.toFile(),receipt(),List.of()),"complete rejects outside file");
            escape.stagingId="../../outside";rejects(()->links.forget(escape),"forget rejects path escape");

            StagedOriginals limits=store(root,"limits"); List<TransferTray.Entry> retained=new ArrayList<>();
            for(int i=0;i<48;i++)retained.add(complete(limits,"R"+i+".JPG",false));
            check(limits.restore().entries.size()==48,"48 committed originals restore");
            TransferTray.Entry extra=entry("R49.JPG",false);
            rejects(()->limits.createPart(),"49th physical original rejected before streaming");
            String extraId=UUID.randomUUID().toString();
            Files.copy(retained.get(0).file.toPath(),new File(limits.directory(),extraId+".jpg").toPath());
            Files.copy(record(limits,retained.get(0)).toPath(),new File(limits.directory(),extraId+".record").toPath());
            StagedOriginals.Recovery bounded=limits.restore();
            check(bounded.entries.size()==48&&bounded.rejected==1,"49th persisted record never bypasses startup cap");
            check(limits.usage().files==49&&limits.unavailableCount()==1,"over-limit suspect original is preserved and blocks new admission");
            rejects(()->limits.createPart(),"quarantined originals count against item cap");
            for(TransferTray.Entry e:bounded.entries)limits.forget(e);limits.discardUnavailable();
            check(limits.restore().entries.isEmpty()&&limits.usage().files==0,"clear all committed and quarantined entries does not resurrect");
            TransferTray.Entry largeA=entry("A.JPG",false),largeB=entry("B.JPG",false);largeA.file=outside.toFile();largeB.file=outside.toFile();largeA.receipt=new OriginalCopy.Receipt(CameraRules.MAX_JPEG_BYTES,receipt().sha256);largeB.receipt=largeA.receipt;
            File limitedPart=limits.createPart();Files.write(limitedPart.toPath(),JPEG);
            rejects(()->limits.complete(extra,limitedPart,receipt(),List.of(largeA,largeB)),"256 MiB total bound checked before persistence");
            rejects(()->limits.complete(extra,limitedPart,new OriginalCopy.Receipt(CameraRules.MAX_JPEG_BYTES+1,receipt().sha256),List.of()),"128 MiB per-file bound checked before persistence");
            check(Files.exists(limitedPart.toPath()),"rejected limits do not consume incomplete source");

            StagedOriginals removal=store(root,"removal");TransferTray.Entry removed=complete(removal,"R1.JPG",false);File retainedBytes=removed.file;
            StagedOriginals cleanupFailure=new StagedOriginals(removal.directory(),new StagedOriginals.Boundary(){
                public void beforeReplace() { }
                public void beforeDelete(File file)throws IOException {if(file.getName().endsWith(".jpg"))throw new IOException("simulated unlink failure");}
            });
            check(!cleanupFailure.forget(removed)&&removed.file==null&&removed.stagingId==null,"removal commits logically even if original unlink fails");
            check(cleanupFailure.restore().entries.isEmpty()&&retainedBytes.exists()&&cleanupFailure.usage().bytes==JPEG.length,"tombstone blocks resurrection while unlinked bytes remain accounted");
            check(removal.restore().entries.isEmpty()&&!retainedBytes.exists()&&removal.usage().bytes==0,"later startup retries only committed removal cleanup");
            TransferTray.Entry metadataBlocked=complete(removal,"R3.JPG",false);File blockedRecord=record(removal,metadataBlocked);
            StagedOriginals blockedMetadata=new StagedOriginals(removal.directory(),new StagedOriginals.Boundary(){
                public void beforeReplace() { }
                public void beforeDelete(File file)throws IOException {if(file.getName().endsWith(".record"))throw new IOException("metadata unlink failure");}
            });
            check(!blockedMetadata.forget(metadataBlocked)&&blockedRecord.exists(),"tombstone commits even when old metadata cannot unlink");
            check(blockedMetadata.restore().entries.isEmpty(),"stale committed metadata cannot override removal tombstone");
            removal.restore();
            TransferTray.Entry kept=complete(removal,"R2.JPG",false);
            StagedOriginals beforeRemoval=new StagedOriginals(removal.directory(),()->{throw new IOException("before tombstone commit");});
            rejects(()->beforeRemoval.forget(kept),"failed removal commit reports failure");
            check(kept.file.isFile()&&removal.restore().entries.size()==1,"failed removal commit really retains durable original");
            StagedOriginals completionFailure=store(root,"completion-failure");TransferTray.Entry notReady=entry("R1.JPG",false);File incomplete=completionFailure.createPart();Files.write(incomplete.toPath(),JPEG);
            StagedOriginals failedCleanup=new StagedOriginals(completionFailure.directory(),new StagedOriginals.Boundary(){
                public void beforeReplace()throws IOException {throw new IOException("journal write failure");}
                public void beforeDelete(File file)throws IOException {if(file.getName().endsWith(".jpg"))throw new IOException("unlink failure");}
            });
            rejects(()->failedCleanup.complete(notReady,incomplete,receipt(),List.of()),"failed admission and failed cleanup surface failure");
            check(notReady.file==null&&notReady.receipt==null&&notReady.stagingId==null,"failed admission always resets ready state even if cleanup fails");
            check(completionFailure.restore().entries.isEmpty()&&completionFailure.usage().bytes==JPEG.length&&completionFailure.unavailableCount()==1,"failed admission bytes are preserved quarantined and counted");
            System.out.println("PASS "+assertions+" completed-original persistence assertions; production journal, no Android/network");
        } finally { try(java.util.stream.Stream<Path> paths=Files.walk(root)){paths.sorted(Comparator.reverseOrder()).forEach(path->{try{Files.deleteIfExists(path);}catch(IOException error){throw new UncheckedIOException(error);}});} }
    }
}
