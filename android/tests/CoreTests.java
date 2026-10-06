import io.gr3.transfer.core.*;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
public final class CoreTests {
    static int tests;
    static void check(boolean condition,String label) { tests++; if(!condition)throw new AssertionError(label); }
    interface Run { void run() throws Exception; }
    static void rejects(Run action,String label) throws Exception { tests++; try { action.run(); } catch(IOException|IllegalArgumentException expected){return;} throw new AssertionError(label); }
    static String hash(byte[] bytes) throws Exception { StringBuilder out=new StringBuilder(); for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))out.append(String.format("%02x",b&255)); return out.toString(); }
    static final String SESSION="d2719fc1-f5b3-4b34-93bb-287b250ac9da";
    static final byte[] MINIMAL={(byte)255,(byte)216,(byte)255,(byte)192,0,11,8,0,1,0,1,1,1,0x11,0,(byte)255,(byte)218,0,8,1,1,0,0,63,0,1,(byte)255,(byte)217};
    static class FakeStore implements PendingSave.Store {
        final Map<String,byte[]> rows=new HashMap<>(); final Set<String> pending=new HashSet<>(), journal=new HashSet<>();
        int created, published, deleted; String fail=""; boolean corrupt; CancelToken cancelAfterPublish;
        FakeStore(){rows.put("existing-user-photo",new byte[]{7});}
        public String createPending(String name,boolean demo)throws IOException{if(fail.equals("create"))throw new IOException();String id="owned-"+(++created);rows.put(id,new byte[0]);pending.add(id);return id;}
        public void remember(String id)throws IOException{if(fail.equals("remember"))throw new IOException();journal.add(id);}
        public OutputStream openOutput(String id)throws IOException{if(fail.equals("output"))throw new IOException();return new ByteArrayOutputStream(){@Override public void close(){byte[] bytes=toByteArray();if(corrupt)bytes[bytes.length-3]^=1;rows.put(id,bytes);}};}
        public InputStream openInput(String id)throws IOException{if(fail.equals("input"))throw new IOException();return new ByteArrayInputStream(rows.get(id));}
        public void publish(String id)throws IOException{if(fail.equals("publish"))throw new IOException();pending.remove(id);published++;if(cancelAfterPublish!=null)cancelAfterPublish.cancel();}
        public void forget(String id)throws IOException{if(fail.equals("forget"))throw new IOException();journal.remove(id);}
        public void discardPending(String id)throws IOException{if(fail.equals("delete"))throw new IOException();if(!pending.remove(id))throw new AssertionError("Deleted nonpending row");rows.remove(id);deleted++;}
    }
    public static void main(String[] args) throws Exception {
        CameraRules.requireModel(BoundedJson.parse("{\"model\":\" ricoh   gr iii \"}")); check(true,"normalized exact model");
        for(String model:List.of("RICOH GR IIIx","RICOH GR IV","GR III","RICOH GR III STREET",""))rejects(()->CameraRules.requireModel(Map.of("model",model)),"wrong model "+model);
        rejects(()->CameraRules.requireModel(Map.of("model",4)),"nonstring model");
        rejects(()->CameraRules.requireModel(Map.of("model","RICOH GR III","errCode",500)),"camera errCode");
        CameraRules.Inventory inventory=CameraRules.inventory(BoundedJson.parse("{\"dirs\":[{\"name\":\"100RICOH\",\"files\":[\"R1.JPG\",\"R1.JPG\",\"R1.DNG\",\"R2.PEF\",\"VID.MOV\"]},{\"name\":\"101RICOH\",\"files\":[\"R1.JPG\"]}]}"));
        check(inventory.photos.size()==2&&inventory.raw==2&&inventory.other==1&&inventory.duplicate==1,"inventory diagnostics");
        for(String name:List.of("../a.jpg","x?size=thumb.jpg","A.JPG/evil","%2f.JPG","a b.JPG","a\\b.jpg"))rejects(()->new CameraRules.Photo("100RICOH",name),"unsafe filename");
        rejects(()->new CameraRules.Photo("..","R1.JPG"),"unsafe folder");
        rejects(()->CameraRules.inventory(Map.of("dirs",List.of(Map.of("name","100RICOH","files",List.of(1))))),"nonstring listing");
        List<String> tooMany=new ArrayList<>();for(int i=0;i<50001;i++)tooMany.add("R"+i+".JPG");
        rejects(()->CameraRules.inventory(Map.of("dirs",List.of(Map.of("name","100RICOH","files",tooMany)))),"50000 photo cap");
        CameraRules.Photo photo=new CameraRules.Photo("100RICOH","R1.JPG");
        check(CameraRules.allowedUrl(photo.originalPath()).equals("http://192.168.0.1/v1/photos/100RICOH/R1.JPG"),"fixed original URL without size");
        check(CameraRules.allowedUrl(photo.thumbnailPath()).endsWith("?size=thumb"),"explicit thumbnail size");
        for(String path:List.of("https://evil.com","/v1/props?key=secret","/v1/photos/../a.JPG","/v1/photos/100RICOH/R1.JPG?size=view","/v1/commands","/v1/photos/100RICOH/R1.DNG","//evil.com","/v1/photos/100RICOH/R1.JPG#x"))rejects(()->CameraRules.allowedUrl(path),"endpoint allowlist");
        check(CameraRules.contentLength(null,100)==-1&&CameraRules.contentLength("42",100)==42,"length normal");
        for(String value:List.of("-1","5,5","1.0"," 5","1000","9999999999999999999"))rejects(()->CameraRules.contentLength(value,100),"invalid length "+value);
        for(String json:List.of("{\"a\":1,\"a\":2}","[1,]","{\"x\":NaN}","{\"x\":01}","{\"x\":+1}","true true","[\"\\q\"]","{\"a\":1e999}","[\"unclosed]","[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]"))rejects(()->BoundedJson.parse(json),"strict bounded JSON "+json);
        rejects(()->BoundedJson.parse("[\"\\u+ABC\"]"),"reject signed Unicode escape");
        check(((Map<?,?>)BoundedJson.parse("{\"a\":[true,false,null,-1.2e2,\"\\u0041\\n\"]}")).size()==1,"JSON primitive types");
        for(File fixture:new File(args[0]).listFiles((dir,name)->name.endsWith(".jpg"))) {
            byte[] bytes=Files.readAllBytes(fixture.toPath());
            for(int chunk:List.of(1,7,8192)) {
                InputStream in=new ByteArrayInputStream(bytes){@Override public synchronized int read(byte[] b,int off,int len){return super.read(b,off,Math.min(chunk,len));}};
                ByteArrayOutputStream out=new ByteArrayOutputStream();
                OriginalCopy.Receipt receipt=OriginalCopy.copy(in,out,bytes.length,CameraRules.MAX_JPEG_BYTES,new CancelToken(),(b,total)->{});
                check(Arrays.equals(bytes,out.toByteArray())&&receipt.sha256.equals(hash(bytes))&&receipt.bytes==bytes.length,"fixture byte preservation "+fixture.getName()+" chunk "+chunk);
            }
        }
        OriginalCopy.Receipt minimal=OriginalCopy.inspect(new ByteArrayInputStream(MINIMAL),MINIMAL.length,new CancelToken());check(minimal.bytes==MINIMAL.length,"minimal structural JPEG");
        for(int length=0;length<MINIMAL.length;length++){final int n=length;rejects(()->OriginalCopy.inspect(new ByteArrayInputStream(Arrays.copyOf(MINIMAL,n)),n,new CancelToken()),"reject truncated JPEG "+n);}
        // APP1 contains a complete JPEG but is not the outer JPEG's end.
        ByteArrayOutputStream embedded=new ByteArrayOutputStream();embedded.write(new byte[]{(byte)255,(byte)216,(byte)255,(byte)225,0,(byte)(MINIMAL.length+2)});embedded.write(MINIMAL);
        rejects(()->OriginalCopy.inspect(new ByteArrayInputStream(embedded.toByteArray()),-1,new CancelToken()),"embedded EXIF EOI not outer completion");
        byte[] duplicateComponents=MINIMAL.clone();duplicateComponents[20]=2;rejects(()->OriginalCopy.inspect(new ByteArrayInputStream(duplicateComponents),-1,new CancelToken()),"scan references nonexistent component");
        rejects(()->OriginalCopy.inspect(new ByteArrayInputStream(MINIMAL),MINIMAL.length+1,new CancelToken()),"length underflow");
        rejects(()->OriginalCopy.inspect(new ByteArrayInputStream(MINIMAL),MINIMAL.length-1,new CancelToken()),"length overflow");
        rejects(()->OriginalCopy.copy(new ByteArrayInputStream(MINIMAL),new ByteArrayOutputStream(),-1,MINIMAL.length-1,new CancelToken(),(b,t)->{}),"stream maximum");
        CancelToken cancelled=new CancelToken();cancelled.cancel();rejects(()->OriginalCopy.inspect(new ByteArrayInputStream(MINIMAL),-1,cancelled),"pre cancelled");
        CancelToken during=new CancelToken();rejects(()->OriginalCopy.copy(new ByteArrayInputStream(MINIMAL),new ByteArrayOutputStream(),-1,1000,during,(b,t)->during.cancel()),"cancel before finish commit");
        final int[] close={0};CancelToken token=new CancelToken();token.attach(()->close[0]++);token.cancel();token.cancel();check(close[0]==1,"close callback once");
        rejects(()->token.attach(()->{}),"no request attached after cancel");
        TransferTray tray=new TransferTray();TransferTray.Entry entry=tray.admit(SESSION,List.of(photo,photo),false).get(0);
        check(tray.all().size()==1&&tray.admit(SESSION,List.of(photo),false).isEmpty(),"same session duplicate prevention");
        String second="1b8b817d-d19e-4350-969f-5cb63331044a";
        check(tray.admit(second,List.of(photo),false).size()==1,"new session never silently reuses previous original");
        check(tray.admit(SESSION,List.of(new CameraRules.Photo("101RICOH","R1.JPG")),false).size()==1,"folder identity separate");
        entry.status=TransferTray.Status.FAILED;entry.attempts=1;
        check(!entry.retryable(second)&&entry.retryable(SESSION),"retry scoped to current session");
        check(tray.retry(second).isEmpty()&&tray.retry(SESSION).size()==1,"retry only appropriate failed entries");
        entry.status=TransferTray.Status.CANCELLED;entry.attempts=3;check(!entry.retryable(SESSION),"three attempt cap");
        entry.receipt=minimal;entry.file=File.createTempFile("gr3-core-test-",".jpg");entry.status=TransferTray.Status.READY;
        check(tray.hasUnsaved()&&tray.stagedBytes()==MINIMAL.length,"private staging accounting");
        entry.savedUri="content://media/external/images/media/1";entry.status=TransferTray.Status.SAVED;check(!tray.hasUnsaved(),"saved status");
        check(!entry.retryable(SESSION),"completed originals never retried");
        check(CameraRules.saveName(SESSION,photo,false).contains("100RICOH__d2719fc1__R1.JPG"),"unambiguous names");
        check(CameraRules.saveName(SESSION,photo,true).startsWith("DEMO_"),"demo saves unmistakable");
        List<CameraRules.Photo> extra=new ArrayList<>();for(int i=0;i<48;i++)extra.add(new CameraRules.Photo("100RICOH","X"+i+".JPG"));
        rejects(()->tray.admit(SESSION,extra,false),"atomic tray bound");check(tray.all().size()==3,"rejected batch admits none");
        File privateFile=entry.file;tray.clear();check(tray.all().isEmpty()&&!privateFile.exists(),"clear only staged copies");
        FakeStore success=new FakeStore();
        String savedId=PendingSave.save(success,()->new ByteArrayInputStream(MINIMAL),"original.jpg",false,minimal,new CancelToken());
        check(success.published==1&&success.deleted==0&&success.journal.isEmpty()&&Arrays.equals(success.rows.get(savedId),MINIMAL),"save commits exact readback-verified bytes");
        for(String failure:List.of("create","remember","output","input","publish")) {
            FakeStore store=new FakeStore();store.fail=failure;
            rejects(()->PendingSave.save(store,()->new ByteArrayInputStream(MINIMAL),"original.jpg",false,minimal,new CancelToken()),"save failure "+failure);
            check(store.published==0&&store.rows.size()==1&&store.rows.get("existing-user-photo")[0]==7,"failed save removes only its pending row "+failure);
        }
        FakeStore corrupt=new FakeStore();corrupt.corrupt=true;
        rejects(()->PendingSave.save(corrupt,()->new ByteArrayInputStream(MINIMAL),"original.jpg",false,minimal,new CancelToken()),"readback corruption prevents publish");
        check(corrupt.published==0&&corrupt.deleted==1,"corrupt pending bytes deleted");
        byte[] changed=MINIMAL.clone();changed[changed.length-3]=4;
        FakeStore changedSource=new FakeStore();
        rejects(()->PendingSave.save(changedSource,()->new ByteArrayInputStream(changed),"original.jpg",false,minimal,new CancelToken()),"staged original changed rejects save");
        FakeStore decline=new FakeStore();CancelToken declined=new CancelToken();declined.cancel();
        rejects(()->PendingSave.save(decline,()->new ByteArrayInputStream(MINIMAL),"original.jpg",false,minimal,declined),"cancel before save");
        check(decline.created==0,"no pending row before consent / after prior cancellation");
        FakeStore mid=new FakeStore();CancelToken midToken=new CancelToken();
        rejects(()->PendingSave.save(mid,()->new ByteArrayInputStream(MINIMAL){public synchronized int read(byte[] b,int off,int len){int n=super.read(b,off,len);midToken.cancel();return n;}},"original.jpg",false,minimal,midToken),"cancel during copy");
        check(mid.published==0&&mid.deleted==1,"cancelled save cleans pending row");
        FakeStore committed=new FakeStore();committed.cancelAfterPublish=new CancelToken();
        PendingSave.save(committed,()->new ByteArrayInputStream(MINIMAL),"original.jpg",false,minimal,committed.cancelAfterPublish);
        check(committed.published==1&&committed.deleted==0,"cancellation after commit cannot delete saved photo");
        FakeStore journalError=new FakeStore();journalError.fail="forget";
        PendingSave.save(journalError,()->new ByteArrayInputStream(MINIMAL),"original.jpg",false,minimal,new CancelToken());
        check(journalError.published==1&&journalError.deleted==0&&!journalError.journal.isEmpty(),"postpublish journal error preserves media");
        check(Arrays.equals(MINIMAL,new byte[]{(byte)255,(byte)216,(byte)255,(byte)192,0,11,8,0,1,0,1,1,1,0x11,0,(byte)255,(byte)218,0,8,1,1,0,0,63,0,1,(byte)255,(byte)217}),"save attempts never rewrite retained original");
        List<CameraRules.Photo> gallery=List.of(new CameraRules.Photo("100RICOH","R2.JPG"),new CameraRules.Photo("101RICOH","R10.JPG"),new CameraRules.Photo("101RICOH","R1.JPEG"));
        check(GalleryRules.filter(gallery," r10 ").equals(List.of(gallery.get(1))),"gallery filename search is trimmed and case insensitive");
        check(GalleryRules.filter(gallery,"101ricoh").size()==2,"gallery search matches folder");
        check(GalleryRules.filter(gallery,"101RICOH/R1").size()==2,"gallery search supports full source key");
        check(GalleryRules.filter(gallery,"missing").isEmpty(),"gallery search empty result");
        check(GalleryRules.filter(gallery,"  ").equals(gallery)&&gallery.size()==3,"empty search preserves inventory order without mutation");
        Locale priorLocale=Locale.getDefault();try{Locale.setDefault(Locale.forLanguageTag("tr-TR"));check(GalleryRules.filter(gallery,"RICOH").size()==3,"gallery search is locale independent");}finally{Locale.setDefault(priorLocale);}
        check(GalleryRules.folders(gallery).equals(Map.of("100RICOH",1,"101RICOH",2)),"folder filter exposes exact JPEG counts");
        check(GalleryRules.filter(gallery,"","101RICOH").size()==2,"exact folder filtering");
        check(GalleryRules.filter(gallery,"R10","101RICOH").equals(List.of(gallery.get(1))),"folder and query combine");
        check(GalleryRules.filter(gallery,"","101").isEmpty(),"folder filter does not match prefixes");
        check(GalleryRules.filter(gallery,"","missing").isEmpty(),"unknown folder never broadens results");
        check(GalleryRules.folders(List.of()).isEmpty(),"empty inventory folder counts");
        check(GalleryRules.sort(gallery,GalleryRules.SortOrder.NAME_ASC).equals(List.of(gallery.get(2),gallery.get(0),gallery.get(1))),"natural filename order puts R2 before R10");
        check(GalleryRules.sort(gallery,GalleryRules.SortOrder.NAME_DESC).equals(List.of(gallery.get(1),gallery.get(0),gallery.get(2))),"descending filename order");
        check(GalleryRules.sort(gallery,GalleryRules.SortOrder.CAMERA).equals(gallery),"camera sort retains supplied order");
        check(GalleryRules.sort(gallery,GalleryRules.SortOrder.FOLDER_ASC).equals(List.of(gallery.get(0),gallery.get(2),gallery.get(1))),"folder sort uses filename as tie breaker");
        check(GalleryRules.naturalCompare("R9999999999999999999999.JPG","R10000000000000000000000.JPG")<0,"natural sort handles digit runs beyond long range");
        check(GalleryRules.naturalCompare("R2.JPG","R02.JPG")<0&&GalleryRules.naturalCompare("r2.JPG","R2.jpg")==0,"natural sort zero padding and case handling");
        check(GalleryRules.SortOrder.restore("bogus")==GalleryRules.SortOrder.CAMERA&&GalleryRules.SortOrder.restore(null)==GalleryRules.SortOrder.CAMERA,"invalid restored sort falls back safely");
        List<CameraRules.Photo> tied=List.of(new CameraRules.Photo("101RICOH","R1.JPG"),new CameraRules.Photo("100RICOH","R1.JPG"));
        check(GalleryRules.sort(tied,GalleryRules.SortOrder.NAME_ASC).get(0).folder.equals("100RICOH"),"same filename sorts deterministically by folder");
        check(gallery.get(0).name.equals("R2.JPG"),"sorting never mutates source inventory");
        Set<String> selectedGallery=new LinkedHashSet<>(List.of(gallery.get(1).key()));
        check(GalleryRules.selected(gallery,selectedGallery,true).equals(List.of(gallery.get(1))),"selected-only gallery shows exact selected source keys");
        check(GalleryRules.selected(gallery,selectedGallery,false).equals(gallery),"leaving selected-only view restores all matches");
        check(GalleryRules.selected(gallery,Set.of(),true).isEmpty(),"selected-only empty selection");
        check(GalleryRules.selectedCount(gallery,selectedGallery)==1&&GalleryRules.selectedCount(List.of(gallery.get(0)),selectedGallery)==0,"selection counts identify hidden selected photos");
        check(GalleryRules.selected(tied,Set.of(tied.get(0).key()),true).equals(List.of(tied.get(0))),"selected-only distinguishes same filenames in separate folders");
        check(selectedGallery.size()==1&&gallery.size()==3,"selected-only filter leaves selection and inventory untouched");
        GalleryRules.SelectionChange inverted=GalleryRules.changeSelection(Set.of(gallery.get(0).key(),"hidden/key.JPG"),gallery,GalleryRules.SelectionAction.INVERT);
        check(inverted.keys.equals(Set.of("hidden/key.JPG",gallery.get(1).key(),gallery.get(2).key())),"page inversion preserves hidden choices and flips visible ones");
        Set<String> nearLimit=new LinkedHashSet<>();for(int i=0;i<47;i++)nearLimit.add("100RICOH/X"+i+".JPG");
        GalleryRules.SelectionChange limited=GalleryRules.changeSelection(nearLimit,gallery,GalleryRules.SelectionAction.SELECT);
        check(limited.keys.size()==48&&limited.omitted==2,"page selection enforces 48-photo bound and reports omissions");
        Set<String> full=new LinkedHashSet<>(nearLimit);full.add(gallery.get(2).key());
        GalleryRules.SelectionChange freesFirst=GalleryRules.changeSelection(full,gallery,GalleryRules.SelectionAction.INVERT);
        check(freesFirst.keys.size()==48&&freesFirst.keys.contains(gallery.get(0).key())&&!freesFirst.keys.contains(gallery.get(2).key())&&freesFirst.omitted==1,"inversion frees selected slots before admitting new choices");
        check(GalleryRules.changeSelection(full,gallery,GalleryRules.SelectionAction.DESELECT).keys.equals(nearLimit),"deselect page preserves off-page selection");
        check(GalleryRules.changeSelection(full,List.of(),GalleryRules.SelectionAction.CLEAR).keys.isEmpty(),"clear selection spans all pages");
        check(GalleryRules.changeSelection(Set.of(),List.of(gallery.get(0),gallery.get(0)),GalleryRules.SelectionAction.INVERT).keys.size()==1,"duplicate page key toggles only once");
        check(full.size()==48&&nearLimit.size()==47,"selection operations do not mutate source selection");
        check(GalleryRules.reconcileSelection(new LinkedHashSet<>(List.of(gallery.get(1).key(),"removed/R3.JPG",gallery.get(0).key())),gallery).equals(new LinkedHashSet<>(List.of(gallery.get(1).key(),gallery.get(0).key()))),"refresh retains available selected keys and removes missing photos");
        check(GalleryRules.reconcileSelection(selectedGallery,List.of()).isEmpty(),"empty refresh clears unavailable selection");
        check(GalleryRules.reconcileSelection(Set.of(tied.get(0).key()),List.of(tied.get(1))).isEmpty(),"refresh never remaps a selection across folders");
        check(new ArrayList<>(GalleryRules.reconcileSelection(new LinkedHashSet<>(List.of(gallery.get(1).key(),gallery.get(0).key())),gallery)).equals(List.of(gallery.get(1).key(),gallery.get(0).key())),"refresh preserves selection admission order");
        TransferTray mixedTray=new TransferTray();List<TransferTray.Entry> mixed=mixedTray.admit(SESSION,gallery,false);
        mixed.get(0).status=TransferTray.Status.SAVED;mixed.get(0).savedUri="content://saved/known";mixed.get(0).receipt=minimal;
        mixed.get(1).status=TransferTray.Status.READY;mixed.get(1).receipt=minimal;mixed.get(1).file=File.createTempFile("gr3-keep-unsaved-",".jpg");
        mixed.get(2).status=TransferTray.Status.CANCELLED;
        check(mixedTray.clearSaved()==1&&mixedTray.all().size()==2,"clear saved removes only confirmed saved records");
        check(mixedTray.hasUnsaved()&&mixed.get(1).file.exists()&&mixedTray.stagedBytes()==MINIMAL.length,"clear saved preserves unsaved original and staging accounting");
        check(mixedTray.all().contains(mixed.get(2)),"clear saved preserves failed and cancelled records");
        check(mixedTray.clearSaved()==0,"repeated clear saved is idempotent");
        mixed.get(2).status=TransferTray.Status.SAVED;check(mixedTray.clearSaved()==0,"status without published URI is not discarded as saved");
        check(mixedTray.admit(SESSION,List.of(gallery.get(0)),false).size()==1,"clearing saved record frees its tray slot");mixedTray.clear();
        System.out.println("PASS "+tests+" native Android core assertions; no camera/network/device contacted");
    }
}
