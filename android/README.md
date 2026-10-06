# Native Android test client

A platform-native Android 10+ (API 29+) client for the **exact RICOH GR III**.
This is a separate, direct-to-camera app. It does not reach a desktop's localhost,
start a bridge, expose a server, or change the desktop implementation.

## 中文界面

保留 **GR III Transfer** 名称，默认使用简体中文。界面按「连接相机 → 选择照片 → 导入原片 → 确认保存」组织：

- 首次打开只显示连接步骤；连接后切换「照片」和「导入记录」
- 「导入原片」和「保存到相册」固定在底部，不必滚到列表末尾
- 普通手机宽度使用双列照片；窄屏或较大系统字体自动使用单列
- 状态、错误、退出/清空提醒和保存确认均为中文
- 文件夹统计、连接信息和临时空间用量在「更多 → 照片与连接详情」
- 每张原片的 SHA-256、重试次数和来源会话在「详情」中
- 「已保存到相册」明确区分保存成功和仅在临时空间就绪；保存前仍会说明 EXIF、云备份和不覆盖已有照片

界面调整不会改变固定相机地址、JPEG 路径校验、已连接 Wi-Fi 路由、原片字节复制或 MediaStore 待保存清理/读回校验。

## 本地选片工具

「更多 → 筛选照片」可搜索文件名或文件夹，不访问额外相机端点。文件夹菜单显示各目录的 JPEG 数量，可与搜索组合使用。搜索忽略大小写和首尾空格，取消不会改变条件；旋转屏幕保留搜索，重新连接重置。

## Status and verification

**Compiled Android test client, not physical-camera validated.** The original protocol remains
community documented. No physical GR III or Android device was available.

- `./scripts/test-core.sh`: **228 assertions passed** on 2026-10-06
- Tests use all 36 existing synthetic original/preview/thumbnail JPEG fixtures,
  including one-byte and split HTTP-like chunks
- Official Android Platform 36 / Build Tools 35.0.0 / AGP 8.13.2:
  `lintDebug assembleDebug assembleDebugAndroidTest` **passed**; lint reports
  **No issues found**
- `apksigner verify --verbose --print-certs`: **passed**, APK Signature Scheme v2,
  standard Android Debug certificate generated in temporary test storage
- `aapt dump badging`: **verified** minSdk 29, targetSdk 36, and exactly the two
  documented networking permissions
- Emulator/API execution results are recorded below. Physical-camera transfers,
  cellular-default Wi-Fi routing and real-phone behavior remain **unverified**
- The JVM store tests execute the actual `PendingSave` transaction against an
  in-memory adapter. They do **not** execute Android MediaStore or simulate an OS
- This is not a release-signed or Play-distributed build

## 中文版验证（2026-10-06）

- Android SDK 36：`lintDebug assembleDebug assembleDebugAndroidTest` 通过，lint **No issues found**
- JVM：**228** 项原片/校验/待保存事务断言通过；源代码安全检查通过
- API 29、320×640：**76** 项原生 UI/API 断言通过，覆盖中文首页、照片选择/取消全选、固定底部操作、详情收纳、保存提示、取消保存/清空、明确保存完成、旋转、取消重试，以及全部 12 张演示原片的实际 MediaStore 保存和 SHA-256 读回一致性
- **7** 项独立进程重启断言通过：仅清理应用记录的待保存照片和孤立临时文件，保留已经发布的原片及其精确字节
- 390×844、标准字体：**5** 项布局断言通过，双列照片和底部导入操作可用
- 390×844、1.3 倍系统字体：**5** 项布局断言通过，自动改为单列，中文标签和底部操作仍完整可见
- `apksigner verify` 通过；包信息仍为 minSdk 29 / targetSdk 36，仅有两个原有网络权限

截图来自真实运行的官方 API 29 模拟器，使用的全部是仓库内生成的几何图形。首次冷启动遇到模拟器自身的 System UI 无响应弹窗；等待系统恢复后完整重跑通过，未将被该弹窗遮挡的截图用作界面验证。布局附加阶段可用 instrumentation 的 `-e phase layout` 执行；修改的测试模拟器屏幕/字体设置已还原。

**未验证**：真实 GR III、真实手机、移动数据作为默认网络的真实 Wi-Fi 路由、API 33+ 预测返回及近期 Android 运行时。SDK 36 编译通过不代表这些硬件或系统路径已验证。APK 仍是调试签名测试包，不是正式发行版。

## Emulator evidence (2026-10-05)

The official AOSP Android 10 / API 29 x86_64 image ran in software emulation:

- **58 native UI/API assertions passed**: actual app launch, synthetic inventory
  and thumbnails, twelve original transfers, Back/unsaved confirmation, declined
  save, explicit confirmed save, actual MediaStore publication and byte/hash
  readback for every original, Activity recreation on rotation, cancellation,
  manual retry, disconnect retention and clearing private staging. The final
  compact gallery also verifies selected-tab accessibility, non-mutating
  Connection options dismissal, hidden single-page navigation, and the first
  thumbnail visible without scrolling at 320×640
- **7 separate lifecycle assertions passed**: prepare synthetic published/pending
  rows and orphan cache, force-stop the app, relaunch, verify pending cleanup and
  retention of the already-published exact bytes
- Screenshots were captured from the running emulator, not browser renderings
- The API 36 software guest restarted `system_server` through its watchdog
  before app installation. No API 36 runtime success is claimed. Compilation and
  lint against SDK 36 passed; API 33+ predictive Back and real-phone behavior
  still need a functioning recent emulator or physical device

The emulator test runner intentionally accepts only an explicit `emulator-N`
serial. It installs the debug/test APKs into that disposable emulator, exercises
only synthetic fixtures, and never contacts the fixed camera address. Tests
remove only their known synthetic published rows; lifecycle checks never scan
or delete an existing photo collection.

## Build

Install an official JDK 17+ and Android SDK Platform 36 with Android SDK Build
Tools 35.0.0 using Android Studio/SDK Manager, after accepting the applicable
[Android SDK agreement](https://developer.android.com/studio/terms).

```sh
cd android
./scripts/test-core.sh             # no network, SDK, Gradle or packages needed
./gradlew lintDebug assembleDebug assembleDebugAndroidTest # Android toolchain required
./scripts/test-emulator.sh emulator-5554 # booted disposable emulator only
```

The Gradle wrapper pins 8.13 and verifies its distribution SHA-256. AGP is pinned
to 8.13.2. There are no runtime library dependencies. Generated APK location:
`app/build/outputs/apk/debug/app-debug.apk`. Standard debug signing is only for
local testing; do not distribute it as a production identity. Release signing
and distribution remain separate authorized steps. Never commit a keystore.
For an isolated local test, set `ANDROID_USER_HOME` to a temporary directory
before building, retain the APK, and remove that temporary key after testing.
A later debug build signed with a different key requires uninstalling the old
test app before installation.

## Use / 使用

1. 在 GR III 相机上开启无线局域网
2. 打开手机的 Wi-Fi 设置并加入相机网络；提示没有互联网时，选择保持连接
3. 返回应用，点「连接 GR III」
4. 在「照片」页选择 JPEG；「加载预览」可选，预览失败不影响按文件名导入原片
5. 点底部的「导入原片」，在「导入记录」中查看进度
6. 点「保存到相册」，阅读提示并点「确认保存」
7. 保存完成后点「查看照片」，或到 Pictures/GR III Transfer 中查找

「更多」包含刷新相机照片、Wi-Fi 设置、演示照片、断开连接、清空导入记录与隐私说明。演示图片单独保存在 Pictures/GR III Transfer Demo。

The app does not request Wi-Fi credentials, join networks, use Bluetooth, scan
SSIDs, bind the process's default network, or ask for location/photo-library
access. Each HTTP connection uses the already joined Wi-Fi `Network` with a
fixed literal camera address and no proxy. Mobile data can remain the system's
default route. Multiple simultaneously visible Wi-Fi networks are rejected
rather than guessed. On a device that disconnects no-Internet Wi-Fi, reconnect
using Android Settings and confirm that it should remain connected.

**试用演示照片** uses the repository's geometric fixtures. It never contacts
the camera. Demo saves use the separate `Pictures/GR III Transfer Demo` folder
and `DEMO_` filename prefix.

## Privacy, storage and byte preservation

- Only `INTERNET` and `ACCESS_NETWORK_STATE` permissions; Android 10+ scoped
  storage permits writes to app-owned MediaStore rows without library access
- SDK 36 target follows the current Android guidance: do not request
  `ACCESS_LOCAL_NETWORK` before targeting SDK 37. Reassess the runtime permission
  flow when increasing target SDK; Android 16 opt-in network restrictions and
  vendor variants require hardware checks
- Cleartext HTTP is restricted to `192.168.0.1`. Only fixed `/v1/props`,
  `/v1/photos` and safe JPEG paths are allowed, and every request is `GET`
- No redirects, proxies, cookies, login, upload, analytics, remote UI assets,
  camera writes, capture, deletion, transfer-flag changes, RAW conversion or
  guessed pagination. Sensitive camera properties are ignored and never logged
- Original paths have **no size query**. Only thumbnails use `?size=thumb`
- Incoming originals stream into app-private temporary cache with incremental
  JPEG marker validation, length checks when available, and SHA-256. No decode,
  recompression, rotation or EXIF rewriting occurs on the original path
- Up to 48 tray entries, 128 MiB per JPEG and 256 MiB of retained private originals;
  one camera read at a time. JSON is bounded to 8 MiB, 16 nested levels and
  200,000 parser values; listing is capped at 100,000 entries / 50,000 JPEGs
- Thumbnails are separately limited to 2 MiB each and one page of 20; decoding
  checks dimensions and downsamples to at most 640 pixels per side
- Connection deadline: 12 seconds; read idle timeout: 15 seconds; total deadline:
  25 seconds for metadata, 180 seconds for images
- An explicit confirmed save creates a **new** app-owned `IS_PENDING=1` image,
  copies the original, rereads it and compares SHA-256, then clears pending
  state. Existing photos are never overwritten. Camera folder + random session
  prefix distinguishes names; MediaStore handles any remaining name collision
- Failure/cancellation removes only the newly created still-pending row and
  preserves the original cache for retry. A private journal retries unfinished
  pending cleanup on startup. Published rows are never deleted by cleanup,
  including when a process dies after publishing but before journal removal
- The small insert-before-journal crash window is handled by MediaStore's own
  pending-item expiry. No whole-library scan is performed to find such rows
- Android/gallery cloud backup settings may upload Pictures after saving. The
  confirmation dialog discloses this; the app itself never uploads photos

SHA-256 identifies the received bytes, not an independent camera checksum.
Marker validation is structural validation, not a full entropy decoder. For
end-to-end proof, compare a saved file with a card-reader copy.

## Cancellation, retry and lifecycle

Cancel preserves completed cache originals. Retry restarts a failed/cancelled
original from byte zero, at most three attempts per entry. It never assumes
HTTP Range support. Ready/saved entries are not retransferred in the same
session; same filenames in different folders remain distinct.

Every reconnect/refresh/demo switch creates a fresh random session. Older failed
entries cannot be retried against a new card/camera: reconnect and explicitly
select missing filenames again. No persistent camera identifier is collected.
Disconnect invalidates the source and stops pending work, retaining ready files.

Rotation retains the controller and tray in the Application, preserving selection
and page state. Leaving the foreground cancels unfinished work; it is not a
background-transfer service. A confirmed save already published is never undone
by subsequent cancellation. Declining a save does not call the save transaction.

**Ready files are temporary private cache, not durable storage.** The UI warns to
save before leaving and asks before Back/Clear could abandon unsaved originals.
If Android kills the process, the tray is lost; startup discards this app's orphan
cache files and removes its recorded unfinished pending rows. Files already
published to Pictures survive. The native instrumentation includes a separate prepare / force-stop / restart
check: it creates a synthetic published image, an app-owned pending row and an
orphan cache file, then verifies pending cleanup preserves the published bytes.
Real-phone lifecycle behavior still needs the hardware checklist below.

## Hardware acceptance checklist

- Install a locally built APK only on a device explicitly authorized for testing
- Android 10, a recent Android version, and Android 16 / target-36 network policy
- Portrait/landscape rotation and font scaling while browsing/transferring/saving
- GR III with JPEG, JPEG+RAW, RAW-only, large and empty cards; exact identity
  rejection for GR IIIx, IV and a non-camera device at the fixed address
- Camera Wi-Fi without Internet while cellular remains the default network
- Camera sleeps, walks out of range or loses Wi-Fi during list/thumbnail/original
- Cancel before queued read, mid-original, mid-save and immediately after publish
- Disconnect/reconnect and changing cards with the same folder/filenames
- No free disk space, failed MediaStore publish/readback, cancelled save dialog
- Background/Back/rotation/force-stop/process death; pending cleanup never removes
  saved or other-app photos; privacy banner and unsaved-cache warning remain clear
- Compare SHA-256 and metadata of the saved original to a card-reader original
- Native gallery visibility and any enabled third-party photo backup behavior

## Official Android references

- [Per-Network connections](https://developer.android.com/reference/android/net/Network#openConnection(java.net.URL,%20java.net.Proxy))
- [App-owned media and pending MediaStore writes](https://developer.android.com/training/data-storage/shared/media)
- [Local network permissions](https://developer.android.com/privacy-and-security/local-network-permission)
- [AGP 8.13 compatibility](https://developer.android.com/build/releases/agp-8-13-0-release-notes)

### Hosted build checks

The Android SDK agreement was accepted for this development task on October 5,
2026. Pull requests now run the SDK-free JVM contracts and source audit, then
lint the application and compile both the application and instrumentation APKs using the
runner's official Android SDK. APK artifacts are test builds, not production
release identities. Hosted build success does not imply emulator execution or
physical camera compatibility; the emulator evidence above is a separate local
run, and the hardware checklist remains open.
