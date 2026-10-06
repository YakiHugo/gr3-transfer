package io.gr3.transfer;
import android.app.*;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.os.*;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.*;
import io.gr3.transfer.core.*;
import java.io.*;
import java.util.*;
/** Dependency-free device/emulator instrumentation. Uses synthetic fixtures only. */
public final class NativeSmokeInstrumentation extends Instrumentation {
    private MainActivity activity;
    private TransferController controller;
    private int assertions;
    private String phase = "smoke";
    private final List<String> createdMedia = new ArrayList<>();
    @Override public void onCreate(Bundle args) { super.onCreate(args); if(args!=null)phase=args.getString("phase","smoke"); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            // Connect accessibility before showing dialogs; late attachment on API 29
            // can leave the first dialog absent from the active-window lookup.
            android.accessibilityservice.AccessibilityServiceInfo service=getUiAutomation().getServiceInfo();
            service.flags|=android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            getUiAutomation().setServiceInfo(service);
            activity = (MainActivity) startActivitySync(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            controller = ((TransferApplication) activity.getApplication()).controller;
            waitForIdleSync(); awaitIdle();
            if(!phase.equals("smoke")) {
                if(phase.equals("tools")||phase.equals("layout")||phase.equals("prepare-death")){runOnMainSync(()->controller.connect(true));awaitIdle();}
                if(phase.equals("tools"))verifyGalleryTools();else if(phase.equals("layout"))verifyLayout();else if(phase.equals("prepare-death"))prepareProcessDeath();else if(phase.equals("verify-death"))verifyProcessDeath();else if(phase.equals("verify-death-cleared"))verifyProcessDeathCleared();else throw new AssertionError("Unknown phase");
                result.putString("stream","PASS "+assertions+" Android process-lifecycle assertions: "+phase+"\n");finish(Activity.RESULT_OK,result);return;
            }
            screenshot("01-onboarding");
            check(!controller.connected, "starts disconnected");
            runOnMainSync(()->{
                View root=activity.getWindow().getDecorView();
                check(find(root,"把原片带回手机")!=null&&find(root,"连接 GR III")!=null,"onboarding primary actions are Chinese");
                check(find(root,"导入记录（0）")==null,"empty disconnected onboarding hides tabs");
                check(!collectText(root).contains("SHA-256"),"onboarding keeps diagnostics secondary");
            });
            click("试用演示照片"); awaitIdle();
            synchronized(controller) { check(controller.demo && controller.connected && controller.inventory.photos.size()==12,"synthetic demo connects with twelve fixtures"); }
            runOnMainSync(()->check(find(activity.getWindow().getDecorView(),"照片").isSelected(),"Camera tab has selected accessibility state"));
            String selectedSource=controller.session;click("更多");clickDialog("取消");
            check(controller.connected&&selectedSource.equals(controller.session),"dismissing connection options preserves source");
            click("加载预览"); awaitIdle();
            synchronized(controller) { check(controller.thumbnails.size()==12,"native thumbnail reads"); }
            runOnMainSync(()->{
                check(find(activity.getWindow().getDecorView(),"上一页")==null&&find(activity.getWindow().getDecorView(),"下一页")==null,"single-page gallery hides page navigation");
                ImageView first=firstImage(activity.getWindow().getDecorView());android.graphics.Rect visible=new android.graphics.Rect();
                check(first!=null&&first.getGlobalVisibleRect(visible)&&visible.height()>=140,"first thumbnail is visible above the fold");
            });
            screenshot("02-demo-gallery");
            click("全选本页");
            runOnMainSync(()->{
                View action=find(activity.getWindow().getDecorView(),"导入原片（12）");
                android.graphics.Rect visible=new android.graphics.Rect();
                check(action!=null&&action.getGlobalVisibleRect(visible)&&visible.height()>=48,"import action stays visible outside scrolling gallery");
                check(!insideScroll(action),"primary import action is docked outside scroll view");
            });
            click("取消本页全选");
            runOnMainSync(()->check(find(activity.getWindow().getDecorView(),"选择要导入的照片")!=null,"deselect page restores empty primary action"));
            click("全选本页");
            click("导入原片（12）"); awaitIdle();
            synchronized(controller) { check(controller.entries().size()==12,"all selected originals enter tray"); for(TransferTray.Entry e:controller.entries())check(e.status==TransferTray.Status.READY&&e.receipt!=null,"validated original ready"); }
            runOnMainSync(()->check(find(activity.getWindow().getDecorView(),"导入记录（12）").isSelected(),"Transfers tab has selected accessibility state"));
            runOnMainSync(()->{
                String text=collectText(activity.getWindow().getDecorView());
                check(text.contains("原片已就绪")&&text.contains("重启会重新校验并恢复"),"ready originals have explicit unsaved warning");
                check(!text.contains("SHA-256")&&!text.contains("source "),"ready list hides hashes and source diagnostics");
            });
            click("详情");
            check(dialogContains("SHA-256"),"hash is available in secondary Chinese details");
            clickDialog("关闭");
            screenshot("03-ready-originals");
            check(getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK),Build.VERSION.SDK_INT>=33?"native predictive-back action":"legacy native-back action");
            clickDialog("继续使用");
            check(!activity.isFinishing(),"unsaved-original back warning retains activity");
            click("保存到相册（12）");
            check(dialogContains("云备份")&&dialogContains("EXIF")&&dialogContains("不会覆盖"),"Chinese save confirmation discloses metadata, backup and existing-photo protection");
            clickDialog("取消");
            synchronized(controller) { check(controller.entries().stream().allMatch(e->e.status==TransferTray.Status.READY&&e.savedUri==null),"declined save retains ready originals"); }
            click("保存到相册（12）"); clickDialog("确认保存"); awaitIdle();
            synchronized(controller) {
                for(TransferTray.Entry e:controller.entries()) {
                    check(e.status==TransferTray.Status.SAVED&&e.savedUri!=null,"actual MediaStore save publishes");createdMedia.add(e.savedUri);
                    try(InputStream in=getTargetContext().getContentResolver().openInputStream(android.net.Uri.parse(e.savedUri))) {
                        OriginalCopy.Receipt read=OriginalCopy.inspect(in,e.receipt.bytes,new CancelToken());check(read.sha256.equals(e.receipt.sha256),"actual saved original readback hash");
                    }
                }
            }
            runOnMainSync(()->{
                String text=collectText(activity.getWindow().getDecorView());
                check(text.contains("已保存到相册")&&text.contains("12 张原片"),"save completion is explicit in Chinese");
                check(!text.contains("SHA-256")&&find(activity.getWindow().getDecorView(),"继续选片")!=null,"saved screen remains concise with a clear next action");
            });
            screenshot("04-saved-pictures");
            // Rotation recreates the Activity but not the Application's retained tray.
            ActivityMonitor monitor=addMonitor(MainActivity.class.getName(),null,false);
            runOnMainSync(()->activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            Activity rotated=waitForMonitorWithTimeout(monitor,60000);removeMonitor(monitor);
            check(rotated!=null&&rotated!=activity,"rotation recreates the native Activity");
            activity=(MainActivity)rotated;
            waitForIdleSync();
            synchronized(controller){check(controller.entries().size()==12&&controller.entries().stream().allMatch(e->e.savedUri!=null),"rotation retains completed tray");}
            screenshot("05-rotated-tray");
            runOnMainSync(()->{controller.clear();controller.connect(true);});awaitIdle();
            Set<String> keys=new LinkedHashSet<>();synchronized(controller){for(CameraRules.Photo photo:controller.inventory.photos)keys.add(photo.key());}
            runOnMainSync(()->{controller.transfer(keys);controller.cancel();});awaitIdle();
            synchronized(controller){check(controller.entries().stream().noneMatch(e->e.status==TransferTray.Status.QUEUED||e.status==TransferTray.Status.TRANSFERRING),"cancel settles queue");}
            runOnMainSync(controller::retry);awaitIdle();
            synchronized(controller){check(controller.entries().stream().allMatch(e->e.status==TransferTray.Status.READY),"manual retry recovers unfinished synthetic originals");}
            runOnMainSync(controller::disconnect);waitForIdleSync();
            synchronized(controller){check(!controller.connected&&controller.entries().stream().allMatch(e->e.status==TransferTray.Status.READY),"disconnect retains ready originals");}
            click("更多");clickDialog("清空导入记录");clickDialog("保留原片");
            synchronized(controller){check(controller.hasUnsaved(),"declined clear preserves private originals");}
            click("更多");clickDialog("清空导入记录");clickDialog("清除临时副本");waitForIdleSync();
            synchronized(controller){check(controller.entries().isEmpty(),"clear removes only private tray");}
            cleanupCreatedMedia();
            result.putString("stream","PASS "+assertions+" native Android API/UI assertions. Synthetic demo only; no physical camera contacted.\n");
            result.putInt("assertions",assertions);finish(Activity.RESULT_OK,result);
        } catch(Throwable failure) {
            try{screenshot("failure");}catch(Exception ignored){}
            cleanupCreatedMedia();
            result.putString("stream","FAIL after "+assertions+" assertions: "+failure+"\n"+android.util.Log.getStackTraceString(failure));finish(Activity.RESULT_CANCELED,result);
        } finally {
            cleanupCreatedMedia();
        }
    }
    private void verifyGalleryTools()throws Exception {
        screenshot("07-tools-connected");
        String source=controller.session;CameraRules.Photo first=controller.inventory.photos.get(0);click(first.name);
        click("更多");clickDialog("筛选与排序");setDialogText("R0000002");clickDialog("应用");
        runOnMainSync(()->{
            View root=activity.getWindow().getDecorView();check(find(root,"R0000002.JPG")!=null&&find(root,first.name)==null,"filename search renders matching card only");
            check(find(root,"导入原片（1）")!=null&&collectText(root).contains("另有 1 张已选"),"hidden selection remains disclosed and importable");
        });
        click("更多");clickDialog("筛选与排序");setDialogText("missing");clickDialog("取消");
        runOnMainSync(()->check(find(activity.getWindow().getDecorView(),"R0000002.JPG")!=null,"cancelled filter edit leaves active search unchanged"));
        click("更多");clickDialog("筛选与排序");clickDialog("清除筛选");
        click("更多");clickDialog("筛选与排序");clickDialog("全部文件夹（12）");clickDialog("101RICOH（6）");clickDialog("相机列表顺序");clickDialog("文件名：从大到小");clickDialog("应用");
        runOnMainSync(()->{
            List<CheckBox> boxes=photoChecks(activity.getWindow().getDecorView());check(boxes.size()==6&&boxes.get(0).getText().toString().equals("R0000012.JPG"),"folder and descending filename sort combine in rendered gallery");
        });
        ActivityMonitor filterRotation=addMonitor(MainActivity.class.getName(),null,false);runOnMainSync(()->activity.recreate());
        Activity restored=waitForMonitorWithTimeout(filterRotation,60000);removeMonitor(filterRotation);check(restored!=null,"filtered activity recreates");activity=(MainActivity)restored;waitForIdleSync();
        runOnMainSync(()->check(photoChecks(activity.getWindow().getDecorView()).size()==6&&find(activity.getWindow().getDecorView(),"导入原片（1）")!=null,"recreation preserves folder sort and hidden selection"));
        click("更多");clickDialog("筛选与排序");clickDialog("仅看已选照片");clickDialog("应用");
        runOnMainSync(()->check(photoChecks(activity.getWindow().getDecorView()).isEmpty()&&find(activity.getWindow().getDecorView(),"导入原片（1）")!=null,"zero filtered matches retain selected import action"));
        click("更多");clickDialog("筛选与排序");clickDialog("清除筛选");
        click("更多");clickDialog("筛选与排序");clickDialog("仅看已选照片");clickDialog("应用");
        runOnMainSync(()->check(photoChecks(activity.getWindow().getDecorView()).size()==1,"selected-only view shows selected card"));
        click(first.name);runOnMainSync(()->check(photoChecks(activity.getWindow().getDecorView()).isEmpty(),"deselecting last selected-only card renders empty state"));
        click("更多");clickDialog("筛选与排序");clickDialog("清除筛选");click(first.name);
        click("更多");clickDialog("刷新演示照片");awaitIdle();
        synchronized(controller){check(controller.connected&&controller.demo&&source.equals(controller.session),"demo refresh preserves source mode and session");check(controller.inventory.photos.size()==12,"demo refresh returns complete inventory");}
        runOnMainSync(()->check(find(activity.getWindow().getDecorView(),"导入原片（1）")!=null,"refresh preserves selected source key"));
        click("更多");clickDialog("反选本页照片");
        runOnMainSync(()->check(find(activity.getWindow().getDecorView(),"导入原片（11）")!=null,"page inversion flips current twelve-photo page"));
        click("更多");clickDialog("清除全部选择（11）");
        runOnMainSync(()->check(find(activity.getWindow().getDecorView(),"选择要导入的照片")!=null,"clear selection updates docked action"));
        runOnMainSync(()->{controller.refresh();controller.cancel();});awaitIdle();
        synchronized(controller){check(controller.connected&&controller.demo&&source.equals(controller.session)&&controller.inventory.photos.size()==12,"cancelled refresh retains connected inventory");}
        runOnMainSync(()->{
            synchronized(controller){
                List<CameraRules.Photo> paired=new ArrayList<>(controller.inventory.photos);try{paired.set(0,new CameraRules.Photo(first.folder,first.name,first.asset,Collections.singleton(CameraRules.RawFormat.DNG)));}catch(IOException error){throw new AssertionError(error);}
                controller.inventory=new CameraRules.Inventory(paired,1,0,0);
            }
        });click("照片");
        runOnMainSync(()->check(collectText(activity.getWindow().getDecorView()).contains("JPEG + DNG · 仅导入 JPEG"),"paired RAW badge clearly limits transfer to JPEG"));
        click(first.name);click("导入原片（1）");awaitIdle();
        TransferTray.Entry entry=controller.entries().get(0);File cached=entry.file;
        click("详情");check(dialogContains("同文件夹 RAW：DNG")&&dialogContains("不会读取或导入 RAW"),"entry details retain enum-only RAW pairing disclosure");clickDialog("移除记录");clickDialog("保留原片");
        synchronized(controller){check(controller.entries().size()==1&&cached.exists(),"declined individual removal retains original");}
        click("详情");clickDialog("移除记录");clickDialog("移除临时副本");waitForIdleSync();
        synchronized(controller){check(controller.entries().isEmpty()&&!cached.exists(),"confirmed individual removal clears only selected original");}
        List<CameraRules.Photo> photos=controller.inventory.photos;Set<String> two=new HashSet<>(Arrays.asList(photos.get(0).key(),photos.get(1).key()));
        runOnMainSync(()->{synchronized(controller){controller.transfer(two);controller.cancel();}});awaitIdle();
        click("重试这张");awaitIdle();
        synchronized(controller){check(controller.entries().get(0).status==TransferTray.Status.READY&&controller.entries().get(1).status==TransferTray.Status.CANCELLED,"individual retry leaves other cancelled item untouched");}
        runOnMainSync(()->{synchronized(controller){controller.retry(controller.entries().get(1).key);check(controller.remove(controller.entries().get(0).key,true)==TransferTray.RemoveResult.BUSY,"controller prevents removal while another original is transferring");}});awaitIdle();
        click("保存到相册（2）");clickDialog("确认保存");awaitIdle();
        synchronized(controller){for(TransferTray.Entry saved:controller.entries()){check(saved.status==TransferTray.Status.SAVED&&saved.savedUri!=null,"retry originals save successfully");createdMedia.add(saved.savedUri);}}
        runOnMainSync(()->controller.transfer(Collections.singleton(photos.get(2).key())));awaitIdle();
        File unsaved=controller.entries().get(2).file;
        click("更多");clickDialog("清理已保存记录（2）");waitForIdleSync();
        synchronized(controller){check(controller.entries().size()==1&&controller.hasUnsaved()&&unsaved.exists(),"clear-saved UI preserves unsaved original in mixed tray");}
        for(String uri:createdMedia)try(InputStream in=getTargetContext().getContentResolver().openInputStream(android.net.Uri.parse(uri))){check(OriginalCopy.inspect(in,-1,new CancelToken()).bytes>0,"clear-saved retains published MediaStore original");}
        runOnMainSync(controller::clear);cleanupCreatedMedia();screenshot("07-gallery-tools");
    }
    private void verifyLayout()throws Exception {
        runOnMainSync(()->controller.loadThumbnails(controller.inventory.photos));awaitIdle();
        CameraRules.Photo first=controller.inventory.photos.get(0);
        click(first.name);
        runOnMainSync(()->{
            View root=activity.getWindow().getDecorView(),action=find(root,"导入原片（1）");
            android.graphics.Rect rect=new android.graphics.Rect();
            check(action!=null&&action.getGlobalVisibleRect(rect)&&rect.height()>=48,"layout keeps selected import action fully visible");
            check(!insideScroll(action),"layout primary action is independent of scroll");
            check(find(root,"照片").isSelected(),"layout preserves selected tab state");
            View label=find(root,first.name);
            boolean grid=activity.getResources().getConfiguration().screenWidthDp>=360&&activity.getResources().getConfiguration().fontScale<=1.15f;
            check(grid?label.getWidth()<root.getWidth()/2:label.getWidth()>root.getWidth()/2,"gallery columns adapt to screen width and font size");
            check(!collectText(root).contains("SHA-256"),"layout leaves technical diagnostics secondary");
        });
        screenshot("06-gallery-"+activity.getResources().getConfiguration().screenWidthDp+"dp-font-"+activity.getResources().getConfiguration().fontScale);
    }
    private void cleanupCreatedMedia() {
        // Only synthetic rows created by this run; called before finish can terminate the process.
        for(String uri:createdMedia)try{getTargetContext().getContentResolver().delete(android.net.Uri.parse(uri),null,null);}catch(Exception ignored){}
        createdMedia.clear();
    }
    private File processMetadata() { return new File(getTargetContext().getFilesDir(),"process-test.json"); }
    private org.json.JSONObject readProcessMetadata() throws Exception {
        try(InputStream in=new FileInputStream(processMetadata())) {
            ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[4096];int n;
            while((n=in.read(b))!=-1)out.write(b,0,n);
            return new org.json.JSONObject(out.toString("UTF-8"));
        }
    }
    private void writeProcessMetadata(org.json.JSONObject metadata) throws Exception {
        try(OutputStream out=new FileOutputStream(processMetadata())) {out.write(metadata.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
    }
    private StagedOriginals originals() throws IOException {return new StagedOriginals(new File(getTargetContext().getNoBackupFilesDir(),"originals"));}
    private void prepareProcessDeath() throws Exception {
        runOnMainSync(controller::clear);
        Set<String> selected=new LinkedHashSet<>();for(int i=0;i<6;i++)selected.add(controller.inventory.photos.get(i).key());
        runOnMainSync(()->controller.transfer(selected));awaitIdle();
        List<TransferTray.Entry> entries=controller.entries();check(entries.size()==6&&entries.stream().allMatch(e->e.status==TransferTray.Status.READY),"prepare six durably completed synthetic originals");
        TransferTray.Entry published=entries.get(0),interrupted=entries.get(1),ready=entries.get(2),removed=entries.get(3),unconfirmed=entries.get(4),quarantined=entries.get(5);
        StagedOriginals originals=originals();
        // Model the actual crash boundary: provider has published, controller has not cleared its staged record.
        android.net.Uri saved=new MediaSaver(getTargetContext()).save(published.file,"DEMO_process_death_saved.JPG",published.receipt,true,new CancelToken(),id->originals.rememberSave(published,id));
        // A recorded row whose bytes no longer match must remain blocked, never inferred saved by name.
        check(!unconfirmed.receipt.sha256.equals(published.receipt.sha256),"uncertain-save fixture has distinct original bytes");
        originals.rememberSave(unconfirmed,saved.toString());
        try(OutputStream out=new FileOutputStream(new File(originals.directory(),quarantined.stagingId+".record"))){out.write(new byte[]{1,2,3});}
        android.content.ContentValues values=new android.content.ContentValues();values.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME,"DEMO_process_death_pending.JPG");values.put(android.provider.MediaStore.Images.Media.MIME_TYPE,"image/jpeg");values.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH,"Pictures/GR III Transfer Demo");values.put(android.provider.MediaStore.Images.Media.IS_PENDING,1);
        android.net.Uri pending=getTargetContext().getContentResolver().insert(android.provider.MediaStore.Images.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY),values);check(pending!=null,"prepare app-owned interrupted pending row");
        originals.rememberSave(interrupted,pending.toString());
        Set<String> journal=new HashSet<>();journal.add(pending.toString());journal.add(saved.toString());
        check(getTargetContext().getSharedPreferences("pending-saves",0).edit().putStringSet("uris",journal).commit(),"simulate pending cleanup journal including already-published URI");
        runOnMainSync(()->check(controller.remove(removed.key,true)==TransferTray.RemoveResult.REMOVED,"explicitly removed original committed before process death"));
        File part=originals.createPart();try(OutputStream out=originals.openPart(part)){out.write(new byte[]{1,2,3});}
        File legacyDir=new File(getTargetContext().getCacheDir(),"originals");legacyDir.mkdirs();
        File orphan=new File(legacyDir,"orphan-process-test.jpg");try(OutputStream out=new FileOutputStream(orphan)){out.write(new byte[]{1,2,3});}
        org.json.JSONObject metadata=new org.json.JSONObject();metadata.put("saved",saved.toString());metadata.put("pending",pending.toString());metadata.put("savedHash",published.receipt.sha256);metadata.put("savedBytes",published.receipt.bytes);
        metadata.put("readyKey",ready.key);metadata.put("readyHash",ready.receipt.sha256);metadata.put("readyBytes",ready.receipt.bytes);metadata.put("removedKey",removed.key);metadata.put("part",part.getName());metadata.put("publishedKey",published.key);metadata.put("interruptedKey",interrupted.key);metadata.put("unconfirmedKey",unconfirmed.key);metadata.put("quarantinedFile",quarantined.file.getName());metadata.put("quarantinedHash",quarantined.receipt.sha256);metadata.put("quarantinedBytes",quarantined.receipt.bytes);
        writeProcessMetadata(metadata);check(part.isFile()&&orphan.isFile(),"prepare unfinished private part and legacy cache orphan");
    }
    private void verifyProcessDeath() throws Exception {
        org.json.JSONObject metadata=readProcessMetadata();android.net.Uri saved=android.net.Uri.parse(metadata.getString("saved")),pending=android.net.Uri.parse(metadata.getString("pending"));
        check(!controller.connected&&controller.session.isEmpty()&&controller.inventory.photos.isEmpty(),"restart does not connect or read old camera session");
        List<TransferTray.Entry> entries=controller.entries();check(entries.size()==4&&entries.stream().allMatch(e->e.recovered&&e.demo),"restart restores only completed synthetic entries with old-source mode");
        check(entries.stream().noneMatch(e->e.key.equals(metadata.optString("removedKey"))),"explicitly removed original does not resurrect");
        File quarantinedFile=new File(originals().directory(),metadata.getString("quarantinedFile"));
        try(InputStream in=new FileInputStream(quarantinedFile)){check(OriginalCopy.inspect(in,metadata.getLong("quarantinedBytes"),new CancelToken()).sha256.equals(metadata.getString("quarantinedHash")),"corrupt metadata preserves completed original bytes without restoring unsafe record");}
        check(controller.status.contains("隔离")&&controller.stagedBytes()>=quarantinedFile.length(),"quarantined original is disclosed and counted in physical storage");
        TransferTray.Entry ready=entries.stream().filter(e->e.key.equals(metadata.optString("readyKey"))).findFirst().orElseThrow(()->new AssertionError("missing ready original"));
        check(ready.status==TransferTray.Status.READY&&ready.receipt.sha256.equals(metadata.getString("readyHash"))&&ready.receipt.bytes==metadata.getLong("readyBytes"),"completed original restores saveable with unchanged actual hash and length");
        try(InputStream in=new FileInputStream(ready.file)){check(OriginalCopy.inspect(in,ready.receipt.bytes,new CancelToken()).sha256.equals(ready.receipt.sha256),"recovered file still contains exact original bytes");}
        check(!ready.retryable(ready.session),"old-source entry cannot retry even with its original session token");
        TransferTray.Entry published=entries.stream().filter(e->e.key.equals(metadata.optString("publishedKey"))).findFirst().orElseThrow(()->new AssertionError("missing published record"));
        check(published.status==TransferTray.Status.SAVED&&saved.toString().equals(published.savedUri)&&published.file==null,"crash after publish reconciles exact saved URI without another save");
        try(android.database.Cursor cursor=getTargetContext().getContentResolver().query(pending,new String[]{android.provider.MediaStore.Images.Media._ID},null,null,null)){check(cursor!=null&&!cursor.moveToFirst(),"process restart removes only recorded unpublished row");}
        TransferTray.Entry interrupted=entries.stream().filter(e->e.key.equals(metadata.optString("interruptedKey"))).findFirst().orElseThrow(()->new AssertionError("missing interrupted original"));
        check(interrupted.status==TransferTray.Status.READY&&interrupted.pendingSaveUri==null,"cleaned interrupted save becomes explicitly saveable");
        try(InputStream in=getTargetContext().getContentResolver().openInputStream(saved)){OriginalCopy.Receipt receipt=OriginalCopy.inspect(in,metadata.getLong("savedBytes"),new CancelToken());check(receipt.sha256.equals(metadata.getString("savedHash")),"process restart preserves published original bytes");}
        check(!new File(getTargetContext().getCacheDir(),"originals/orphan-process-test.jpg").exists(),"process restart removes legacy cache orphan");
        check(!new File(originals().directory(),metadata.getString("part")).exists(),"process restart removes unfinished part");
        check(getTargetContext().getSharedPreferences("pending-saves",0).getStringSet("uris",Collections.emptySet()).isEmpty(),"process restart clears handled pending journal");
        TransferTray.Entry unconfirmed=entries.stream().filter(e->e.key.equals(metadata.optString("unconfirmedKey"))).findFirst().orElseThrow(()->new AssertionError("missing uncertain original"));
        check(unconfirmed.status==TransferTray.Status.SAVE_UNCONFIRMED&&unconfirmed.savedUri==null&&unconfirmed.pendingSaveUri!=null&&unconfirmed.file.isFile(),"mismatched published URI blocks another save and retains original");
        check(!unconfirmed.retryable(unconfirmed.session),"uncertain save cannot retry camera source");
        click("导入记录（4）");
        runOnMainSync(()->check(collectText(activity.getWindow().getDecorView()).contains("来自之前的导入"),"restored cards disclose their old source"));
        screenshot("08-recovered-originals");
        // Remove the interrupted card so the UI consent saves exactly the recovered ready original.
        runOnMainSync(()->check(controller.remove(interrupted.key,true)==TransferTray.RemoveResult.REMOVED,"recovered interrupted original can be explicitly removed"));
        click("保存到相册（1）");clickDialog("确认保存");awaitIdle();
        check(ready.status==TransferTray.Status.SAVED&&ready.savedUri!=null,"recovered original saves through confirmed real MediaStore transaction");
        try(InputStream in=getTargetContext().getContentResolver().openInputStream(android.net.Uri.parse(ready.savedUri))){check(OriginalCopy.inspect(in,ready.receipt.bytes,new CancelToken()).sha256.equals(ready.receipt.sha256),"recovered save preserves original hash");}
        String firstSave=ready.savedUri;runOnMainSync(controller::saveReady);awaitIdle();
        check(firstSave.equals(ready.savedUri)&&published.savedUri.equals(saved.toString()),"repeated save does not create another published copy");
        check(unconfirmed.status==TransferTray.Status.SAVE_UNCONFIRMED&&unconfirmed.savedUri==null,"batch save leaves uncertain result blocked");
        List<TransferTray.Entry> durableEntries=originals().restore().entries;
        check(durableEntries.stream().noneMatch(e->e.key.equals(ready.key)||e.key.equals(published.key)),"successful saves remove durable recovery records before any clear operation");
        try(android.database.Cursor cursor=getTargetContext().getContentResolver().query(android.net.Uri.parse(ready.savedUri),new String[]{android.provider.MediaStore.Images.Media.RELATIVE_PATH},null,null,null)){check(cursor!=null&&cursor.moveToFirst()&&cursor.getString(0).contains("GR III Transfer Demo"),"restored demo original remains isolated in demo album");}
        metadata.put("recoveredSaved",ready.savedUri);
        // Fresh durable entry, then explicit clear, followed by another real force-stop/restart.
        runOnMainSync(()->controller.connect(true));awaitIdle();String key=controller.inventory.photos.get(0).key();
        runOnMainSync(()->controller.transfer(Collections.singleton(key)));awaitIdle();
        check(controller.entries().stream().anyMatch(e->e.status==TransferTray.Status.READY),"prepare ready original for durable clear regression");
        click("更多");clickDialog("清空导入记录");check(dialogContains("隔离"),"clear confirmation includes quarantined originals");clickDialog("清除临时副本");
        check(controller.entries().isEmpty()&&!quarantinedFile.exists(),"confirmed clear commits staged and quarantined removals");writeProcessMetadata(metadata);
    }
    private void verifyProcessDeathCleared() throws Exception {
        org.json.JSONObject metadata=readProcessMetadata();
        check(controller.entries().isEmpty()&&!controller.connected,"saved removed and cleared entries do not resurrect after second restart");
        check(originals().restore().entries.isEmpty(),"no committed private originals remain after save and clear");
        for(String key:Arrays.asList("saved","recoveredSaved")) {
            android.net.Uri uri=android.net.Uri.parse(metadata.getString(key));String hash=metadata.getString(key.equals("saved")?"savedHash":"readyHash");long bytes=metadata.getLong(key.equals("saved")?"savedBytes":"readyBytes");
            try(InputStream in=getTargetContext().getContentResolver().openInputStream(uri)){check(OriginalCopy.inspect(in,bytes,new CancelToken()).sha256.equals(hash),"clear and restart preserve published exact bytes: "+key);}
            getTargetContext().getContentResolver().delete(uri,null,null);
        }
        processMetadata().delete();
    }
    private void check(boolean value,String label){assertions++;if(!value)throw new AssertionError(label);Bundle progress=new Bundle();progress.putString("stream","Checked: "+label+"\n");sendStatus(0,progress);}
    private void awaitIdle()throws Exception {
        long deadline=SystemClock.elapsedRealtime()+60000;
        while(SystemClock.elapsedRealtime()<deadline){boolean idle;synchronized(controller){idle=!controller.busy;}if(idle){waitForIdleSync();return;}Thread.sleep(50);}
        throw new AssertionError("operation did not finish: "+controller.status);
    }
    private ImageView firstImage(View root){if(root instanceof ImageView)return (ImageView)root;if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){ImageView found=firstImage(((ViewGroup)root).getChildAt(i));if(found!=null)return found;}return null;}
    private boolean insideScroll(View view){android.view.ViewParent parent=view.getParent();while(parent!=null){if(parent instanceof ScrollView)return true;parent=parent.getParent();}return false;}
    private String collectText(View root){StringBuilder out=new StringBuilder();if(root instanceof TextView)out.append(((TextView)root).getText()).append('\n');if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++)out.append(collectText(((ViewGroup)root).getChildAt(i)));return out.toString();}
    private boolean dialogContains(String value){AccessibilityNodeInfo root=getUiAutomation().getRootInActiveWindow();return root!=null&&!root.findAccessibilityNodeInfosByText(value).isEmpty();}
    private View find(View root,String text){if(root instanceof TextView&&text.contentEquals(((TextView)root).getText()))return root;if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++){View found=find(((ViewGroup)root).getChildAt(i),text);if(found!=null)return found;}return null;}
    private void click(String label){waitForIdleSync();runOnMainSync(()->{View found=find(activity.getWindow().getDecorView(),label);if(found==null||!found.isEnabled())throw new AssertionError("Missing enabled UI action: "+label);found.performClick();});waitForIdleSync();}
    private List<CheckBox> photoChecks(View root) { List<CheckBox> found=new ArrayList<>();if(root instanceof CheckBox)found.add((CheckBox)root);if(root instanceof ViewGroup)for(int i=0;i<((ViewGroup)root).getChildCount();i++)found.addAll(photoChecks(((ViewGroup)root).getChildAt(i)));return found; }
    private AccessibilityNodeInfo editable(AccessibilityNodeInfo root) { if(root==null)return null;if(root.isEditable())return root;for(int i=0;i<root.getChildCount();i++){AccessibilityNodeInfo found=editable(root.getChild(i));if(found!=null)return found;}return null; }
    private void setDialogText(String value)throws Exception {
        long deadline=SystemClock.elapsedRealtime()+10000;
        while(SystemClock.elapsedRealtime()<deadline){AccessibilityNodeInfo input=editable(getUiAutomation().getRootInActiveWindow());if(input!=null){Bundle args=new Bundle();args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,value);check(input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,args),"edit filter query");waitForIdleSync();return;}Thread.sleep(100);}
        throw new AssertionError("Filter query is not editable");
    }
    private boolean scrollDialog(AccessibilityNodeInfo root) { if(root==null)return false;if(root.isScrollable()&&root.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD))return true;for(int i=0;i<root.getChildCount();i++)if(scrollDialog(root.getChild(i)))return true;return false; }
    private void clickDialog(String label)throws Exception {
        long deadline=SystemClock.elapsedRealtime()+60000;
        while(SystemClock.elapsedRealtime()<deadline){List<AccessibilityNodeInfo> roots=dialogRoots();for(AccessibilityNodeInfo root:roots)if(clickDialogNode(root,label)){check(true,"dialog click "+label);waitForIdleSync();return;}for(AccessibilityNodeInfo root:roots)scrollDialog(root);Thread.sleep(100);}
        StringBuilder hierarchy=new StringBuilder();for(AccessibilityNodeInfo root:dialogRoots())describeNode(root,hierarchy,0);
        try(OutputStream out=new FileOutputStream(new File(getTargetContext().getFilesDir(),"dialog-failure.txt"))){out.write(hierarchy.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
        throw new AssertionError("Dialog action unavailable: "+label+"\n"+hierarchy);
    }
    private List<AccessibilityNodeInfo> dialogRoots() {
        List<AccessibilityNodeInfo> roots=new ArrayList<>();AccessibilityNodeInfo active=getUiAutomation().getRootInActiveWindow();if(active!=null)roots.add(active);
        for(android.view.accessibility.AccessibilityWindowInfo window:getUiAutomation().getWindows()){AccessibilityNodeInfo root=window.getRoot();if(root!=null)roots.add(root);}
        return roots;
    }
    private boolean clickDialogNode(AccessibilityNodeInfo node,String label) {
        if(node==null)return false;
        if(node.getText()!=null&&label.equals(node.getText().toString())) {
            AccessibilityNodeInfo target=node;
            for(int depth=0;target!=null&&depth<4;depth++,target=target.getParent())if(target.isClickable()&&target.isEnabled()&&target.isVisibleToUser()&&target.performAction(AccessibilityNodeInfo.ACTION_CLICK))return true;
        }
        for(int i=0;i<node.getChildCount();i++)if(clickDialogNode(node.getChild(i),label))return true;
        return false;
    }
    private void describeNode(AccessibilityNodeInfo node,StringBuilder out,int depth) {
        if(node==null||depth>20)return;
        out.append(node.getClassName()).append(" text=").append(node.getText()).append(" description=").append(node.getContentDescription()).append(" clickable=").append(node.isClickable()).append(" visible=").append(node.isVisibleToUser()).append('\n');
        for(int i=0;i<node.getChildCount();i++)describeNode(node.getChild(i),out,depth+1);
    }
    private void screenshot(String name)throws IOException {
        waitForIdleSync();Bitmap bitmap=getUiAutomation().takeScreenshot();if(bitmap==null)return;
        File directory=new File(getTargetContext().getFilesDir(),"smoke-screenshots");directory.mkdirs();
        try(OutputStream out=new FileOutputStream(new File(directory,name+".png"))){bitmap.compress(Bitmap.CompressFormat.PNG,100,out);}bitmap.recycle();
    }
}
