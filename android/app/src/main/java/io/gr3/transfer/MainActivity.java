package io.gr3.transfer;
import android.app.*;
import android.content.*;
import android.content.res.ColorStateList;
import android.graphics.*;
import android.graphics.drawable.GradientDrawable;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import io.gr3.transfer.core.*;
import java.util.*;
/** Platform-native Chinese UI. No WebView, remote assets, analytics or login. */
public final class MainActivity extends Activity {
    private TransferController controller;
    private LinearLayout root, content, navigation, bottom;
    private ScrollView scroll;
    private TextView status;
    private String selectionSession = "", searchQuery = "", filterFolder = "";
    private final Set<String> selected = new LinkedHashSet<>();
    private final Map<String,Bitmap> bitmapCache = new HashMap<>();
    private int page, renderGeneration;
    private CameraRules.Inventory selectionInventory;
    private boolean trayTab, selectedOnly;
    private GalleryRules.SortOrder sortOrder = GalleryRules.SortOrder.CAMERA;
    private static final int PAGE_SIZE = 20;
    private static final int INK = Color.rgb(30,43,39), MUTED = Color.rgb(98,113,105), GREEN = Color.rgb(32,107,82), PAPER = Color.rgb(246,247,243);
    @Override public void onCreate(Bundle state) {
        super.onCreate(state); controller = ((TransferApplication)getApplication()).controller;
        if (state != null) { selectedOnly = state.getBoolean("selectedOnly"); sortOrder = GalleryRules.SortOrder.restore(state.getString("sort")); filterFolder = state.getString("folder", ""); searchQuery = state.getString("query", ""); page = state.getInt("page"); trayTab = state.getBoolean("tray"); selectionSession = state.getString("session", ""); ArrayList<String> saved = state.getStringArrayList("selected"); if (saved != null) selected.addAll(saved); }
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(PAPER); root.setPadding(dp(18), dp(12), dp(18), dp(10));
        if (Build.VERSION.SDK_INT >= 30) root.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            root.setPadding(dp(18) + bars.left, dp(12) + bars.top, dp(18) + bars.right, dp(10) + bars.bottom); return insets;
        });
        else root.setOnApplyWindowInsetsListener((view, insets) -> { root.setPadding(dp(18) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(), dp(18) + insets.getSystemWindowInsetRight(), dp(10) + insets.getSystemWindowInsetBottom()); return insets; });
        LinearLayout heading = row(); heading.setGravity(Gravity.CENTER_VERTICAL);
        heading.addView(text(getString(R.string.app_name),22,true),new LinearLayout.LayoutParams(0,-2,1));
        addButton(heading,"更多",this::connectionOptions,true).setLayoutParams(new LinearLayout.LayoutParams(dp(56),-2)); root.addView(heading);
        status = text("",12,false); status.setTextColor(MUTED); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status);
        navigation = row(); navigation.setPadding(0,dp(6),0,dp(8)); root.addView(navigation);
        scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false);
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        bottom = new LinearLayout(this); bottom.setOrientation(LinearLayout.VERTICAL); bottom.setPadding(0,dp(8),0,0); root.addView(bottom);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::leave);
    }
    @Override protected void onStart() { super.onStart(); controller.listen(this::render); render(); }
    @Override protected void onStop() { controller.listen(null); if (!isChangingConfigurations()) controller.cancel(); super.onStop(); }
    @Override protected void onSaveInstanceState(Bundle out) { out.putBoolean("selectedOnly",selectedOnly); out.putString("sort",sortOrder.name()); out.putString("folder",filterFolder); out.putString("query",searchQuery); out.putInt("page",page); out.putBoolean("tray",trayTab); out.putString("session",selectionSession); out.putStringArrayList("selected",new ArrayList<>(selected)); super.onSaveInstanceState(out); }
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() { leave(); }
    private void leave() {
        if (controller.busy || controller.hasUnsaved()) new AlertDialog.Builder(this).setTitle("还有原片未保存")
            .setMessage("离开会取消未完成的操作。待保存的原片只是临时副本，Android 关闭应用后可能丢失。建议先保存到相册。")
            .setNegativeButton("继续使用",null).setPositiveButton("仍然离开",(dialog,which) -> { controller.cancel(); finish(); }).show();
        else finish();
    }
    private void render() { render(false); }
    private void render(boolean resetScroll) {
        if (isFinishing() || isDestroyed()) return;
        if (resetScroll) scroll.scrollTo(0, 0);
        int y = resetScroll ? 0 : scroll.getScrollY();
        int generation = ++renderGeneration;
        synchronized (controller) {
            if (!selectionSession.equals(controller.session)) { selected.clear(); searchQuery = ""; filterFolder = ""; sortOrder = GalleryRules.SortOrder.CAMERA; selectedOnly = false; page = 0; selectionSession = controller.session; bitmapCache.clear(); }
            if(selectionInventory!=controller.inventory) {
                Set<String> retained=GalleryRules.reconcileSelection(selected,controller.inventory.photos);selected.clear();selected.addAll(retained);
                if(!filterFolder.isEmpty()&&!GalleryRules.folders(controller.inventory.photos).containsKey(filterFolder))filterFolder="";
                bitmapCache.clear();selectionInventory=controller.inventory;
            }
            status.setText(controller.status);
            navigation.removeAllViews(); bottom.removeAllViews(); content.removeAllViews();
            boolean showTabs=controller.connected||!controller.entries().isEmpty(); navigation.setVisibility(showTabs?View.VISIBLE:View.GONE);
            if(showTabs) { addTab("照片", () -> { trayTab = false; render(true); }, !trayTab); addTab("导入记录（" + controller.entries().size() + "）", () -> { trayTab = true; render(true); }, trayTab); }
            else trayTab=false;
            if (trayTab) renderTray(); else renderCamera();
            if (controller.busy) { bottom.removeAllViews(); primary(bottom,"取消当前操作",controller::cancel,true); }
        }
        scroll.post(() -> { if (generation == renderGeneration) scroll.scrollTo(0,y); });
    }
    private void renderCamera() {
        if (!controller.connected) {
            TextView intro=text("把原片带回手机",28,true); intro.setPadding(0,dp(22),0,dp(6)); content.addView(intro);
            content.addView(text("相机直连 · JPEG 原片 · 保留拍摄信息",14,false));
            LinearLayout steps=card(); content.addView(steps);
            steps.addView(text("01  打开相机的无线局域网",16,true));
            steps.addView(text("02  在手机设置中连接相机 Wi-Fi",16,true));
            steps.addView(text("提示没有互联网时，选择保持连接",13,false));
            steps.addView(text("03  回到这里，选择并导入照片",16,true));
            addButton(content,"打开 Wi-Fi 设置",()->startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)),!controller.busy);
            addButton(content,"试用演示照片",()->controller.connect(true),!controller.busy);
            content.addView(text("仅支持 RICOH GR III 的 JPEG。测试版尚未经过实机验证。",12,false));
            addButton(content,"使用与隐私说明",this::privacy,true);
            primary(bottom,"连接 GR III",()->controller.connect(false),!controller.busy); return;
        }
        List<CameraRules.Photo> photos = filteredPhotos();
        int pages = Math.max(1,(photos.size()+PAGE_SIZE-1)/PAGE_SIZE); page = Math.min(page,pages-1);
        int start = page*PAGE_SIZE, end = Math.min(photos.size(),start+PAGE_SIZE);
        List<CameraRules.Photo> visible = new ArrayList<>(photos.subList(start,end));
        content.addView(text("选择照片",23,true));
        content.addView(text("显示 "+photos.size()+" / "+controller.inventory.photos.size()+" 张 JPEG · 已选 "+selected.size()+(controller.demo?" · 演示图片，单独保存":" · 原片不压缩")+(pages>1?" · 第 "+(page+1)+" / "+pages+" 页":""),12,false));
        if(!searchQuery.isEmpty()||!filterFolder.isEmpty()||selectedOnly)content.addView(text((filterFolder.isEmpty()?"全部文件夹":filterFolder)+(searchQuery.isEmpty()?"":" · 搜索："+searchQuery)+(selectedOnly?" · 仅看已选":"")+" · 已筛选",12,false));
        int hiddenSelected=selected.size()-GalleryRules.selectedCount(photos,selected);
        if(hiddenSelected>0)content.addView(text("另有 "+hiddenSelected+" 张已选照片不在当前筛选中，导入时会一起处理。",12,false));
        primary(bottom,selected.isEmpty()?"选择要导入的照片":"导入原片（"+selected.size()+"）",()->{controller.transfer(new LinkedHashSet<>(selected));trayTab=true;render(true);},!controller.busy&&!selected.isEmpty());
        if(photos.isEmpty()) {
            banner(!controller.inventory.photos.isEmpty()?"没有符合筛选条件的照片，请在「更多 → 筛选与排序」调整条件。":controller.inventory.raw>0?"未找到 JPEG 照片\n当前目录只有 RAW，请使用读卡器导入。":"相机中暂无可导入的 JPEG 照片");
            return;
        }
        LinearLayout actions=row(); content.addView(actions);
        boolean pageSelected=visible.stream().allMatch(p->selected.contains(p.key()));
        addButton(actions,pageSelected?"取消本页全选":"全选本页",()->{
            changeSelection(visible,pageSelected?GalleryRules.SelectionAction.DESELECT:GalleryRules.SelectionAction.SELECT);
        },!controller.busy);
        addButton(actions,controller.thumbnails.isEmpty()?"加载预览":"刷新预览",()->{bitmapCache.clear();controller.loadThumbnails(visible);},!controller.busy);
        if (pages > 1) {
            LinearLayout pagesRow=row();content.addView(pagesRow);
            addButton(pagesRow,"上一页",()->{page--; render(true);},page>0&&!controller.busy);
            addButton(pagesRow,"下一页",()->{page++; render(true);},page+1<pages&&!controller.busy);
        }
        // Two columns only when both remain readable, including large system font settings.
        boolean twoColumns=getResources().getConfiguration().screenWidthDp>=360&&getResources().getConfiguration().fontScale<=1.15f;
        LinearLayout photoRow=null;
        for(int i=0;i<visible.size();i++) {
            CameraRules.Photo photo=visible.get(i); LinearLayout tile=photoCard(photo,twoColumns?144:168);
            if(twoColumns) {
                if(i%2==0){photoRow=row();content.addView(photoRow);}
                LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(0,-2,1);params.topMargin=dp(8);params.bottomMargin=dp(4);params.setMarginEnd(i%2==0?dp(4):0);params.setMarginStart(i%2==1?dp(4):0);photoRow.addView(tile,params);
                if(i==visible.size()-1&&i%2==0)photoRow.addView(new View(this),new LinearLayout.LayoutParams(0,0,1));
            } else content.addView(tile);
        }
        content.addView(text("预览仅供选片；导入时读取完整 JPEG 原片。",12,false));
    }
    private LinearLayout photoCard(CameraRules.Photo photo,int height) {
        LinearLayout tile=card(); byte[] thumbnail=controller.thumbnails.get(photo.key()); Bitmap bitmap=bitmapCache.get(photo.key());
        if(bitmap==null&&thumbnail!=null) {
            BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(thumbnail,0,thumbnail.length,bounds);
            if(bounds.outWidth>0&&bounds.outHeight>0&&bounds.outWidth<=16000&&bounds.outHeight<=16000) {
                BitmapFactory.Options options=new BitmapFactory.Options();options.inSampleSize=1;
                while(bounds.outWidth/options.inSampleSize>640||bounds.outHeight/options.inSampleSize>640)options.inSampleSize*=2;
                bitmap=BitmapFactory.decodeByteArray(thumbnail,0,thumbnail.length,options);if(bitmap!=null)bitmapCache.put(photo.key(),bitmap);
            }
        }
        if(bitmap!=null) {
            ImageView image=new ImageView(this);image.setImageBitmap(bitmap);image.setScaleType(ImageView.ScaleType.CENTER_INSIDE);image.setContentDescription("照片预览："+photo.key());tile.addView(image,new LinearLayout.LayoutParams(-1,dp(height)));
        }
        CheckBox check=new CheckBox(this);check.setText(photo.name);check.setContentDescription(photo.name+"，文件夹 "+photo.folder);check.setTextColor(INK);check.setTextSize(14);check.setMinHeight(dp(48));check.setButtonTintList(ColorStateList.valueOf(GREEN));check.setChecked(selected.contains(photo.key()));check.setEnabled(!controller.busy);
        check.setOnCheckedChangeListener((button,checked)->{
            if(checked&&selected.size()>=CameraRules.MAX_ENTRIES){check.setChecked(false);Toast.makeText(this,"每批最多选择 48 张照片",Toast.LENGTH_SHORT).show();return;}
            if(checked)selected.add(photo.key());else selected.remove(photo.key());render();
        });tile.addView(check);
        TextView folder=text(photo.folder,11,false);folder.setTextColor(MUTED);tile.addView(folder);return tile;
    }
    private List<CameraRules.Photo> filteredPhotos() { return GalleryRules.sort(GalleryRules.selected(GalleryRules.filter(controller.inventory.photos, searchQuery, filterFolder), selected, selectedOnly), sortOrder); }
    private List<CameraRules.Photo> currentPagePhotos() {
        List<CameraRules.Photo> photos=filteredPhotos();int current=Math.min(page,Math.max(0,(photos.size()-1)/PAGE_SIZE));int start=current*PAGE_SIZE;
        return new ArrayList<>(photos.subList(start,Math.min(photos.size(),start+PAGE_SIZE)));
    }
    private void changeSelection(List<CameraRules.Photo> photos,GalleryRules.SelectionAction action) {
        if(controller.busy)return;
        GalleryRules.SelectionChange change=GalleryRules.changeSelection(selected,photos,action);selected.clear();selected.addAll(change.keys);
        if(change.omitted>0)Toast.makeText(this,"每批最多选择 48 张，另有 "+change.omitted+" 张未加入选择",Toast.LENGTH_LONG).show();render();
    }
    private void galleryFilters() {
        EditText query=new EditText(this);query.setSingleLine(true);query.setHint("搜索文件名或文件夹");query.setContentDescription("搜索文件名或文件夹");query.setText(searchQuery);
        query.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(128)});
        LinearLayout fields=new LinearLayout(this);fields.setOrientation(LinearLayout.VERTICAL);fields.setPadding(dp(24),0,dp(24),0);fields.addView(query);
        ArrayList<String> folders=new ArrayList<>();folders.add("");folders.addAll(GalleryRules.folders(controller.inventory.photos).keySet());
        ArrayList<String> labels=new ArrayList<>();labels.add("全部文件夹（"+controller.inventory.photos.size()+"）");
        Map<String,Integer> counts=GalleryRules.folders(controller.inventory.photos);for(int i=1;i<folders.size();i++)labels.add(folders.get(i)+"（"+counts.get(folders.get(i))+"）");
        fields.addView(text("文件夹",13,true));Spinner folder=new Spinner(this);folder.setContentDescription("按相机文件夹筛选");folder.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,labels));folder.setSelection(Math.max(0,folders.indexOf(filterFolder)));fields.addView(folder);
        CheckBox onlySelected=new CheckBox(this);onlySelected.setText("仅看已选照片");onlySelected.setChecked(selectedOnly);fields.addView(onlySelected);
        fields.addView(text("排序（不是拍摄时间）",13,true));Spinner order=new Spinner(this);order.setContentDescription("照片排序");order.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,new String[]{"相机列表顺序","文件名：从小到大","文件名：从大到小","文件夹：从小到大"}));order.setSelection(sortOrder.ordinal());fields.addView(order);
        new AlertDialog.Builder(this).setTitle("筛选与排序").setView(fields)
            .setNegativeButton("取消",null).setNeutralButton("清除筛选",(d,w)->{searchQuery="";filterFolder="";sortOrder=GalleryRules.SortOrder.CAMERA;selectedOnly=false;page=0;render(true);})
            .setPositiveButton("应用",(d,w)->{searchQuery=query.getText().toString().trim();filterFolder=folders.get(folder.getSelectedItemPosition());sortOrder=GalleryRules.SortOrder.values()[order.getSelectedItemPosition()];selectedOnly=onlySelected.isChecked();page=0;render(true);}).show();
    }
    private void connectionOptions() {
        ArrayList<String> labels=new ArrayList<>();ArrayList<Runnable> actions=new ArrayList<>();
        if(controller.connected){labels.add("筛选与排序");actions.add(this::galleryFilters);}
        if(controller.connected&&!controller.inventory.photos.isEmpty()){labels.add("反选本页照片");actions.add(()->changeSelection(currentPagePhotos(),GalleryRules.SelectionAction.INVERT));}
        if(!selected.isEmpty()){labels.add("清除全部选择（"+selected.size()+"）");actions.add(()->changeSelection(Collections.emptyList(),GalleryRules.SelectionAction.CLEAR));}
        if(controller.connected){labels.add(controller.demo?"刷新演示照片":"刷新相机照片");actions.add(controller::refresh);}
        labels.add("打开 Wi-Fi 设置");actions.add(()->startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)));
        labels.add("试用演示照片");actions.add(()->controller.connect(true));
        if(controller.connected){labels.add("断开连接");actions.add(controller::disconnect);labels.add("照片与连接详情");actions.add(this::connectionDetails);}
        long savedCount=controller.entries().stream().filter(e->e.status==TransferTray.Status.SAVED&&e.savedUri!=null).count();
        if(savedCount>0){labels.add("清理已保存记录（"+savedCount+"）");actions.add(controller::clearSaved);}
        if(!controller.entries().isEmpty()){labels.add("清空导入记录");actions.add(this::clearTray);}
        labels.add("使用与隐私说明");actions.add(this::privacy);
        new AlertDialog.Builder(this).setTitle("更多选项").setItems(labels.toArray(new String[0]),(dialog,which)->{
            if(controller.busy){Toast.makeText(this,"请先等待当前操作完成，或取消操作",Toast.LENGTH_SHORT).show();return;}actions.get(which).run();
        }).setNegativeButton("取消",null).show();
    }
    private void connectionDetails() {
        new AlertDialog.Builder(this).setTitle("照片与连接详情").setMessage("JPEG："+controller.inventory.photos.size()+" 张\n已排除 RAW："+controller.inventory.raw+" 张\n其他文件："+controller.inventory.other+" 个\n重复记录："+controller.inventory.duplicate+" 条\n\n"+(controller.demo?"当前使用生成的演示图片，不会连接相机。":"使用已连接的 Wi-Fi，固定访问 192.168.0.1。不会修改手机默认网络或相机文件。")+"\n\n临时空间："+size(controller.stagedBytes())+" / 256 MiB").setPositiveButton("知道了",null).show();
    }
    private void privacy() {
        new AlertDialog.Builder(this).setTitle("使用与隐私说明").setMessage("仅支持 RICOH GR III 的 JPEG，暂不支持 RAW、GR IIIx 或 GR IV。Android 10 及以上可用，测试版尚未经过真实相机和手机验证。\n\n应用不读取相册、位置、蓝牙或 Wi-Fi 密码，不自动加入网络，也不改变系统网络设置。请先在手机设置中连接相机 Wi-Fi，并保持相机唤醒。\n\n只通过已连接的 Wi-Fi 读取固定相机地址，不上传照片、不采集统计数据、不修改相机文件。相机使用未加密的本地 HTTP，请仅使用可信的相机 Wi-Fi。\n\n原片不会重编码或修改 EXIF。导入后先保留临时副本，须再次确认保存才能写入 Pictures。关闭应用后临时文件可能丢失。\n\n保存后，Android 或相册应用可能按你已开启的设置自动云备份。演示图片单独存放在 GR III Transfer Demo 文件夹。")
            .setPositiveButton("知道了",null).show();
    }
    private void addTab(String label,Runnable action,boolean active) {
        Button button=addButton(navigation,label,action,true);button.setSelected(active);button.setContentDescription(label+(active?"，当前页面":"，切换页面"));button.setTypeface(null,active?Typeface.BOLD:Typeface.NORMAL);styleButton(button,active);
    }
    private void renderTray() {
        List<TransferTray.Entry> entries=controller.entries();int ready=0,failed=0,saved=0;
        for(TransferTray.Entry entry:entries){if(entry.status==TransferTray.Status.READY)ready++;if(entry.status==TransferTray.Status.SAVED)saved++;if(entry.retryable(controller.session))failed++;}
        boolean complete=!entries.isEmpty()&&saved==entries.size();
        content.addView(text(complete?"已保存到相册":ready>0?"原片已就绪":"导入记录",24,true));
        content.addView(text(complete?saved+" 张原片 · 拍摄信息已保留":ready+" 张待保存 · "+saved+" 张已保存"+(failed>0?" · "+failed+" 张可重试":""),14,false));
        if(ready>0)banner("还有 "+ready+" 张原片只在临时空间，请保存后再离开。");
        if(complete)banner("在相册或文件应用的 Pictures 文件夹中查看。"+(entries.stream().anyMatch(e->e.demo)?"\n演示图片位于 GR III Transfer Demo。":"\n原片位于 GR III Transfer。"));
        if(failed>0)addButton(content,"重试未完成的照片（"+failed+"）",controller::retry,!controller.busy&&controller.connected);
        if(entries.isEmpty()){content.addView(text("先到「照片」选择照片，导入的原片会显示在这里。",16,false));primary(bottom,"去选择照片",()->{trayTab=false;render(true);},true);}
        else if(ready>0){final int readyCount=ready;primary(bottom,"保存到相册（"+ready+"）",()->confirmSave(readyCount),!controller.busy);}
        else if(complete)primary(bottom,"继续选片",()->{trayTab=false;render(true);},!controller.busy);
        for(TransferTray.Entry entry:entries) {
            LinearLayout item=card();content.addView(item);item.addView(text(entry.photo.name,17,true));
            TextView state=text(stateLabel(entry.status)+(entry.demo?" · 演示图片":""),13,true);state.setTextColor(entry.status==TransferTray.Status.FAILED?Color.rgb(148,63,40):GREEN);item.addView(state);
            if(entry.status==TransferTray.Status.FAILED||entry.status==TransferTray.Status.CANCELLED||entry.status==TransferTray.Status.READY)item.addView(text(entry.message,13,false));
            if(entry.status==TransferTray.Status.TRANSFERRING||entry.status==TransferTray.Status.SAVING) {
                ProgressBar progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setIndeterminate(entry.status==TransferTray.Status.SAVING||entry.expected<=0);progress.setMax(1000);if(entry.expected>0)progress.setProgress((int)(entry.bytes*1000/entry.expected));progress.setContentDescription(entry.status==TransferTray.Status.SAVING?"正在保存并校验原片":"原片导入进度");item.addView(progress);
                if(entry.status==TransferTray.Status.TRANSFERRING)item.addView(text(size(entry.bytes)+(entry.expected>=0?" / "+size(entry.expected):" · 总大小未知"),12,false));
            }
            LinearLayout actions=row();item.addView(actions);addButton(actions,"详情",()->entryDetails(entry),true);
            if(entry.retryable(controller.session)&&controller.connected)addButton(actions,"重试这张",()->controller.retry(entry.key),!controller.busy);
            if((entry.status==TransferTray.Status.FAILED||entry.status==TransferTray.Status.CANCELLED)&&entry.attempts>=3)item.addView(text("已达到 3 次尝试上限，请检查连接并重新选片。",12,false));
            if(entry.savedUri!=null)addButton(actions,"查看照片",()->openSaved(entry),!controller.busy);
            if((entry.status==TransferTray.Status.FAILED||entry.status==TransferTray.Status.CANCELLED)&&!entry.session.equals(controller.session))item.addView(text("这是之前连接的照片。请重新连接相机，再次选择该文件。",13,false));
        }
    }
    private void confirmSave(int count) {
        new AlertDialog.Builder(this).setTitle("保存 "+count+" 张原片到相册？")
            .setMessage("将新增保存到 Pictures/GR III Transfer，保留原始拍摄信息（EXIF），不会覆盖已有照片。演示图片单独保存到 GR III Transfer Demo。\n\n如果你已开启 Android 或相册应用的云备份，保存后它们可能上传这些照片。本应用不会上传。\n\n每张照片写入后会重新读取并校验，校验通过才完成保存。")
            .setNegativeButton("取消",null).setPositiveButton("确认保存",(dialog,which) -> controller.saveReady()).show();
    }
    private void clearTray() {
        if(controller.busy)return;
        if(controller.hasUnsaved())new AlertDialog.Builder(this).setTitle("清除未保存的原片？").setMessage("将删除导入记录中的临时副本。已保存到相册的照片和相机中的文件不会改变。")
            .setNegativeButton("保留原片",null).setPositiveButton("清除临时副本",(d,w)->controller.clear()).show();
        else controller.clear();
    }
    private void entryDetails(TransferTray.Entry entry) {
        String value="文件夹："+entry.photo.folder+"\n状态："+stateLabel(entry.status)+"\n尝试次数："+entry.attempts+" / 3\n来源会话："+entry.session.substring(0,8)+"\n"+entry.message;
        if(entry.receipt!=null)value+="\n\n文件大小："+size(entry.receipt.bytes)+"\nSHA-256\n"+entry.receipt.sha256+"\n\n此校验值用于核对收到的字节，并非相机提供的校验值。如需端到端验证，请与读卡器导出的原片比较。";
        TextView details=text(value,14,false);details.setTextIsSelectable(true);details.setPadding(dp(24),dp(10),dp(24),dp(10));ScrollView body=new ScrollView(this);body.addView(details);
        new AlertDialog.Builder(this).setTitle(entry.photo.name).setView(body).setPositiveButton("关闭",null).show();
    }
    private void openSaved(TransferTray.Entry entry) {
        Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(android.net.Uri.parse(entry.savedUri),"image/jpeg").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try{startActivity(intent);}catch(ActivityNotFoundException e){Toast.makeText(this,"请使用相册或文件应用，在 Pictures/"+(entry.demo?"GR III Transfer Demo":"GR III Transfer")+" 查看照片",Toast.LENGTH_LONG).show();}
    }
    private static String stateLabel(TransferTray.Status state) {
        switch(state){case QUEUED:return "等待导入";case TRANSFERRING:return "正在导入";case READY:return "待保存";case SAVING:return "正在保存";case SAVED:return "已保存";case FAILED:return "导入未完成";case CANCELLED:return "已取消";default:return "等待处理";}
    }
    private void banner(String value){TextView view=text(value,13,false);view.setPadding(dp(12),dp(12),dp(12),dp(12));view.setBackground(background(Color.rgb(231,239,232),12));LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(8);params.bottomMargin=dp(8);content.addView(view,params);}
    private TextView text(String value,int size,boolean bold){TextView view=new TextView(this);view.setText(value);view.setTextSize(size);view.setTextColor(bold?INK:MUTED);view.setPadding(0,dp(4),0,dp(4));view.setLineSpacing(dp(2),1);if(bold)view.setTypeface(null,Typeface.BOLD);return view;}
    private LinearLayout row(){LinearLayout view=new LinearLayout(this);view.setOrientation(LinearLayout.HORIZONTAL);return view;}
    private GradientDrawable background(int color,int radius){GradientDrawable drawable=new GradientDrawable();drawable.setColor(color);drawable.setCornerRadius(dp(radius));return drawable;}
    private LinearLayout card(){LinearLayout view=new LinearLayout(this);view.setOrientation(LinearLayout.VERTICAL);view.setPadding(dp(12),dp(10),dp(12),dp(8));view.setBackground(background(Color.WHITE,16));LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(8);params.bottomMargin=dp(4);view.setLayoutParams(params);return view;}
    private void styleButton(Button button,boolean primary){boolean enabled=button.isEnabled();button.setBackgroundTintList(null);button.setBackground(background(primary?(enabled?GREEN:Color.rgb(222,229,222)):Color.rgb(234,239,232),12));button.setTextColor(primary&&enabled?Color.WHITE:enabled?GREEN:MUTED);button.setElevation(0);}
    private Button addButton(LinearLayout parent,String label,Runnable action,boolean enabled){Button button=new Button(this);button.setText(label);button.setAllCaps(false);button.setTextSize(14);button.setMinHeight(dp(48));button.setMinimumWidth(0);button.setPadding(dp(10),dp(8),dp(10),dp(8));button.setEnabled(enabled);button.setOnClickListener(view->action.run());styleButton(button,false);LinearLayout.LayoutParams params=parent.getOrientation()==LinearLayout.HORIZONTAL?new LinearLayout.LayoutParams(0,-2,1):new LinearLayout.LayoutParams(-1,-2);if(parent.getOrientation()==LinearLayout.HORIZONTAL&&parent.getChildCount()>0)params.setMarginStart(dp(6));params.topMargin=dp(3);params.bottomMargin=dp(3);parent.addView(button,params);return button;}
    private Button primary(LinearLayout parent,String label,Runnable action,boolean enabled){Button button=addButton(parent,label,action,enabled);button.setTypeface(null,Typeface.BOLD);styleButton(button,true);return button;}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private static String size(long bytes){return String.format(Locale.ROOT,"%.1f MiB",bytes/(1024d*1024d));}
}
