'use strict';

const $ = id => document.getElementById(id);
const PAGE_SIZE = 24;
const MEMORY_LIMIT = 256 * 1024 * 1024;
const FILE_LIMIT = 128 * 1024 * 1024;
const QUEUE_LIMIT = 48;
const MAX_ATTEMPTS = 3;
const DOWNLOAD_GRACE_MS = 30000;
const DOWNLOAD_LEASE_LIMIT = MEMORY_LIMIT + 1024 * 1024;
const state = { session: null, photos: [], selected: new Set(), page: 1, busy: true, connecting: false, generation: 0, queue: [], running: false, controller: null, previewId: null, retained: 0, requestController: new AbortController(), restoreClearedTray: false, exporting: false, archive: null, archiveController: null, downloadLeases: new Map(), leasedBytes: 0 };
let entryId = 0;
// Reuse locale collation and one derived list, rather than sorting the whole card
// again for every selection, preview toggle or page navigation.
const photoNameCollator = new Intl.Collator(undefined, { numeric: true });
const photoFolderCollator = new Intl.Collator();
let galleryCache = null;

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
  if (!Number.isFinite(value) || value < 0) return 'Size unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function knownSize(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function dateValue(value) { return value ? Date.parse(value) : NaN; }
function dateLabel(value) {
  const time = dateValue(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not supplied';
}
function safeLocalUrl(value) {
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('The bridge returned a non-local photo URL.');
  return value;
}
function notify(message, error = false) {
  $('notice-text').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
}
async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: state.requestController.signal, ...options });
  let result;
  try { result = await response.json(); } catch { throw new Error('The local bridge returned an unreadable response. Restart it and reload this page.'); }
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.code = typeof result.code === 'string' ? result.code : 'BRIDGE_ERROR';
    throw error;
  }
  return result;
}
async function post(path, body = {}) {
  const generation = state.generation;
  const session = state.session?.csrfToken ? state.session : await api('/api/session');
  if (generation !== state.generation) throw new DOMException('The previous page session ended.', 'AbortError');
  state.session = session;
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(body) });
}
function setBusy(value) { state.busy = value; updateControls(); }
function updateControls() {
  const blocked = state.busy || state.running || state.exporting;
  for (const id of ['landing-connect', 'try-demo', 'switch-camera', 'refresh', 'confirm-connect']) $(id).disabled = blocked;
  $('disconnect').disabled = state.busy || state.exporting;
  $('build-archive').disabled = blocked || !state.queue.some(entry => entry.blob);
  $('build-archive').hidden = state.exporting;
  $('save-archive').hidden = !state.archive;
  $('save-archive').disabled = state.exporting;
  $('cancel-archive').hidden = !state.exporting;
  $('transfer').disabled = blocked || !state.selected.size;
  $('mobile-transfer').disabled = blocked || !state.selected.size;
  $('clear-queue').disabled = blocked;
  $('retry-unfinished').disabled = blocked || !state.queue.some(canRetry);
  $('cancel-queue').hidden = !state.running;
  $('clear-queue').hidden = state.running;
  $('cancel-connect').hidden = !state.connecting;
  $('confirm-connect').textContent = state.busy && $('connect-dialog').open ? 'Connecting…' : 'Connect GR III';
  $('refresh').setAttribute('aria-busy', String(state.busy));
}
function release(entry) {
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  entry.objectUrl = null;
  state.retained = Math.max(0, state.retained - (entry.blobBytes || 0));
  entry.blobBytes = 0;
  entry.blob = null;
}
function clearQueue() {
  if (state.running || state.exporting) return;
  invalidateArchive();
  state.queue.forEach(release);
  state.queue = [];
  renderQueue();
}
function placeTray() {
  const connected = Boolean(state.session?.connected);
  const slot = connected ? $('connected-tray') : $('offline-tray');
  if ($('queue-panel').parentElement !== slot) slot.append($('queue-panel'));
  $('offline-transfers').hidden = connected || !state.queue.length;
  $('offline-title').textContent = state.queue.some(entry => entry.blob) ? 'Your transferred files are still here.' : 'Transfer stopped.';
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
  badge.replaceChildren(element('i'), document.createTextNode(connected ? session.mode === 'demo' ? 'Synthetic demo' : 'Camera · unverified' : 'Disconnected'));
  if (connected) {
    $('demo-banner').hidden = session.mode !== 'demo';
    $('source-model').textContent = session.mode === 'demo' ? 'Ricoh GR III · demo' : session.model || 'Ricoh GR III';
    $('source-detail').textContent = session.mode === 'demo' ? 'Synthetic fixtures · no camera connected' : `Wi-Fi · hardware unverified${session.firmware ? ` · Firmware ${session.firmware}` : ''}`;
    $('source-state').replaceChildren(element('i'), document.createTextNode(session.mode === 'demo' ? 'Demo session' : 'Local bridge'));
    $('gallery-description').textContent = session.mode === 'demo' ? 'A little practice, before the real thing.' : 'Choose the frames you want to take with you.';
  }
  updateControls();
}
function applyPhotos(result) {
  state.photos = (Array.isArray(result.photos) ? result.photos : []).filter(photo => photo && typeof photo.id === 'string').map(photo => ({ ...photo, name: String(photo.name || 'Untitled.JPG'), folder: String(photo.folder || '') }));
  const valid = new Set(state.photos.map(photo => photo.id));
  state.selected = new Set([...state.selected].filter(id => valid.has(id)));
  const oldFolder = $('folder').value;
  $('folder').replaceChildren(new Option('All folders', ''));
  [...new Set(state.photos.map(photo => photo.folder))].sort().forEach(folder => $('folder').append(new Option(folder || 'Unknown folder', folder)));
  if ([...$('folder').options].some(option => option.value === oldFolder)) $('folder').value = oldFolder;
  renderGallery();
}
function connectionAdvice(code) {
  const advice = {
    CAMERA_UNREACHABLE: ['Check the bridge computer’s Wi-Fi', 'Join the network shown by your GR III. A phone joining that network does not connect this computer.', 'Keep the camera awake and close other camera apps, then retry.'],
    CAMERA_TIMEOUT: ['The camera took too long to respond', 'Move the camera closer and keep it awake.', 'Close other camera apps and retry. No originals were changed.'],
    WRONG_MODEL: ['Check the connected camera', 'Only a device identifying as RICOH GR III is supported here.', 'Reconnect the bridge computer to your GR III network. Other models are not assumed compatible.'],
    INVALID_CSRF: ['Refresh the local page', 'The bridge may have restarted. Save any ready originals before reloading.', 'Reload this page, then try the connection again.'],
    UNSUPPORTED_RESPONSE: ['Camera response not recognized', 'This firmware may use a different response format.', 'Retry once. If it repeats, keep using your existing transfer method; do not change camera settings to work around it.'],
  };
  return advice[code] || ['Connection needs attention', 'Keep the camera awake, check the bridge computer’s Wi-Fi and retry.', 'Ready originals already in this tab remain available to save.'];
}
function showConnectionAdvice(code) {
  const [heading, ...steps] = connectionAdvice(code);
  const panel = $('connect-recovery');
  panel.replaceChildren(element('h3', '', heading));
  const list = element('ol');
  steps.forEach(step => list.append(element('li', '', step)));
  panel.append(list);
  panel.hidden = false;
}
async function connect(mode) {
  if (state.busy || state.running || state.exporting) return;
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
    const result = await api('/api/photos');
    if (generation !== state.generation) return;
    applyPhotos(result);
    renderQueue();
    renderSession();
    state.connecting = false;
    closeDialog($('connect-dialog'));
    $('notice').hidden = true;
    if (mode === 'camera') notify('Camera endpoints responded. This prototype still has not been verified on physical GR III hardware.');
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
    const message = error.message || 'Connection failed. Check the bridge and camera Wi-Fi.';
    if ($('connect-dialog').open) { $('connect-error').textContent = message; $('connect-error').hidden = false; showConnectionAdvice(error.code); }
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
    notify('Connection cancelled. Ready originals are still available to save.');
  } catch (error) {
    if (generation !== state.generation) return;
    state.session = null; state.photos = []; galleryCache = null; state.selected.clear();
    renderGallery(); renderQueue(); renderSession();
    notify(`Connection stopped in this tab, but the bridge could not confirm disconnect. Retry the connection before transferring. ${error.message}`, true);
  } finally { if (generation === state.generation) setBusy(false); }
}
async function disconnect() {
  if (state.busy || state.exporting) return;
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
    notify('Disconnected. Completed originals remain in this tab for saving; incomplete transfers were cancelled.');
  } catch (error) {
    if (generation !== state.generation) return;
    notify(`Transfers were stopped, but the bridge could not confirm disconnect. Completed originals are still available. ${error.message}`, true);
  } finally { if (generation === state.generation) setBusy(false); }
}
async function refresh() {
  if (state.busy || state.running || state.exporting) return;
  setBusy(true);
  const generation = state.generation;
  try {
    const result = await post('/api/refresh');
    if (generation !== state.generation) return;
    applyPhotos(result);
    notify('Contact sheet refreshed. Your current selections were kept where the files are still available.');
  } catch (error) { if (generation === state.generation) notify(error.message, true); }
  finally { if (generation === state.generation) setBusy(false); }
}
function filteredPhotos() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const folder = $('folder').value;
  const sort = $('sort').value;
  if (galleryCache && galleryCache.photos === state.photos && galleryCache.query === query && galleryCache.folder === folder && galleryCache.sort === sort) return galleryCache.list;
  const list = state.photos.filter(photo => (!folder || photo.folder === folder) && (!query || photo.name.toLocaleLowerCase().includes(query)));
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
  const list = $('selected-only').checked ? filtered.filter(photo => state.selected.has(photo.id)) : filtered;
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
  $('selection-size').textContent = !chosen.length ? 'Choose your keepers from the contact sheet.' : unknown ? `${total ? `${bytes(total)} known · ` : ''}${unknown} file size${unknown === 1 ? '' : 's'} unknown` : `${bytes(total)} total · original JPEGs`;
  $('clear-selection').disabled = !chosen.length;
  const visible = currentPage().visible;
  const visibleSelected = visible.filter(photo => state.selected.has(photo.id)).length;
  $('select-visible').disabled = !visible.length;
  $('deselect-visible').disabled = !visibleSelected;
  $('selection-visibility').textContent = chosen.length ? `${visibleSelected} selected on this page · ${chosen.length - visibleSelected} elsewhere` : 'No frames selected';
  for (const card of $('gallery').children) {
    const selected = state.selected.has(card.dataset.photoId);
    card.classList.toggle('selected', selected);
    card.querySelector('input').checked = selected;
  }
  if (state.previewId) {
    const selected = state.selected.has(state.previewId);
    $('preview-select').textContent = selected ? 'Deselect frame' : 'Select frame';
    $('preview-select').setAttribute('aria-pressed', String(selected));
    renderPreviewNavigation();
  }
  updateControls();
}
function renderGallery() {
  const { list, visible } = currentPage();
  $('gallery').replaceChildren();
  visible.forEach((photo, index) => {
    const card = element('article', 'photo-card');
    card.dataset.photoId = photo.id;
    const preview = element('button', 'photo-image-button');
    preview.type = 'button';
    preview.setAttribute('aria-label', `Preview ${photo.name}${photo.synthetic ? ', synthetic demo image' : ''}`);
    const image = element('img');
    image.alt = photo.synthetic ? `Synthetic demo composition: ${photo.name}` : `Preview of ${photo.name}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    try { image.src = safeLocalUrl(photo.thumbnailUrl); } catch { image.alt = 'Preview URL unavailable'; }
    image.addEventListener('error', () => { image.alt = `Preview unavailable: ${photo.name}`; });
    preview.append(image, element('span', 'photo-index', String((state.page - 1) * PAGE_SIZE + index + 1).padStart(2, '0')));
    preview.addEventListener('click', () => showPreview(photo.id));
    const label = element('label', 'photo-select');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Select ${photo.name}`);
    checkbox.addEventListener('change', () => toggleSelection(photo.id));
    label.append(checkbox, icon('check'));
    const meta = element('div', 'photo-meta');
    const detail = element('div');
    const title = element('h3', '', photo.name);
    title.title = photo.name;
    detail.append(title, element('p', '', `${photo.folder} · ${bytes(photo.bytes)}`));
    meta.append(detail, element('span', 'photo-type', photo.synthetic ? 'DEMO / JPG' : 'JPG'));
    card.append(preview, label, meta);
    $('gallery').append(card);
  });
  $('photo-count').textContent = `${list.length} frame${list.length === 1 ? '' : 's'}${list.length !== state.photos.length ? ` of ${state.photos.length}` : ''}`;
  $('gallery-empty').hidden = list.length !== 0;
  $('empty-description').textContent = state.photos.length ? ($('selected-only').checked ? 'No selected frames match these filters. Clear the review filter to choose more frames.' : 'Try a different filename or folder.') : 'No JPEGs were returned by this source. Try Refresh after checking the camera.';
  $('reset-filters').hidden = !state.photos.length;
  renderPagination(list.length);
  renderSelection();
}
function renderPagination(total) {
  let pager = $('pagination');
  if (!pager) {
    pager = element('nav', 'pagination');
    pager.id = 'pagination';
    pager.setAttribute('aria-label', 'Contact sheet pages');
    $('gallery').after(pager);
  }
  pager.replaceChildren();
  const pages = Math.ceil(total / PAGE_SIZE);
  pager.hidden = pages <= 1;
  if (pages <= 1) return;
  const previous = element('button', 'button secondary compact', 'Previous');
  previous.type = 'button'; previous.disabled = state.page === 1;
  previous.addEventListener('click', () => { state.page--; renderGallery(); $('search').focus({ preventScroll: true }); });
  const next = element('button', 'button secondary compact', 'Next');
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
  $('preview-position').textContent = index < 0 ? 'Outside current filters' : `${index + 1} / ${list.length}`;
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
  $('preview-folder').textContent = photo.folder || 'Unknown folder';
  $('preview-size').textContent = bytes(photo.bytes);
  $('preview-dimensions').textContent = Number.isFinite(photo.width) && Number.isFinite(photo.height) ? `${photo.width} × ${photo.height} px` : 'Not supplied';
  $('preview-date').textContent = dateLabel(photo.takenAt);
  $('preview-synthetic').hidden = !photo.synthetic;
  $('preview-image').alt = photo.synthetic ? `Synthetic demo composition: ${photo.name}` : `Preview of ${photo.name}`;
  $('preview-image').removeAttribute('src');
  try { $('preview-image').src = safeLocalUrl(photo.previewUrl || photo.thumbnailUrl); } catch { $('preview-image').alt = 'Preview unavailable'; }
  renderSelection();
  openDialog($('preview-dialog'));
}
function showHelp(kind) {
  const phone = kind === 'phone';
  $('help-title').textContent = phone ? 'A phone-sized view. A local bridge.' : 'Originals, all the way through.';
  $('help-content').replaceChildren();
  const sections = phone ? [
    ['Where this runs', 'This page adapts to a phone screen, but the bridge currently listens only on the computer’s localhost address. Opening that address on your phone will not reach this computer.'],
    ['Reaching it from a phone', 'Phone access would require a separate, approved local-network setup with appropriate access protection. This prototype does not change your firewall, expose a server, or provide a phone pairing link.'],
    ['Saving on a phone', 'If a future supported setup makes the page reachable, your browser controls the save destination. A file may go to Downloads or Files; adding it to your Photos library is a separate platform-specific action.']
  ] : [
    ['1. Choose and transfer', 'Select JPEGs from the contact sheet, then choose Transfer originals. Files transfer one at a time from the source into browser memory. Progress is measured in bytes; a percentage appears only when the source provides a file size.'],
    ['2. Save originals individually or together', 'Choose Save for a ready JPEG, or prepare a ZIP containing all ready JPEGs, camera folders and a SHA-256 manifest. Individual filenames include a folder prefix. ZIPs keep the original filenames inside directories. Neither method rewrites image bytes or EXIF. Check Downloads or Files: handing a file to the browser does not prove it reached disk.'],
    ['Keep the session small', 'The tray can hold up to 48 entries and 256 MB of file data. Each file is limited to 128 MB. Save and remove files, or clear the tray, before transferring more. Disconnect keeps completed files available in this tab. Clear or closing/reloading this page discards unsaved files from memory.'],
    ['Recover an interrupted batch', 'Restore the camera Wi-Fi connection on the bridge computer, then choose Retry unfinished to retry eligible failed and cancelled files from this connection. Each file restarts from the beginning; ready JPEGs are kept. Individual Retry only retries that frame. There are at most three attempts per entry. After disconnecting or switching sources, reconnect and reselect files from the current contact sheet instead.'],
    ['A prototype, honestly', 'Demo images are synthetic fixtures. Real Ricoh GR III Wi-Fi transfer has not been tested on physical hardware. The camera must be connected to the bridge computer over Wi-Fi; Bluetooth is not used for original-file transfer.']
  ];
  sections.forEach(([title, body]) => $('help-content').append(element('h3', '', title), element('p', '', body)));
  openDialog($('help-dialog'));
}
function addToQueue() {
  if (state.running || state.busy || state.exporting) return;
  const selected = state.photos.filter(photo => state.selected.has(photo.id));
  const existing = new Set(state.queue.filter(currentSource).map(entry => entry.photo.id));
  const additions = selected.filter(photo => !existing.has(photo.id));
  if (!additions.length) { notify('These frames are already in the transfer tray. Save ready files, retry a failed transfer, or remove an entry to transfer it again.'); return; }
  if (state.queue.length + additions.length > QUEUE_LIMIT) { notify(`The tray holds ${QUEUE_LIMIT} entries. Select fewer frames or clear completed entries first.`, true); return; }
  invalidateArchive();
  additions.forEach(photo => state.queue.push({ id: ++entryId, sourceId: state.session.sessionId, sourceMode: state.session.mode, photo: { ...photo }, status: 'queued', received: 0, expected: knownSize(photo.bytes) ? photo.bytes : null, attempts: 0, objectUrl: null, blob: null, blobBytes: 0, retryable: true, error: '' }));
  renderQueue();
  runQueue();
}
function itemStatus(entry) {
  if (entry.status === 'queued') return 'Waiting its turn';
  if (entry.status === 'transferring') return `${bytes(entry.received)}${knownSize(entry.expected) ? ` / ${bytes(entry.expected)}` : ' transferred · size unknown'}`;
  if (entry.status === 'ready') return `${bytes(entry.blobBytes)} · ready to save`;
  if (entry.status === 'handed-off') return 'Sent to browser · check Downloads';
  if (unfinished(entry) && !currentSource(entry)) return 'Source disconnected or changed · reconnect and reselect this frame';
  if (entry.status === 'cancelled') return `Cancelled · no file saved${entry.attempts >= MAX_ATTEMPTS ? ' · Retry limit reached; remove and reselect after checking the connection.' : ''}`;
  return entry.error || 'Transfer failed · no file saved';
}
function renderQueue() {
  $('queue-panel').hidden = state.queue.length === 0;
  $('queue-list').replaceChildren();
  state.queue.forEach(entry => {
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
    info.append(name, element('p', 'queue-item-source', `${entry.photo.folder} · ${entry.sourceMode === 'demo' ? 'synthetic demo' : 'GR III source'}`), element('p', 'queue-item-status', itemStatus(entry)));
    if (entry.blob) info.append(element('p', 'queue-save-name', `Save as ${GRTransferFiles.downloadName(entry.photo)}`));
    top.append(img, info);
    if (entry.status === 'ready' || entry.status === 'handed-off') {
      const save = element('button', 'button secondary', entry.status === 'ready' ? 'Save' : 'Save again');
      save.type = 'button'; save.setAttribute('aria-label', `Save ${entry.photo.name}`);
      save.addEventListener('click', () => saveEntry(entry)); top.append(save);
    } else if (canRetry(entry)) {
      const retry = element('button', 'button secondary', 'Retry');
      retry.type = 'button'; retry.disabled = state.running || state.busy || state.exporting;
      retry.setAttribute('aria-label', `Retry ${entry.photo.name}`);
      retry.addEventListener('click', () => retryEntries([entry]));
      top.append(retry);
    }
    row.append(top);
    if (entry.status === 'transferring') {
      const progress = element('progress');
      progress.setAttribute('aria-label', `Transfer progress for ${entry.photo.name}`);
      if (knownSize(entry.expected) && entry.expected > 0) { progress.max = entry.expected; progress.value = entry.received; }
      row.append(progress);
    } else if (!['queued'].includes(entry.status)) {
      const remove = element('button', 'text-button queue-remove', 'Remove');
      remove.type = 'button'; remove.disabled = state.running || state.exporting;
      remove.setAttribute('aria-label', `Remove ${entry.photo.name} from the transfer tray`);
      remove.addEventListener('click', () => { if (state.running || state.exporting) return; invalidateArchive(); release(entry); state.queue = state.queue.filter(item => item !== entry); renderQueue(); });
      row.append(remove);
    }
    $('queue-list').append(row);
  });
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
  const parts = [state.running && 'Transferring one file at a time', ready && `${ready} ready to save`, handed && `${handed} handed to browser`, waiting && `${waiting} waiting`, failed && `${failed} failed`, cancelled && `${cancelled} cancelled`].filter(Boolean);
  $('queue-summary').textContent = parts.join(' · ') || 'No active transfers';
}
function renderRecovery() {
  const stopped = state.queue.filter(unfinished);
  const eligible = stopped.filter(canRetry);
  $('queue-recovery').hidden = !stopped.length || state.running;
  $('retry-unfinished').hidden = !eligible.length;
  $('retry-unfinished').textContent = `Retry unfinished (${eligible.length})`;
  const notes = [];
  if (eligible.length) {
    if (state.session?.mode === 'camera') notes.push('Restore camera Wi-Fi first.');
    notes.push('Retry failed and cancelled files from this connection, from the beginning. Ready JPEGs are kept.');
  }
  const stale = stopped.filter(entry => !currentSource(entry)).length;
  const expired = stopped.filter(entry => currentSource(entry) && entry.retryable === false).length;
  const exhausted = stopped.filter(entry => currentSource(entry) && entry.retryable !== false && entry.attempts >= MAX_ATTEMPTS).length;
  if (stale) notes.push(`${stale} from a disconnected or changed source: reconnect and reselect from the contact sheet.`);
  if (expired) notes.push(`${expired} no longer available through this connection: reconnect and reselect from the contact sheet.`);
  if (exhausted) notes.push(`${exhausted} reached the ${MAX_ATTEMPTS}-attempt limit: check the connection, then remove and reselect those frames.`);
  $('recovery-note').textContent = notes.join(' ');
}
function retryEntries(entries) {
  if (state.running || state.busy || state.exporting) return;
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
  entry.status = 'transferring'; entry.received = 0; entry.error = ''; entry.retryable = true;
  entry.expected = knownSize(entry.photo.bytes) ? entry.photo.bytes : null;
  renderQueue();
  let reader;
  let response;
  try {
    if (!currentSource(entry)) { entry.retryable = false; throw new Error('The source changed. Reconnect and reselect this frame.'); }
    if (knownSize(entry.expected) && entry.expected > FILE_LIMIT) throw new Error('This file exceeds the 128 MB per-file limit.');
    if (knownSize(entry.expected) && state.retained + state.leasedBytes + entry.expected > MEMORY_LIMIT) throw new Error('Tray memory is full. Save and remove ready files, then retry. Recent browser downloads may need up to 30 seconds to release their download links.');
    response = await fetch(safeLocalUrl(entry.photo.originalUrl), { signal, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (['STALE_SESSION', 'PHOTO_NOT_FOUND', 'DISCONNECTED'].includes(failure.code)) entry.retryable = false;
      throw new Error(`${failure.error || `Transfer failed (${response.status}).`}${entry.retryable ? '' : ' Reconnect and reselect this frame; this old transfer cannot be retried.'}`);
    }
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().startsWith('image/jpeg')) throw new Error('The source did not return a JPEG. No file was prepared.');
    const header = response.headers.get('X-File-Size') || response.headers.get('Content-Length');
    if (header && /^\d+$/.test(header)) entry.expected = Number(header);
    if (knownSize(entry.expected) && entry.expected > FILE_LIMIT) throw new Error('This file exceeds the 128 MB per-file limit.');
    if (knownSize(entry.expected) && state.retained + state.leasedBytes + entry.expected > MEMORY_LIMIT) throw new Error('Tray memory is full. Save and remove ready files, then retry. Recent browser downloads may need up to 30 seconds to release their download links.');
    if (!response.body?.getReader) throw new Error('Streaming downloads are unavailable in this browser. Try a current desktop browser.');
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
        throw new Error('Tray memory limit reached. Save and remove ready files, then retry. Recent download links may need up to 30 seconds to release.');
      }
      chunks.push(value);
      if (performance.now() - lastPaint > 100) { updateEntryProgress(entry); lastPaint = performance.now(); }
    }
    if (!entry.received) throw new Error('The source returned an empty file. No file was prepared.');
    if (knownSize(entry.expected) && entry.expected !== entry.received) throw new Error('The transfer ended with a size mismatch. Retry before saving.');
    if (signal.aborted || generation !== state.generation) throw new DOMException('Cancelled', 'AbortError');
    const blob = new Blob(chunks, { type: 'image/jpeg' });
    const objectUrl = URL.createObjectURL(blob);
    // Publish a complete, accounted ready entry only after URL allocation succeeds.
    entry.blob = blob;
    entry.objectUrl = objectUrl;
    entry.blobBytes = blob.size;
    state.retained += blob.size;
    entry.status = 'ready';
  } catch (error) {
    if (reader) { try { await reader.cancel(); } catch { /* Already aborted or closed. */ } }
    else if (response?.body) { try { await response.body.cancel(); } catch { /* Response already consumed. */ } }
    // Disconnect can finish before abort cleanup. An old attempt must not overwrite
    // a ready file produced by a subsequent retry if the disconnect request failed.
    if (generation !== state.generation || attempt !== entry.attempts) return;
    entry.status = signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed';
    entry.error = entry.status === 'failed' ? `${error.message || 'Connection interrupted. No file was prepared.'}${entry.attempts >= MAX_ATTEMPTS ? ' Retry limit reached; remove and reselect after checking the connection.' : ''}` : '';
  } finally { if (reader) { try { reader.releaseLock(); } catch { /* Reader already released. */ } } }
}
async function runQueue() {
  if (state.running || state.busy || state.exporting) return;
  // A retry can add a ready file to a previously packaged partial batch.
  invalidateArchive();
  state.running = true;
  const generation = state.generation;
  state.controller = new AbortController();
  const signal = state.controller.signal;
  renderQueue();
  try {
    for (const entry of state.queue) {
      if (signal.aborted || generation !== state.generation) break;
      if (entry.status === 'queued') {
        await transferEntry(entry, signal, generation);
        if (generation !== state.generation) break;
        renderQueue();
      }
    }
  } finally {
    if (generation === state.generation) {
      state.queue.filter(entry => entry.status === 'queued').forEach(entry => { entry.status = 'cancelled'; });
      state.running = false; state.controller = null; renderQueue();
    }
  }
}
function cancelQueue() {
  if (!state.running) return;
  state.queue.filter(entry => entry.status === 'queued').forEach(entry => { entry.status = 'cancelled'; });
  state.controller?.abort();
  $('cancel-queue').disabled = true;
  const generation = state.generation;
  setTimeout(() => { if (generation === state.generation) $('cancel-queue').disabled = false; }, 200);
}
function handoffDownload(blob, filename) {
  // Use a separate short-lived URL so Clear/Remove cannot revoke a download
  // link before the browser consumes the asynchronous anchor navigation.
  let lease = state.downloadLeases.get(blob);
  if (!lease) {
    if (state.leasedBytes + blob.size > DOWNLOAD_LEASE_LIMIT) throw new Error('Recent downloads are still being handed to the browser. Wait up to 30 seconds before saving another batch.');
    lease = { objectUrl: URL.createObjectURL(blob), bytes: blob.size, timer: null };
    state.downloadLeases.set(blob, lease);
    state.leasedBytes += blob.size;
  }
  clearTimeout(lease.timer);
  lease.timer = setTimeout(() => {
    URL.revokeObjectURL(lease.objectUrl);
    state.downloadLeases.delete(blob);
    state.leasedBytes = Math.max(0, state.leasedBytes - lease.bytes);
  }, DOWNLOAD_GRACE_MS);
  const anchor = element('a');
  anchor.href = lease.objectUrl; anchor.download = filename;
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}
function saveEntry(entry) {
  if (!entry.objectUrl || !entry.blob) { notify('This transfer is no longer available in memory. Remove it from the tray and transfer the frame again.', true); return; }
  try {
    handoffDownload(entry.blob, GRTransferFiles.downloadName(entry.photo));
    entry.status = 'handed-off';
    renderQueue();
  } catch (error) { notify(`The JPEG could not be handed to your browser. ${error.message}`, true); }
}

function invalidateArchive() {
  if (state.archive) URL.revokeObjectURL(state.archive.objectUrl);
  state.archive = null;
  $('archive-status').textContent = '';
}
async function prepareArchive() {
  if (state.busy || state.running || state.exporting) return;
  const entries = state.queue.filter(entry => entry.blob);
  if (!entries.length) return;
  invalidateArchive();
  state.exporting = true;
  state.archiveController = new AbortController();
  const signal = state.archiveController.signal;
  const generation = state.generation;
  renderQueue();
  $('archive-status').textContent = 'Preparing original JPEGs and SHA-256 checksums…';
  try {
    const archive = await GRTransferFiles.buildArchive(entries, { signal, onProgress: (done, total) => {
      if (generation === state.generation) $('archive-status').textContent = `Checked ${done} of ${total} JPEGs…`;
    } });
    if (generation !== state.generation || signal.aborted) return;
    state.archive = { blob: archive.blob, objectUrl: URL.createObjectURL(archive.blob), filename: archive.filename, count: entries.length };
    $('archive-status').textContent = `${entries.length} original JPEGs ready in a ZIP with folders and SHA-256 manifest. Save ZIP, then check Downloads.`;
  } catch (error) {
    if (generation === state.generation) $('archive-status').textContent = signal.aborted ? 'ZIP preparation cancelled. Your ready JPEGs are still available.' : `ZIP could not be prepared. ${error.message}`;
  } finally {
    if (generation === state.generation) { state.exporting = false; state.archiveController = null; renderQueue(); }
  }
}
function saveArchive() {
  if (!state.archive || state.exporting) return;
  try {
    handoffDownload(state.archive.blob, state.archive.filename);
    $('archive-status').textContent = `ZIP sent to browser (${state.archive.count} JPEGs). Check Downloads and the manifest; saving to disk is not verified here.`;
  } catch (error) { $('archive-status').textContent = `The ZIP could not be handed to your browser. ${error.message}`; }
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
$('clear-selection').addEventListener('click', () => { state.selected.clear(); if ($('selected-only').checked) renderGallery(); else renderSelection(); });
$('selected-only').addEventListener('change', () => { state.page = 1; renderGallery(); });
$('deselect-visible').addEventListener('click', () => { currentPage().visible.forEach(photo => state.selected.delete(photo.id)); if ($('selected-only').checked) renderGallery(); else renderSelection(); });
$('reset-filters').addEventListener('click', () => { $('selected-only').checked = false; $('search').value = ''; $('folder').value = ''; state.page = 1; renderGallery(); });
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
$('cancel-queue').addEventListener('click', cancelQueue);
$('clear-queue').addEventListener('click', clearQueue);
$('retry-unfinished').addEventListener('click', () => retryEntries(state.queue));
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
  state.selected.clear();
  state.page = 1;
  for (const dialog of document.querySelectorAll('dialog')) closeDialog(dialog);
  clearPreview();
  $('search').value = '';
  $('selected-only').checked = false;
  $('folder').replaceChildren(new Option('All folders', ''));
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
        ? 'This page was restored and its in-memory transfer tray was cleared. Transfer any unsaved files again. Check Downloads or Files for anything already handed to your browser.'
        : 'Connection state refreshed after returning to this page.');
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
    notify(`${restored ? 'The previous transfer tray was cleared. The connection could not be restored.' : 'The local bridge is unavailable.'} ${error.message}`, true);
  } finally { if (generation === state.generation) setBusy(false); }
}
window.addEventListener('pagehide', suspendPage);
window.addEventListener('pageshow', event => { if (event.persisted) reconcileSession(true); });
reconcileSession();
