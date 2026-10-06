'use strict';

const $ = id => document.getElementById(id);
const PAGE_SIZE = 24;
const MEMORY_LIMIT = 256 * 1024 * 1024;
const FILE_LIMIT = 128 * 1024 * 1024;
const QUEUE_LIMIT = 48;
const MAX_ATTEMPTS = 3;
const DOWNLOAD_GRACE_MS = 30000;
const DOWNLOAD_LEASE_LIMIT = MEMORY_LIMIT + 1024 * 1024;
const state = { session: null, photos: [], selected: new Set(), page: 1, busy: true, connecting: false, generation: 0, queue: [], running: false, pauseRequested: false, controller: null, previewId: null, retained: 0, requestController: new AbortController(), restoreClearedTray: false, verifying: false, batchVerifying: false, receiptController: null, exporting: false, archive: null, archiveController: null, downloadLeases: new Map(), leasedBytes: 0 };
let entryId = 0;
let unloadGuardActive = false;
// Reuse locale collation and one derived list, rather than sorting the whole card
// again for every selection, preview toggle or page navigation.
const photoNameCollator = new Intl.Collator('zh-CN', { numeric: true });
const photoFolderCollator = new Intl.Collator('zh-CN');
let galleryCache = null;
const thumbnailFailures = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function icon(name, small = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon${small ? ' small' : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '大小未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function knownSize(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function dateValue(value) { return value ? Date.parse(value) : NaN; }
function dateLabel(value) {
  const time = dateValue(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未提供';
}
function safeLocalUrl(value) {
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('本机程序返回了非本机照片地址，已停止请求。');
  return value;
}
function notify(message, error = false) {
  $('notice-text').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
}
// Keep protocol codes stable; present actionable Chinese messages at the UI boundary.
function cameraErrorMessage(code, status) {
  const messages = {
    CAMERA_UNREACHABLE: '无法连接相机。请加入 GR III 的 Wi-Fi，保持相机开机后重试。',
    CAMERA_TIMEOUT: '相机响应超时。请将相机移近，保持开机后重试。',
    WRONG_MODEL: '当前设备不是受支持的 RICOH GR III，请检查相机网络。',
    INVALID_CSRF: '本机会话已更新。请先保存原片，再刷新页面重连。',
    UNSUPPORTED_RESPONSE: '无法识别相机响应，可能与固件版本有关。请重试一次。',
    INVALID_CAMERA_RESPONSE: '相机响应不完整，请重新连接。',
    CAMERA_HTTP_ERROR: '相机未能完成请求，请保持相机开机后重试。',
    CAMERA_REPORTED_ERROR: '相机报告错误，请关闭其他相机应用后重试。',
    LIST_TOO_LARGE: '相机返回的照片列表过大，超出此测试版本的安全上限。',
    ENCODED_RESPONSE: '相机返回了编码后的数据，已停止传输以保护原始文件。',
    NOT_JPEG: '返回的文件不是 JPEG，已停止传输。',
    INCOMPLETE_JPEG: 'JPEG 文件不完整，请检查相机连接后重新传输。',
    INVALID_FILE_SIZE: '文件大小无效或超出限制，已停止传输。',
    STALE_SESSION: '连接已更新，请从当前照片列表重新选择。',
    PHOTO_NOT_FOUND: '这张照片已不可用，请刷新列表后重新选择。',
    DISCONNECTED: '相机已断开，请重新连接后传输。',
    CANCELLED: '操作已取消。',
    INVALID_PHOTO_PATH: '照片路径未通过安全检查，已停止请求。',
    ENDPOINT_NOT_ALLOWED: '相机请求地址未通过安全检查。',
    INVALID_VARIANT: '不支持此图片类型。',
    INTERNAL_ERROR: '本机程序遇到问题，请保存已完成原片后重启程序。',
    BRIDGE_ERROR: '本机程序暂不可用，请确认程序正在运行。',
  };
  return messages[code] || `操作未完成${status ? `（${status}）` : ''}，请检查连接后重试。`;
}
function userError(error) {
  if (error?.code) return cameraErrorMessage(error.code);
  return typeof error?.message === 'string' && /[\u3400-\u9fff]/.test(error.message)
    ? error.message : '操作未完成，请检查连接或浏览器支持后重试。';
}
async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: state.requestController.signal, ...options });
  let result;
  try { result = await response.json(); } catch { throw new Error('无法读取本机程序的响应。请重启程序，再刷新页面。'); }
  if (!response.ok) {
    const error = new Error(cameraErrorMessage(result.code, response.status));
    error.code = typeof result.code === 'string' ? result.code : 'BRIDGE_ERROR';
    error.cameraStage = ['identity', 'listing'].includes(result.cameraStage) ? result.cameraStage : null;
    throw error;
  }
  return result;
}
async function post(path, body = {}) {
  const generation = state.generation;
  const session = state.session?.csrfToken ? state.session : await api('/api/session');
  if (generation !== state.generation) throw new DOMException('之前的页面会话已结束。', 'AbortError');
  state.session = session;
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(body) });
}
function setBusy(value) { state.busy = value; updateControls(); }
function updateControls() {
  renderTransferPlan();
  updateUnloadGuard();
  const blocked = state.busy || state.running || state.exporting || state.verifying;
  for (const id of ['landing-connect', 'try-demo', 'switch-camera', 'refresh', 'confirm-connect']) $(id).disabled = blocked;
  $('disconnect').disabled = state.busy || state.exporting || state.verifying;
  $('batch-receipt').disabled = !state.batchVerifying && (blocked || !state.queue.some(entry => entry.blob));
  $('batch-receipt').textContent = state.batchVerifying ? '取消批次校验' : '导出批次校验清单';
  $('build-archive').disabled = blocked || !state.queue.some(entry => entry.blob);
  $('build-archive').hidden = state.exporting;
  $('save-archive').hidden = !state.archive;
  $('save-archive').disabled = state.exporting || state.verifying;
  $('cancel-archive').hidden = !state.exporting;
  $('transfer').disabled = blocked || !state.selected.size;
  $('mobile-transfer').disabled = blocked || !state.selected.size;
  $('clear-queue').disabled = blocked;
  $('clear-handed').disabled = blocked;
  $('clear-handed').hidden = !state.queue.some(entry => entry.status === 'handed-off' || entry.archiveHandedOff);
  $('select-batch').disabled = blocked || !state.session?.connected;
  $('retry-unfinished').disabled = blocked || !state.queue.some(canRetry);
  $('pause-queue').hidden = !state.running;
  $('pause-queue').textContent = state.pauseRequested ? '取消暂停' : '本张完成后暂停';
  $('resume-queue').hidden = state.running || !state.queue.some(entry => entry.status === 'queued' && currentSource(entry));
  $('resume-queue').disabled = blocked;
  $('cancel-queue').hidden = !state.running && !state.queue.some(entry => entry.status === 'queued');
  $('clear-queue').hidden = state.running;
  $('cancel-connect').hidden = !state.connecting;
  $('confirm-connect').textContent = state.busy && $('connect-dialog').open ? '正在连接…' : '连接相机';
  $('refresh').setAttribute('aria-busy', String(state.busy));
}
function release(entry) {
  entry.receipt = null;
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  entry.objectUrl = null;
  state.retained = Math.max(0, state.retained - (entry.blobBytes || 0));
  entry.blobBytes = 0;
  entry.blob = null;
}
function unhandedOriginal(entry) { return Boolean(entry.blob) && entry.status !== 'handed-off' && !entry.archiveHandedOff; }
function confirmDiscard(entries) {
  const count = entries.filter(unhandedOriginal).length;
  return !count || window.confirm(`丢弃这 ${count} 张尚未保存的原片？建议先保存副本。移除后无法恢复本页中的副本，相机上的文件不受影响。`);
}
function warnBeforeUnload(event) {
  if (!state.running && !state.queue.some(unhandedOriginal)) return;
  event.preventDefault(); event.returnValue = '';
}
function updateUnloadGuard() {
  const needed = state.running || state.queue.some(unhandedOriginal);
  if (needed === unloadGuardActive) return;
  window[needed ? 'addEventListener' : 'removeEventListener']('beforeunload', warnBeforeUnload);
  unloadGuardActive = needed;
}
function clearQueue() {
  if (state.running || state.exporting || state.verifying || !confirmDiscard(state.queue)) return;
  invalidateArchive();
  state.queue.forEach(release);
  state.queue = [];
  renderQueue();
}
function clearHandedOff() {
  if (state.busy || state.running || state.exporting || state.verifying) return;
  const completed = state.queue.filter(entry => entry.status === 'handed-off' || entry.archiveHandedOff);
  if (!completed.length || !window.confirm(`清理这 ${completed.length} 张临时原片前，请确认下载文件夹中的文件或 ZIP 已完整保存。浏览器接收下载请求不代表已写入磁盘。继续清理？`)) return;
  invalidateArchive(); completed.forEach(release);
  const removed = new Set(completed); state.queue = state.queue.filter(entry => !removed.has(entry));
  renderQueue(); notify(`已清理 ${completed.length} 张已交给浏览器的临时原片，未保存项目仍保留。`);
}
function placeTray() {
  const connected = Boolean(state.session?.connected);
  const slot = connected ? $('connected-tray') : $('offline-tray');
  if ($('queue-panel').parentElement !== slot) slot.append($('queue-panel'));
  $('offline-transfers').hidden = connected || !state.queue.length;
  $('offline-title').textContent = state.queue.some(entry => entry.blob) ? '已传输的原片仍可保存' : '传输已停止';
}
function currentSource(entry) { return state.session?.connected && entry.sourceId === state.session.sessionId; }
function unfinished(entry) { return ['failed', 'cancelled'].includes(entry.status); }
function canRetry(entry) { return unfinished(entry) && !entry.blob && currentSource(entry) && entry.attempts < MAX_ATTEMPTS && entry.retryable !== false; }
function renderSession() {
  const session = state.session;
  const connected = Boolean(session?.connected);
  $('landing').hidden = connected;
  $('workspace').hidden = !connected;
  placeTray();
  if (!connected) { $('mobile-selection').hidden = true; document.body.classList.remove('has-selection'); }
  const badge = $('connection-badge');
  badge.className = `status-pill ${connected ? session.mode : ''}`;
  badge.replaceChildren(element('i'), document.createTextNode(connected ? session.mode === 'demo' ? '示例演示' : '已连接 · 待实机验证' : '未连接'));
  if (connected) {
    $('demo-banner').hidden = session.mode !== 'demo';
    $('source-model').textContent = session.mode === 'demo' ? 'Ricoh GR III · 演示' : session.model || 'Ricoh GR III';
    $('source-detail').textContent = session.mode === 'demo' ? '生成的示例图片 · 未连接相机' : `Wi-Fi · 待实机验证${session.firmware ? ` · 固件 ${session.firmware}` : ''}`;
    $('source-state').replaceChildren(element('i'), document.createTextNode(session.mode === 'demo' ? '演示模式' : '本机连接'));
    $('gallery-description').textContent = session.mode === 'demo' ? '先用示例图片体验选择、传输与保存。' : '选择喜欢的照片，带走完整原片。';
  }
  updateControls();
}
function applyPhotos(result) {
  thumbnailFailures.clear();
  state.cardSummary = result.summary || null;
  renderCardFormats();
  state.photos = (Array.isArray(result.photos) ? result.photos : []).filter(photo => photo && typeof photo.id === 'string').map(photo => ({ ...photo, name: String(photo.name || 'Untitled.JPG'), folder: String(photo.folder || '') }));
  const valid = new Set(state.photos.map(photo => photo.id));
  state.selected = new Set([...state.selected].filter(id => valid.has(id)));
  const oldFolder = $('folder').value;
  $('folder').replaceChildren(new Option('全部文件夹', ''));
  [...new Set(state.photos.map(photo => photo.folder))].sort().forEach(folder => $('folder').append(new Option(folder || '未知文件夹', folder)));
  if ([...$('folder').options].some(option => option.value === oldFolder)) $('folder').value = oldFolder;
  renderGallery();
}
function renderCardFormats() {
  const summary = state.cardSummary;
  const panel = $('card-formats');
  panel.hidden = !summary;
  panel.textContent = summary ? `${summary.jpeg} 张 JPEG 原片 · 已排除 ${summary.raw} 个 RAW、${summary.other} 个其他文件。JPEG+RAW 仅传输 JPEG，不转换 RAW。${summary.duplicateEntries ? ` 已忽略 ${summary.duplicateEntries} 条重复记录。` : ''}` : '';
}
function connectionAdvice(code) {
  const advice = {
    CAMERA_UNREACHABLE: ['检查这台电脑的 Wi-Fi', '让运行本机程序的电脑加入 GR III 显示的 Wi-Fi，仅让手机连接是不够的。', '保持相机开机，关闭其他相机应用后重试。'],
    CAMERA_TIMEOUT: ['相机响应超时', '把相机移近一些，并保持开机。', '关闭其他相机应用后重试，原片没有被修改。'],
    WRONG_MODEL: ['检查已连接的相机', '目前仅支持设备型号为 RICOH GR III 的相机。', '请让这台电脑重新加入 GR III 网络，其他型号暂不支持。'],
    INVALID_CSRF: ['刷新本地页面', '本机程序可能已重启。请先保存已完成的原片，再刷新页面。', '刷新页面后重新连接。'],
    UNSUPPORTED_RESPONSE: ['无法识别相机响应', '这个固件可能使用了不同的响应格式。', '可以重试一次。如果问题持续，请使用原有传输方式，无需为此更改相机设置。'],
  };
  return advice[code] || ['请检查连接', '保持相机开机，检查这台电脑的 Wi-Fi 后重试。', '本页已完成的原片仍可保存。'];
}
function showConnectionAdvice(code, stage) {
  const [heading, ...steps] = connectionAdvice(code);
  const panel = $('connect-recovery');
  panel.replaceChildren(element('h3', '', heading));
  if (stage) panel.append(element('p', '', stage === 'listing' ? '已确认 GR III 型号，但照片列表未读取完成，尚未请求原片。' : '尚未确认相机型号，没有读取照片列表或原片。'));
  const list = element('ol');
  steps.forEach(step => list.append(element('li', '', step)));
  panel.append(list);
  panel.hidden = false;
}
async function connect(mode) {
  if (state.busy || state.running || state.exporting || state.verifying) return;
  state.connecting = true;
  setBusy(true);
  const generation = ++state.generation;
  $('connect-error').hidden = true;
  $('connect-recovery').hidden = true;
  try {
    const session = await post('/api/connect', { mode });
    if (generation !== state.generation) return;
    state.session = session;
    state.selected.clear();
    state.page = 1;
    $('search').value = '';
    $('folder').value = '';
    $('selected-only').checked = false;
    $('unqueued-only').checked = false;
    const result = await api('/api/photos');
    if (generation !== state.generation) return;
    applyPhotos(result);
    renderQueue();
    renderSession();
    state.connecting = false;
    closeDialog($('connect-dialog'));
    $('notice').hidden = true;
    if (mode === 'camera') notify('相机已响应。此测试版本仍待真实 GR III 硬件验证。');
  } catch (error) {
    if (generation !== state.generation) return;
    // A failed connection may have reset the server session. Reconcile rather than leaving an old gallery active.
    let session;
    try { session = await api('/api/session'); } catch { session = { mode: 'disconnected', connected: false }; }
    if (generation !== state.generation) return;
    state.session = session;
    state.photos = [];
    galleryCache = null;
    state.selected.clear();
    renderQueue();
    renderSession();
    const message = userError(error) || '连接失败，请检查本机程序和相机 Wi-Fi。';
    if ($('connect-dialog').open) { $('connect-error').textContent = message; $('connect-error').hidden = false; showConnectionAdvice(error.code, error.cameraStage); }
    else notify(message, true);
  } finally {
    if (generation === state.generation) { state.connecting = false; setBusy(false); }
  }
}
async function cancelConnection() {
  if (!state.connecting) return;
  state.connecting = false;
  const generation = ++state.generation;
  state.requestController.abort();
  state.requestController = new AbortController();
  setBusy(true);
  try {
    const session = await post('/api/disconnect');
    if (generation !== state.generation) return;
    state.session = session;
    state.photos = [];
    galleryCache = null;
    state.selected.clear();
    renderGallery(); renderQueue(); renderSession();
    notify('已取消连接，已完成的原片仍可保存。');
  } catch (error) {
    if (generation !== state.generation) return;
    state.session = null; state.photos = []; galleryCache = null; state.selected.clear();
    renderGallery(); renderQueue(); renderSession();
    notify(`本页已停止连接，但未能确认本机程序已断开。请重新连接后再传输。${userError(error)}`, true);
  } finally { if (generation === state.generation) setBusy(false); }
}
async function disconnect() {
  if (state.busy || state.exporting || state.verifying) return;
  setBusy(true);
  const generation = ++state.generation;
  state.controller?.abort();
  state.controller = null;
  state.running = false;
  state.queue.filter(entry => ['queued', 'transferring'].includes(entry.status)).forEach(entry => { entry.status = 'cancelled'; });
  renderQueue();
  try {
    const session = await post('/api/disconnect');
    if (generation !== state.generation) return;
    state.session = session;
    state.photos = [];
    galleryCache = null;
    state.selected.clear();
    closeDialog($('preview-dialog'));
    renderQueue();
    renderSession();
    notify('已断开连接。已完成的原片仍可保存，未完成的传输已取消。');
  } catch (error) {
    if (generation !== state.generation) return;
    notify(`已停止传输，但未能确认本机程序已断开。已完成的原片仍可保存。${userError(error)}`, true);
  } finally { if (generation === state.generation) setBusy(false); }
}
async function refresh() {
  if (state.busy || state.running || state.exporting || state.verifying) return;
  setBusy(true);
  const generation = state.generation;
  try {
    const result = await post('/api/refresh');
    if (generation !== state.generation) return;
    applyPhotos(result);
    notify('照片列表已刷新，仍存在的照片会保留选择。');
  } catch (error) { if (generation === state.generation) notify(userError(error), true); }
  finally { if (generation === state.generation) setBusy(false); }
}
function filteredPhotos() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const folder = $('folder').value;
  const sort = $('sort').value;
  if (galleryCache && galleryCache.photos === state.photos && galleryCache.query === query && galleryCache.folder === folder && galleryCache.sort === sort) return galleryCache.list;
  const terms = query.split(/\s+/).filter(Boolean);
  const list = state.photos.filter(photo => (!folder || photo.folder === folder) && terms.every(term => `${photo.folder}/${photo.name}`.toLocaleLowerCase().includes(term)));
  const nameCompare = (a, b) => photoNameCollator.compare(a.name, b.name) || photoFolderCollator.compare(a.folder, b.folder);
  list.sort((a, b) => {
    if (sort === 'name-asc') return nameCompare(a, b);
    if (sort === 'name-desc') return -nameCompare(a, b);
    if (sort === 'size-desc') return (knownSize(b.bytes) ? b.bytes : -1) - (knownSize(a.bytes) ? a.bytes : -1) || nameCompare(a, b);
    const at = dateValue(a.takenAt), bt = dateValue(b.takenAt);
    return (Number.isFinite(bt) ? bt : -Infinity) - (Number.isFinite(at) ? at : -Infinity) || nameCompare(a, b);
  });
  galleryCache = { photos: state.photos, query, folder, sort, list };
  return list;
}
function currentPage() {
  const filtered = filteredPhotos();
  const queued = $('unqueued-only').checked ? new Set(state.queue.filter(currentSource).map(entry => entry.photo.id)) : null;
  const list = filtered.filter(photo => (!$('selected-only').checked || state.selected.has(photo.id)) && (!queued || !queued.has(photo.id)));
  state.page = Math.max(1, Math.min(state.page, Math.ceil(list.length / PAGE_SIZE) || 1));
  return { list, visible: list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE) };
}
function toggleSelection(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  if ($('selected-only').checked) renderGallery(); else renderSelection();
}
function renderSelection() {
  const chosen = state.photos.filter(photo => state.selected.has(photo.id));
  $('selection-count').textContent = String(chosen.length);
  $('mobile-selection-count').textContent = String(chosen.length);
  $('mobile-selection').hidden = !chosen.length || !state.session?.connected;
  document.body.classList.toggle('has-selection', chosen.length > 0 && Boolean(state.session?.connected));
  const total = chosen.reduce((sum, photo) => sum + (knownSize(photo.bytes) ? photo.bytes : 0), 0);
  const unknown = chosen.filter(photo => !knownSize(photo.bytes)).length;
  $('selection-size').textContent = !chosen.length ? '选几张喜欢的照片吧' : unknown ? `${total ? `已知 ${bytes(total)} · ` : ''}${unknown} 张大小未知` : `共 ${bytes(total)} · JPEG 原片`;
  $('clear-selection').disabled = !chosen.length;
  const visible = currentPage().visible;
  const visibleSelected = visible.filter(photo => state.selected.has(photo.id)).length;
  $('select-visible').disabled = !visible.length;
  $('invert-visible').disabled = !visible.length;
  $('deselect-visible').disabled = !visibleSelected;
  $('selection-visibility').textContent = chosen.length ? `本页已选 ${visibleSelected} 张 · 其他页 ${chosen.length - visibleSelected} 张` : '尚未选择照片';
  for (const card of $('gallery').children) {
    const selected = state.selected.has(card.dataset.photoId);
    card.classList.toggle('selected', selected);
    card.querySelector('input').checked = selected;
  }
  if (state.previewId) {
    const selected = state.selected.has(state.previewId);
    $('preview-select').textContent = selected ? '取消选择' : '选择这张';
    $('preview-select').setAttribute('aria-pressed', String(selected));
    renderPreviewNavigation();
  }
  updateControls();
}
function attachThumbnailRecovery(image, photo, card) {
  const generation = state.generation;
  const recovery = element('div', 'thumbnail-recovery');
  const message = element('span', '', '缩略图暂不可用');
  const retry = element('button', 'text-button', '重试缩略图');
  retry.type = 'button'; retry.setAttribute('aria-label', `重试 ${photo.name} 的缩略图`);
  recovery.append(message, retry); recovery.hidden = true;
  const failed = () => {
    const record = thumbnailFailures.get(photo.id) || { attempts: 1 };
    record.failed = true; thumbnailFailures.set(photo.id, record);
    image.hidden = true; image.alt = `缩略图不可用：${photo.name}`;
    recovery.hidden = false; retry.disabled = record.attempts >= 3;
    message.textContent = record.attempts >= 3 ? '缩略图仍不可用，请检查 Wi-Fi 后刷新。' : '缩略图暂不可用';
  };
  const request = () => {
    try { image.removeAttribute('src'); image.src = safeLocalUrl(photo.thumbnailUrl); }
    catch { failed(); retry.disabled = true; message.textContent = '缩略图地址不可用，请刷新照片列表。'; }
  };
  image.addEventListener('error', () => { if (generation === state.generation && image.isConnected) failed(); });
  image.addEventListener('load', () => {
    if (generation !== state.generation || !image.isConnected) return;
    thumbnailFailures.delete(photo.id); recovery.hidden = true; image.hidden = false;
    image.alt = photo.synthetic ? `生成的示例图片：${photo.name}` : `${photo.name} 的预览图`;
  });
  retry.addEventListener('click', () => {
    if (generation !== state.generation || !image.isConnected || !state.session?.connected) return;
    const record = thumbnailFailures.get(photo.id);
    if (!record?.failed || record.attempts >= 3) return;
    record.attempts++; record.failed = false; retry.disabled = true;
    message.textContent = '正在重试缩略图…'; request();
  });
  card.append(recovery);
  // A rerender must not silently restart an interrupted retry or reset its budget.
  if (thumbnailFailures.has(photo.id)) failed(); else request();
}
function renderGallery() {
  const { list, visible } = currentPage();
  $('gallery').replaceChildren();
  visible.forEach((photo, index) => {
    const card = element('article', 'photo-card');
    card.dataset.photoId = photo.id;
    const preview = element('button', 'photo-image-button');
    preview.type = 'button';
    preview.setAttribute('aria-label', `预览 ${photo.name}${photo.synthetic ? '，示例图片' : ''}`);
    const image = element('img');
    image.alt = photo.synthetic ? `生成的示例图片：${photo.name}` : `${photo.name} 的预览图`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    preview.append(image, element('span', 'photo-index', String((state.page - 1) * PAGE_SIZE + index + 1).padStart(2, '0')));
    preview.addEventListener('click', () => showPreview(photo.id));
    const label = element('label', 'photo-select');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `选择 ${photo.name}`);
    checkbox.addEventListener('change', () => toggleSelection(photo.id));
    label.append(checkbox, icon('check'));
    const meta = element('div', 'photo-meta');
    const detail = element('div');
    const title = element('h3', '', photo.name);
    title.title = photo.name;
    if (photo.rawCompanions?.length) detail.append(element('p', 'photo-raw', 'JPEG + RAW · 仅传 JPEG'));
    detail.append(title, element('p', '', `${photo.folder} · ${bytes(photo.bytes)}`));
    meta.append(detail, element('span', 'photo-type', photo.synthetic ? '示例' : 'JPG'));
    card.append(preview, label, meta);
    $('gallery').append(card);
    attachThumbnailRecovery(image, photo, card);
  });
  $('photo-count').textContent = `${list.length} 张照片${list.length !== state.photos.length ? ` / 共 ${state.photos.length} 张` : ''}`;
  $('gallery-empty').hidden = list.length !== 0;
  $('empty-description').textContent = state.photos.length ? ($('selected-only').checked ? '已选照片中没有符合筛选条件的项目。取消“只看已选”可继续选片。' : '试试其他文件名或文件夹。') : state.cardSummary?.raw ? '存储卡列表只有 RAW，没有 JPEG。目前不支持 RAW 传输，请使用读卡器或原有 RAW 工具。此应用不会转换 RAW 或修改相机设置。' : '相机没有返回 JPEG 照片，请检查相机后刷新。';
  $('reset-filters').hidden = !state.photos.length;
  renderPagination(list.length);
  renderSelection();
}
function renderPagination(total) {
  let pager = $('pagination');
  if (!pager) {
    pager = element('nav', 'pagination');
    pager.id = 'pagination';
    pager.setAttribute('aria-label', '照片分页');
    $('gallery').after(pager);
  }
  pager.replaceChildren();
  const pages = Math.ceil(total / PAGE_SIZE);
  pager.hidden = pages <= 1;
  if (pages <= 1) return;
  const previous = element('button', 'button secondary compact', '上一页');
  previous.type = 'button'; previous.disabled = state.page === 1;
  previous.addEventListener('click', () => { state.page--; renderGallery(); $('search').focus({ preventScroll: true }); });
  const next = element('button', 'button secondary compact', '下一页');
  next.type = 'button'; next.disabled = state.page === pages;
  next.addEventListener('click', () => { state.page++; renderGallery(); $('search').focus({ preventScroll: true }); });
  pager.append(previous, element('span', '', `${state.page} / ${pages}`), next);
}
function openDialog(dialog) { if (!dialog.open) dialog.showModal(); document.body.classList.add('has-modal'); }
function clearPreview() {
  state.previewId = null;
  $('preview-image').removeAttribute('src');
  $('preview-image').alt = '';
}
function closeDialog(dialog) {
  if (dialog === $('connect-dialog') && state.connecting) cancelConnection();
  if (dialog === $('preview-dialog')) clearPreview();
  if (dialog.open) dialog.close();
  if (![...document.querySelectorAll('dialog')].some(item => item.open)) document.body.classList.remove('has-modal');
}
function renderPreviewNavigation() {
  const list = currentPage().list;
  const index = list.findIndex(photo => photo.id === state.previewId);
  $('preview-previous').disabled = index <= 0;
  $('preview-next').disabled = index < 0 || index >= list.length - 1;
  $('preview-position').textContent = index < 0 ? '不在当前筛选范围' : `${index + 1} / ${list.length}`;
}
function navigatePreview(offset) {
  if (!$('preview-dialog').open || !state.previewId) return;
  const list = currentPage().list;
  const index = list.findIndex(photo => photo.id === state.previewId);
  if (index < 0 || !list[index + offset]) return;
  showPreview(list[index + offset].id);
}
function showPreview(id) {
  const photo = state.photos.find(item => item.id === id);
  if (!photo) return;
  state.previewId = id;
  $('preview-title').textContent = photo.name;
  $('preview-folder').textContent = photo.folder || '未知文件夹';
  $('preview-raw').hidden = !photo.rawCompanions?.length;
  $('preview-raw').textContent = photo.rawCompanions?.length ? `同一文件夹中还有同名 ${photo.rawCompanions.join(' / ')}。仅导入 JPEG，RAW 请使用读卡器。` : '';
  $('preview-size').textContent = bytes(photo.bytes);
  $('preview-dimensions').textContent = Number.isFinite(photo.width) && Number.isFinite(photo.height) ? `${photo.width} × ${photo.height} px` : '未提供';
  $('preview-date').textContent = dateLabel(photo.takenAt);
  $('preview-synthetic').hidden = !photo.synthetic;
  $('preview-image').alt = photo.synthetic ? `生成的示例图片：${photo.name}` : `${photo.name} 的预览图`;
  $('preview-image').removeAttribute('src');
  try { $('preview-image').src = safeLocalUrl(photo.previewUrl || photo.thumbnailUrl); } catch { $('preview-image').alt = '预览暂不可用'; }
  renderSelection();
  openDialog($('preview-dialog'));
}
function showHelp(kind) {
  const phone = kind === 'phone';
  $('help-title').textContent = phone ? '连接与使用' : '传输与保存';
  $('help-content').replaceChildren();
  const sections = phone ? [
    ['在这台电脑上使用', '此网页通过本机程序连接相机，只监听这台电脑的 localhost 地址。请在运行程序的电脑上打开它；手机访问自己的 localhost 无法连接这台电脑。'],
    ['在 Android 手机上使用', '项目另有 Android 10 及以上的原生测试应用，可通过手机已连接的相机 Wi-Fi 直接传输。网页不会配置防火墙、开放局域网服务或更改网络设置。真实相机与手机兼容性仍待验证。'],
    ['你的照片留在本机', '照片不会通过此应用上传。桌面端保存到浏览器的下载位置；Android 端需要明确确认后才写入 Pictures。系统或相册已启用的云备份可能自行上传已保存照片。']
  ] : [
    ['1. 选择并传输', '选择照片，点击“传输原片”。原片会逐张读取到本页的临时内存，保留 JPEG 与 EXIF 原始字节。仅在已知文件大小时显示百分比。'],
    ['2. 保存到电脑', '点击单张照片的“保存”，或将已完成原片打包为 ZIP 后保存。ZIP 保留文件夹和原始文件名，附带 SHA-256 校验清单。请到下载文件夹确认文件；浏览器接收下载不等于已经写入磁盘。'],
    ['关闭页面前先保存', '临时记录最多保留 48 项、256 MB，每张原片上限 128 MB。断开连接会保留已完成原片；清空、关闭或刷新页面会丢弃未保存内容。请分批传输和保存。'],
    ['传输中断了？', '恢复相机 Wi-Fi 后，点击“重试未完成项”。只重试当前连接中失败或取消的文件，每张从头开始，最多尝试三次。更换来源或重新连接后，请从当前照片列表重新选择。'],
    ['关于这个测试版本', '演示图片是生成的测试素材。真实理光 GR III 的 Wi-Fi 传输尚未通过物理硬件验证，目前不支持 RAW、GR IIIx 或 GR IV。']
  ];
  sections.forEach(([title, body]) => $('help-content').append(element('h3', '', title), element('p', '', body)));
  openDialog($('help-dialog'));
}
function transferPlan() {
  const selected = state.photos.filter(photo => state.selected.has(photo.id));
  const existing = new Set(state.queue.filter(currentSource).map(entry => entry.photo.id));
  const additions = selected.filter(photo => !existing.has(photo.id));
  const unknown = additions.filter(photo => !knownSize(photo.bytes)).length;
  const knownBytes = additions.reduce((sum, photo) => sum + (knownSize(photo.bytes) ? photo.bytes : 0), 0);
  let blocked = '';
  if (state.queue.length + additions.length > QUEUE_LIMIT) blocked = `最多同时保留 ${QUEUE_LIMIT} 项，请少选几张，或先清理已完成项目。`;
  else if (additions.some(photo => knownSize(photo.bytes) && photo.bytes > FILE_LIMIT)) blocked = '选中的原片超过 128 MB 单文件限制，请取消选择该照片。';
  else if (state.retained + state.leasedBytes + knownBytes > MEMORY_LIMIT) blocked = '这批照片超过 256 MB 暂存上限。请少选几张，或先保存并移除已完成原片。下载链接最多需要 30 秒释放。';
  return { additions, unknown, knownBytes, duplicates: selected.length - additions.length, blocked };
}
function selectNextBatch() {
  if (state.busy || state.running || state.exporting || state.verifying || !state.session?.connected) return;
  const queued = new Set(state.queue.filter(currentSource).map(entry => entry.photo.id));
  let remaining = Math.max(0, MEMORY_LIMIT - state.retained - state.leasedBytes);
  const slots = Math.max(0, QUEUE_LIMIT - state.queue.length), chosen = [];
  for (const photo of filteredPhotos()) {
    if (chosen.length >= slots) break;
    if (queued.has(photo.id)) continue;
    // Unknown sizes reserve the full single-file limit rather than promising a batch will fit.
    const reserve = knownSize(photo.bytes) ? photo.bytes : FILE_LIMIT;
    if (reserve > FILE_LIMIT || reserve > remaining) continue;
    chosen.push(photo.id); remaining -= reserve;
  }
  state.selected = new Set(chosen); state.page = 1; renderGallery();
  notify(chosen.length ? `已选择下一批 ${chosen.length} 张，仍需点击“传输原片”。未知大小按 128 MB 预留。` : '当前筛选下没有可容纳的新照片。请保存并清理原片，或调整筛选。');
}
function renderTransferPlan() {
  const plan = transferPlan();
  const parts = [`暂存 ${state.queue.length} / ${QUEUE_LIMIT} 项`, `已暂存 ${bytes(state.retained)}`];
  if (plan.additions.length) parts.push(`新传输 ${plan.additions.length} 张`, `已知 ${bytes(plan.knownBytes)}${plan.unknown ? `，另有 ${plan.unknown} 张大小未知` : ''}`);
  if (plan.duplicates) parts.push(`跳过 ${plan.duplicates} 张已在列表中的照片`);
  if (state.leasedBytes) parts.push(`下载链接暂占 ${bytes(state.leasedBytes)}`);
  $('transfer-plan').textContent = !state.selected.size && !state.queue.length ? '' : plan.blocked || parts.join(' · ') + (plan.unknown ? '。大小未知的文件会在传输时检查，内存有限时请分批传输。' : '');
  $('transfer-plan').classList.toggle('blocked', Boolean(plan.blocked));
}
function addToQueue() {
  if (state.running || state.busy || state.exporting || state.verifying) return;
  const plan = transferPlan();
  const additions = plan.additions;
  if (!additions.length) { notify('这些照片已在传输记录中。可保存原片、重试失败项，或移除后重新传输。'); return; }
  if (plan.blocked) { notify(plan.blocked, true); return; }
  invalidateArchive();
  additions.forEach(photo => state.queue.push({ id: ++entryId, sourceId: state.session.sessionId, sourceMode: state.session.mode, photo: { ...photo }, status: 'queued', received: 0, expected: knownSize(photo.bytes) ? photo.bytes : null, attempts: 0, objectUrl: null, blob: null, blobBytes: 0, retryable: true, error: '' }));
  renderQueue();
  runQueue();
}
function durationLabel(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return whole < 60 ? `${whole} 秒` : `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
}
function transferTiming(entry) {
  if (!Number.isFinite(entry.startedAt)) return '';
  const seconds = Math.max(0, ((entry.finishedAt ?? performance.now()) - entry.startedAt) / 1000);
  const parts = [`已用 ${durationLabel(seconds)}`];
  if (seconds >= 1 && entry.received > 0) {
    const rate = entry.received / seconds;
    parts.push(`平均 ${bytes(rate)}/秒`);
    if (knownSize(entry.expected) && entry.expected > entry.received) parts.push(`约剩 ${durationLabel((entry.expected - entry.received) / rate)}`);
  }
  return parts.join(' · ');
}
async function verifyOriginal(entry) {
  if (state.busy || state.running || state.exporting || state.verifying || !state.queue.includes(entry) || !entry.blob) return;
  const generation = state.generation, blob = entry.blob;
  state.verifying = true; entry.verifying = true; entry.verificationError = '';
  const controller = new AbortController(); state.receiptController = controller;
  renderQueue();
  try {
    const receipt = await GRTransferFiles.buildReceipt(entry, { signal: controller.signal });
    if (controller.signal.aborted || generation !== state.generation || entry.blob !== blob || !state.queue.includes(entry)) return;
    entry.receipt = receipt;
  } catch (error) {
    if (generation === state.generation) entry.verificationError = controller.signal.aborted ? '已取消校验，原片仍可保存。' : `暂时无法校验：${userError(error)}`;
  } finally {
    entry.verifying = false;
    if (state.receiptController === controller) { state.verifying = false; state.receiptController = null; renderQueue(); }
  }
}
async function exportBatchReceipt() {
  if (state.batchVerifying) { state.receiptController?.abort(); return; }
  if (state.busy || state.running || state.exporting || state.verifying) return;
  const entries = state.queue.filter(entry => entry.blob);
  if (!entries.length) return;
  const generation = state.generation, controller = new AbortController();
  state.batchVerifying = true; state.verifying = true; state.receiptController = controller;
  $('batch-receipt-status').textContent = '正在校验原片…'; renderQueue();
  try {
    const result = await GRTransferFiles.buildBatchReceipt(entries, { signal: controller.signal, onProgress: (done, total) => {
      if (generation === state.generation) $('batch-receipt-status').textContent = `已校验 ${done} / ${total} 张`;
    } });
    if (generation !== state.generation || controller.signal.aborted) return;
    handoffDownload(result.blob, result.filename);
    $('batch-receipt-status').textContent = `已将 ${entries.length} 张原片的校验清单交给浏览器。清单不包含照片，请另行保存原片。`;
  } catch (error) {
    if (generation === state.generation) $('batch-receipt-status').textContent = controller.signal.aborted ? '已取消校验，原片仍可保存。' : userError(error);
  } finally {
    if (state.receiptController === controller) { state.receiptController = null; state.verifying = false; state.batchVerifying = false; renderQueue(); }
  }
}
function itemStatus(entry) {
  if (entry.status === 'queued') return '等待传输';
  if (entry.status === 'transferring') return `${bytes(entry.received)}${knownSize(entry.expected) ? ` / ${bytes(entry.expected)}` : ' 已传输 · 总大小未知'} · ${transferTiming(entry)}`;
  if (entry.status === 'ready') return `${bytes(entry.blobBytes)} · 等待保存`;
  if (entry.status === 'handed-off') return '已交给浏览器 · 请检查下载文件夹';
  if (unfinished(entry) && !currentSource(entry)) return '来源已断开或变更，请重新连接并选择这张照片';
  if (entry.status === 'cancelled') return `已取消 · 未保存文件${entry.attempts >= MAX_ATTEMPTS ? ' · 已达到重试上限，请检查连接后移除并重新选择。' : ''}`;
  return entry.error || '传输失败 · 未保存文件';
}
function visibleQueueEntries() {
  const filter = $('queue-filter').value;
  return state.queue.filter(entry => filter === 'ready' ? unhandedOriginal(entry) : filter === 'unfinished' ? unfinished(entry) : filter === 'handed' ? entry.status === 'handed-off' || entry.archiveHandedOff : filter === 'waiting' ? ['queued', 'transferring'].includes(entry.status) : true);
}
function renderQueue() {
  if (!state.running) state.queue.filter(entry => entry.status === 'queued' && !currentSource(entry)).forEach(entry => { entry.status = 'cancelled'; });
  $('queue-panel').hidden = state.queue.length === 0;
  $('queue-list').replaceChildren();
  const visibleEntries = visibleQueueEntries();
  $('queue-empty-filter').hidden = !state.queue.length || visibleEntries.length > 0;
  visibleEntries.forEach(entry => {
    const row = element('article', 'queue-item');
    row.id = `queue-${entry.id}`;
    row.dataset.state = entry.status;
    const top = element('div', 'queue-item-top');
    const img = element('img', 'queue-thumb');
    img.alt = ''; img.loading = 'lazy';
    if (currentSource(entry)) { try { img.src = safeLocalUrl(entry.photo.thumbnailUrl); } catch { /* Text still identifies the file. */ } }
    else img.hidden = true;
    const info = element('div', 'queue-item-info');
    const name = element('p', 'queue-item-name', entry.photo.name); name.title = entry.photo.name;
    info.append(name, element('p', 'queue-item-source', `${entry.photo.folder} · ${entry.sourceMode === 'demo' ? '示例图片' : 'GR III 相机'}`), element('p', 'queue-item-status', itemStatus(entry)));
    if (entry.blob) info.append(element('p', 'queue-save-name', `保存为 ${GRTransferFiles.downloadName(entry.photo)}`));
    top.append(img, info);
    if (entry.status === 'ready' || entry.status === 'handed-off') {
      const save = element('button', 'button secondary', entry.status === 'ready' ? '保存' : '再次保存');
      save.type = 'button'; save.setAttribute('aria-label', `保存 ${entry.photo.name}`);
      save.addEventListener('click', () => saveEntry(entry)); top.append(save);
    } else if (canRetry(entry)) {
      const retry = element('button', 'button secondary', '重试');
      retry.type = 'button'; retry.disabled = state.running || state.busy || state.exporting || state.verifying;
      retry.setAttribute('aria-label', `重试 ${entry.photo.name}`);
      retry.addEventListener('click', () => retryEntries([entry]));
      top.append(retry);
    }
    row.append(top);
    if (entry.blob) {
      const verification = element('details', 'file-verification');
      verification.open = Boolean(entry.verifying || entry.receipt || entry.verificationError);
      verification.append(element('summary', '', '文件校验'));
      const verify = element('button', 'text-button verify-original', entry.verifying ? '取消校验' : entry.receipt ? '保存校验记录' : '校验原片');
      verify.type = 'button';
      verify.disabled = !entry.verifying && (state.running || state.exporting || state.verifying);
      verify.addEventListener('click', () => {
        if (entry.verifying) state.receiptController?.abort();
        else if (entry.receipt) { try { handoffDownload(entry.receipt.blob, entry.receipt.filename); notify('校验记录已交给浏览器，记录不包含照片，请另行保存原片。'); } catch (error) { notify(userError(error), true); } }
        else verifyOriginal(entry);
      });
      verification.append(verify);
      if (entry.receipt) verification.append(element('p', 'save-note', `SHA-256: ${entry.receipt.receipt.sha256}`));
      if (entry.verificationError) verification.append(element('p', 'save-note', entry.verificationError));
      row.append(verification);
    }
    if (entry.status === 'transferring') {
      const progress = element('progress');
      progress.setAttribute('aria-label', `${entry.photo.name} 的传输进度`);
      if (knownSize(entry.expected) && entry.expected > 0) { progress.max = entry.expected; progress.value = entry.received; }
      row.append(progress);
    } else if (!['queued'].includes(entry.status)) {
      const remove = element('button', 'text-button queue-remove', '移除');
      remove.type = 'button'; remove.disabled = state.running || state.exporting || state.verifying;
      remove.setAttribute('aria-label', `从传输记录中移除 ${entry.photo.name}`);
      remove.addEventListener('click', () => { if (state.running || state.exporting || state.verifying || !confirmDiscard([entry])) return; invalidateArchive(); release(entry); state.queue = state.queue.filter(item => item !== entry); renderQueue(); });
      row.append(remove);
    }
    $('queue-list').append(row);
  });
  if ($('unqueued-only').checked && state.session?.connected) renderGallery();
  updateQueueSummary();
  renderRecovery();
  placeTray();
  updateControls();
}
function updateQueueSummary() {
  $('queue-count').textContent = `${state.queue.length}`;
  const ready = state.queue.filter(entry => entry.status === 'ready').length;
  const handed = state.queue.filter(entry => entry.status === 'handed-off').length;
  const failed = state.queue.filter(entry => entry.status === 'failed').length;
  const cancelled = state.queue.filter(entry => entry.status === 'cancelled').length;
  const waiting = state.queue.filter(entry => entry.status === 'queued').length;
  const parts = [state.running && (state.pauseRequested ? '本张完成后暂停' : '正在逐张传输'), !state.running && waiting && '已暂停，可继续传输', ready && `${ready} 张待保存`, handed && `${handed} 张已交给浏览器`, waiting && `${waiting} 张等待中`, failed && `${failed} 张失败`, cancelled && `${cancelled} 张已取消`].filter(Boolean);
  $('queue-summary').textContent = parts.join(' · ') || '暂无传输';
}
function renderRecovery() {
  const stopped = state.queue.filter(unfinished);
  const eligible = stopped.filter(canRetry);
  $('queue-recovery').hidden = !stopped.length || state.running;
  $('retry-unfinished').hidden = !eligible.length;
  $('retry-unfinished').textContent = `重试未完成项（${eligible.length}）`;
  const notes = [];
  if (eligible.length) {
    if (state.session?.mode === 'camera') notes.push('请先恢复相机 Wi-Fi。');
    notes.push('从头重试本次连接中失败或取消的文件，已完成原片会保留。');
  }
  const stale = stopped.filter(entry => !currentSource(entry)).length;
  const expired = stopped.filter(entry => currentSource(entry) && entry.retryable === false).length;
  const exhausted = stopped.filter(entry => currentSource(entry) && entry.retryable !== false && entry.attempts >= MAX_ATTEMPTS).length;
  if (stale) notes.push(`${stale} 项的来源已断开或变更，请重新连接并选片。`);
  if (expired) notes.push(`${expired} 项在本次连接中已失效，请重新连接并选片。`);
  if (exhausted) notes.push(`${exhausted} 项已达到 ${MAX_ATTEMPTS} 次尝试上限，请检查连接后移除并重新选择。`);
  $('recovery-note').textContent = notes.join(' ');
}
function retryEntries(entries) {
  if (state.running || state.busy || state.exporting || state.verifying) return;
  // Recheck membership and source at click time, including old detached buttons.
  const eligible = entries.filter(entry => state.queue.includes(entry) && canRetry(entry));
  if (!eligible.length) return;
  eligible.forEach(entry => {
    entry.status = 'queued'; entry.error = ''; entry.received = 0;
    entry.expected = knownSize(entry.photo.bytes) ? entry.photo.bytes : null;
  });
  // runQueue invalidates any partial ZIP and sets the running guard synchronously.
  runQueue();
}
function updateEntryProgress(entry) {
  const row = $(`queue-${entry.id}`);
  if (!row) return;
  row.querySelector('.queue-item-status').textContent = itemStatus(entry);
  const progress = row.querySelector('progress');
  if (progress && knownSize(entry.expected) && entry.expected > 0) { progress.max = entry.expected; progress.value = entry.received; }
}
async function transferEntry(entry, signal, generation) {
  const attempt = ++entry.attempts;
  entry.startedAt = performance.now(); entry.finishedAt = null; entry.archiveHandedOff = false;
  entry.status = 'transferring'; entry.received = 0; entry.error = ''; entry.retryable = true;
  entry.expected = knownSize(entry.photo.bytes) ? entry.photo.bytes : null;
  renderQueue();
  const progressTimer = setInterval(() => {
    if (generation === state.generation && attempt === entry.attempts && entry.status === 'transferring') updateEntryProgress(entry);
  }, 1000);
  let reader;
  let response;
  try {
    if (!currentSource(entry)) { entry.retryable = false; throw new Error('来源已变更，请重新连接并选择这张照片。'); }
    if (knownSize(entry.expected) && entry.expected > FILE_LIMIT) throw new Error('此文件超过 128 MB 单文件限制。');
    if (knownSize(entry.expected) && state.retained + state.leasedBytes + entry.expected > MEMORY_LIMIT) throw new Error('暂存空间已满。请保存并移除已完成原片后重试，下载链接最多需要 30 秒释放。');
    response = await fetch(safeLocalUrl(entry.photo.originalUrl), { signal, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (['STALE_SESSION', 'PHOTO_NOT_FOUND', 'DISCONNECTED'].includes(failure.code)) entry.retryable = false;
      throw new Error(`${cameraErrorMessage(failure.code, response.status)}${entry.retryable ? '' : ' 请重新连接并选择这张照片，此旧传输无法重试。'}`);
    }
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().startsWith('image/jpeg')) throw new Error('来源未返回 JPEG，未生成文件。');
    const header = response.headers.get('X-File-Size') || response.headers.get('Content-Length');
    if (header && /^\d+$/.test(header)) entry.expected = Number(header);
    if (knownSize(entry.expected) && entry.expected > FILE_LIMIT) throw new Error('此文件超过 128 MB 单文件限制。');
    if (knownSize(entry.expected) && state.retained + state.leasedBytes + entry.expected > MEMORY_LIMIT) throw new Error('暂存空间已满。请保存并移除已完成原片后重试，下载链接最多需要 30 秒释放。');
    if (!response.body?.getReader) throw new Error('此浏览器不支持流式下载，请使用较新的桌面浏览器。');
    reader = response.body.getReader();
    const chunks = [];
    let lastPaint = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted || generation !== state.generation) throw new DOMException('Cancelled', 'AbortError');
      if (done) break;
      entry.received += value.byteLength;
      if (entry.received > FILE_LIMIT || state.retained + state.leasedBytes + entry.received > MEMORY_LIMIT) {
        await reader.cancel();
        throw new Error('已达到暂存上限。请保存并移除已完成原片后重试，下载链接最多需要 30 秒释放。');
      }
      chunks.push(value);
      if (performance.now() - lastPaint > 100) { updateEntryProgress(entry); lastPaint = performance.now(); }
    }
    if (!entry.received) throw new Error('来源返回了空文件，未生成文件。');
    if (knownSize(entry.expected) && entry.expected !== entry.received) throw new Error('传输文件大小不匹配，请重试后再保存。');
    if (signal.aborted || generation !== state.generation) throw new DOMException('Cancelled', 'AbortError');
    const blob = new Blob(chunks, { type: 'image/jpeg' });
    const objectUrl = URL.createObjectURL(blob);
    // Publish a complete, accounted ready entry only after URL allocation succeeds.
    entry.blob = blob;
    entry.objectUrl = objectUrl;
    entry.blobBytes = blob.size;
    state.retained += blob.size;
    entry.finishedAt = performance.now();
    entry.status = 'ready';
  } catch (error) {
    if (reader) { try { await reader.cancel(); } catch { /* Already aborted or closed. */ } }
    else if (response?.body) { try { await response.body.cancel(); } catch { /* Response already consumed. */ } }
    // Disconnect can finish before abort cleanup. An old attempt must not overwrite
    // a ready file produced by a subsequent retry if the disconnect request failed.
    if (generation !== state.generation || attempt !== entry.attempts) return;
    entry.status = signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed';
    entry.error = entry.status === 'failed' ? `${userError(error) || '连接中断，未生成文件。'}${entry.attempts >= MAX_ATTEMPTS ? ' 已达到重试上限，请检查连接后移除并重新选择。' : ''}` : '';
  } finally { clearInterval(progressTimer); if (reader) { try { reader.releaseLock(); } catch { /* Reader already released. */ } } }
}
async function runQueue() {
  if (state.running || state.busy || state.exporting || state.verifying) return;
  // A retry can add a ready file to a previously packaged partial batch.
  invalidateArchive();
  state.running = true; state.pauseRequested = false;
  const generation = state.generation;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  renderQueue();
  try {
    for (const entry of state.queue) {
      if (signal.aborted || state.pauseRequested || generation !== state.generation) break;
      if (!currentSource(entry)) { if (entry.status === 'queued') entry.status = 'cancelled'; continue; }
      if (entry.status === 'queued') {
        await transferEntry(entry, signal, generation);
        if (generation !== state.generation) break;
        renderQueue();
      }
    }
  } finally {
    if (generation === state.generation) {
      if (!state.pauseRequested || signal.aborted) state.queue.filter(entry => entry.status === 'queued').forEach(entry => { entry.status = 'cancelled'; });
      state.pauseRequested = false;
      state.running = false; state.controller = null; renderQueue();
    }
  }
}
function cancelQueue() {
  if (!state.running && !state.queue.some(entry => entry.status === 'queued')) return;
  state.pauseRequested = false;
  state.queue.filter(entry => entry.status === 'queued').forEach(entry => { entry.status = 'cancelled'; });
  state.controller?.abort();
  if (!state.running) { renderQueue(); return; }
  $('cancel-queue').disabled = true;
  const generation = state.generation;
  setTimeout(() => { if (generation === state.generation) $('cancel-queue').disabled = false; }, 200);
}
function handoffDownload(blob, filename) {
  // Use a separate short-lived URL so Clear/Remove cannot revoke a download
  // link before the browser consumes the asynchronous anchor navigation.
  let lease = state.downloadLeases.get(blob);
  if (!lease) {
    if (state.leasedBytes + blob.size > DOWNLOAD_LEASE_LIMIT) throw new Error('上一批文件仍在交给浏览器，请等待最多 30 秒后再保存。');
    lease = { objectUrl: URL.createObjectURL(blob), bytes: blob.size, timer: null };
    state.downloadLeases.set(blob, lease);
    state.leasedBytes += blob.size;
  }
  clearTimeout(lease.timer);
  lease.timer = setTimeout(() => {
    URL.revokeObjectURL(lease.objectUrl);
    state.downloadLeases.delete(blob);
    state.leasedBytes = Math.max(0, state.leasedBytes - lease.bytes);
    renderTransferPlan();
  }, DOWNLOAD_GRACE_MS);
  const anchor = element('a');
  anchor.href = lease.objectUrl; anchor.download = filename;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}
function saveEntry(entry) {
  if (!entry.objectUrl || !entry.blob) { notify('暂存原片已失效，请移除此项后重新传输。', true); return; }
  try {
    handoffDownload(entry.blob, GRTransferFiles.downloadName(entry.photo));
    entry.status = 'handed-off';
    renderQueue();
  } catch (error) { notify(`未能将 JPEG 交给浏览器。${userError(error)}`, true); }
}

function invalidateArchive() {
  if (state.archive) URL.revokeObjectURL(state.archive.objectUrl);
  state.archive = null;
  $('archive-status').textContent = '';
}
async function prepareArchive() {
  if (state.busy || state.running || state.exporting || state.verifying) return;
  const entries = state.queue.filter(entry => entry.blob);
  if (!entries.length) return;
  invalidateArchive();
  state.exporting = true;
  state.archiveController = new AbortController();
  const signal = state.archiveController.signal;
  const generation = state.generation;
  renderQueue();
  $('archive-status').textContent = '正在打包原片并计算 SHA-256…';
  try {
    const archive = await GRTransferFiles.buildArchive(entries, { signal, onProgress: (done, total) => {
      if (generation === state.generation) $('archive-status').textContent = `已校验 ${done} / ${total} 张原片…`;
    } });
    if (generation !== state.generation || signal.aborted) return;
    state.archive = { blob: archive.blob, objectUrl: URL.createObjectURL(archive.blob), filename: archive.filename, count: entries.length, entries };
    $('archive-status').textContent = `${entries.length} 张原片已打包，包含原文件夹和 SHA-256 清单。保存 ZIP 后请检查下载文件夹。`;
  } catch (error) {
    if (generation === state.generation) $('archive-status').textContent = signal.aborted ? '已取消打包，原片仍可单独保存。' : `打包失败。${userError(error)}`;
  } finally {
    if (generation === state.generation) { state.exporting = false; state.archiveController = null; renderQueue(); }
  }
}
function saveArchive() {
  if (!state.archive || state.exporting) return;
  try {
    handoffDownload(state.archive.blob, state.archive.filename);
    state.archive.entries.forEach(entry => { entry.archiveHandedOff = true; });
    renderQueue();
    $('archive-status').textContent = `ZIP 已交给浏览器（${state.archive.count} 张原片）。请检查下载文件夹和校验清单，此处无法确认是否已写入磁盘。`;
  } catch (error) { $('archive-status').textContent = `未能将 ZIP 交给浏览器。${userError(error)}`; }
}

$('try-demo').addEventListener('click', () => connect('demo'));
for (const id of ['landing-connect', 'switch-camera']) $(id).addEventListener('click', () => { $('connect-error').hidden = true; openDialog($('connect-dialog')); });
$('cancel-connect').addEventListener('click', () => closeDialog($('connect-dialog')));
$('confirm-connect').addEventListener('click', () => connect('camera'));
$('disconnect').addEventListener('click', disconnect);
$('refresh').addEventListener('click', refresh);
$('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
for (const id of ['search', 'folder', 'sort']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { state.page = 1; renderGallery(); });
$('select-visible').addEventListener('click', () => { currentPage().visible.forEach(photo => state.selected.add(photo.id)); renderSelection(); });
$('select-batch').addEventListener('click', selectNextBatch);
$('invert-visible').addEventListener('click', () => { const visible = currentPage().visible; visible.forEach(photo => { if (state.selected.has(photo.id)) state.selected.delete(photo.id); else state.selected.add(photo.id); }); if ($('selected-only').checked) renderGallery(); else renderSelection(); });
$('clear-selection').addEventListener('click', () => { state.selected.clear(); if ($('selected-only').checked) renderGallery(); else renderSelection(); });
$('unqueued-only').addEventListener('change', () => { state.page = 1; renderGallery(); });
$('selected-only').addEventListener('change', () => { state.page = 1; renderGallery(); });
$('deselect-visible').addEventListener('click', () => { currentPage().visible.forEach(photo => state.selected.delete(photo.id)); if ($('selected-only').checked) renderGallery(); else renderSelection(); });
$('reset-filters').addEventListener('click', () => { $('selected-only').checked = false; $('unqueued-only').checked = false; $('search').value = ''; $('folder').value = ''; state.page = 1; renderGallery(); });
$('preview-previous').addEventListener('click', () => navigatePreview(-1));
$('preview-next').addEventListener('click', () => navigatePreview(1));
$('preview-dialog').addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); navigatePreview(event.key === 'ArrowLeft' ? -1 : 1);
  }
});
$('preview-select').addEventListener('click', () => { if (state.previewId) toggleSelection(state.previewId); });
$('transfer').addEventListener('click', addToQueue);
$('mobile-transfer').addEventListener('click', () => { addToQueue(); if (state.queue.length) $('queue-panel').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); });
$('pause-queue').addEventListener('click', () => { if (state.running) { state.pauseRequested = !state.pauseRequested; updateControls(); updateQueueSummary(); } });
$('resume-queue').addEventListener('click', () => { if (state.session?.connected) runQueue(); });
$('cancel-queue').addEventListener('click', cancelQueue);
$('queue-filter').addEventListener('change', renderQueue);
$('clear-queue').addEventListener('click', clearQueue);
$('clear-handed').addEventListener('click', clearHandedOff);
$('retry-unfinished').addEventListener('click', () => retryEntries(state.queue));
$('batch-receipt').addEventListener('click', exportBatchReceipt);
$('build-archive').addEventListener('click', prepareArchive);
$('save-archive').addEventListener('click', saveArchive);
$('cancel-archive').addEventListener('click', () => state.archiveController?.abort());
for (const button of document.querySelectorAll('.help-trigger')) button.addEventListener('click', () => showHelp(button.dataset.help));
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => closeDialog(button.closest('dialog')));
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('cancel', () => { if (dialog === $('connect-dialog')) cancelConnection(); if (dialog === $('preview-dialog')) clearPreview(); });
  dialog.addEventListener('close', () => {
    if (dialog === $('connect-dialog') && !dialog.open) cancelConnection();
    if (dialog === $('preview-dialog') && !dialog.open) clearPreview();
    if (![...document.querySelectorAll('dialog')].some(item => item.open)) document.body.classList.remove('has-modal');
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog); } });
}
function suspendPage() {
  // A restored bfcache page must never present revoked object URLs or stale source URLs.
  state.generation++;
  state.connecting = false;
  state.restoreClearedTray = state.restoreClearedTray || state.queue.length > 0;
  state.controller?.abort();
  state.archiveController?.abort();
  state.receiptController?.abort();
  state.receiptController = null; state.verifying = false; state.batchVerifying = false;
  state.exporting = false;
  invalidateArchive();
  state.requestController.abort();
  state.controller = null;
  state.running = false;
  state.queue.forEach(release);
  state.queue = [];
  state.retained = 0;
  state.session = null;
  state.photos = [];
  galleryCache = null;
  thumbnailFailures.clear();
  state.selected.clear();
  state.page = 1;
  for (const dialog of document.querySelectorAll('dialog')) closeDialog(dialog);
  clearPreview();
  $('search').value = '';
  $('selected-only').checked = false;
  $('folder').replaceChildren(new Option('全部文件夹', ''));
  $('notice').hidden = true;
  $('cancel-queue').disabled = false;
  setBusy(true);
  renderGallery();
  renderQueue();
  renderSession();
}
async function reconcileSession(restored = false) {
  const generation = ++state.generation;
  state.requestController.abort();
  state.requestController = new AbortController();
  setBusy(true);
  try {
    const session = await api('/api/session');
    if (generation !== state.generation) return;
    const result = session.connected ? await api('/api/photos') : { photos: [] };
    if (generation !== state.generation) return;
    state.session = session;
    applyPhotos(result);
    renderSession();
    if (restored) {
      notify(state.restoreClearedTray
        ? '返回页面后，临时传输记录已清空。尚未保存的照片需要重新传输；已交给浏览器的文件请到下载文件夹确认。'
        : '返回页面后已更新连接状态。');
      state.restoreClearedTray = false;
    }
  } catch (error) {
    if (generation !== state.generation) return;
    state.session = null;
    state.photos = [];
    galleryCache = null;
    state.selected.clear();
    renderGallery();
    renderSession();
    notify(`${restored ? '之前的临时传输记录已清空，无法恢复连接。' : '本机程序暂不可用。'} ${userError(error)}`, true);
  } finally { if (generation === state.generation) setBusy(false); }
}
window.addEventListener('pagehide', suspendPage);
window.addEventListener('pageshow', event => { if (event.persisted) reconcileSession(true); });
reconcileSession();
