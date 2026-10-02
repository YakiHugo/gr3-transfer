import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CameraAdapter, ReadQueue, parsePhotoList, safeCameraProperties, photoId } from '../src/camera.js';
import { createBridge } from '../src/server.js';
import { JpegValidator } from '../src/jpeg.js';

// Every camera operation below is synthetic. The only sockets opened are loopback HTTP.
const folder = '100RICOH', name = 'R0000001.JPG';
const photo = { id: photoId(folder, name), folder, name, bytes: null, synthetic: false };
const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const original = await readFile(`${fixtureRoot}/${photo.id}.jpg`);
const properties = { model: 'RICOH GR III', firmware: 'synthetic', battery: 75 };
const later = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const adapter = overrides => ({
  connect: async () => ({ properties, photos: [photo] }),
  list: async () => [photo],
  readPhoto: async () => { throw new Error('Unexpected synthetic camera read'); },
  ...overrides,
});
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function bridge(t, camera = adapter()) {
  const server = await createBridge({ adapter: camera, fixtureRoot });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, { method='GET', headers={}, value, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (value === undefined ? undefined : JSON.stringify(value));
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers,
    } }, res => {
      const chunks=[]; res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => { const bytes=Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, json: () => JSON.parse(bytes) }); });
    });
    req.on('error', reject); if (data !== undefined) req.write(data); req.end();
  });
  const session = (await request('/api/session')).json();
  const post = (path, value={}, extra={}) => request(path, { method: 'POST', value, ...extra, headers: { 'X-CSRF-Token': session.csrfToken, ...extra.headers } });
  return { request, post, server, port, session };
}

async function assertFailedDownload(request) {
  let result;
  try { result = await request(); }
  catch (error) { assert.ok(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code), `Unexpected error: ${error}`); return; }
  assert.notEqual(result.status, 200, 'Malformed or truncated camera data must not complete as HTTP 200');
}

test('audit: model identity is exact and sensitive /props fields never escape', () => {
  const result = safeCameraProperties({ model: ' RICOH  GR III ', firmwareVersion: '1'.repeat(64), battery: 75, ssid: 'secret', password: 'secret', serialNumber: 'secret', macAddress: 'secret', gps: 'secret' });
  assert.deepEqual(result, { model: 'RICOH GR III', firmware: '1'.repeat(32), battery: 75 });
  for (const model of ['RICOH GR IIIx', 'RICOH GR II', 'RICOH GR IV', 'GR III', 'RICOH GR III HDF', 'RICOH GR III\u0000']) {
    assert.throws(() => safeCameraProperties({ model }), { code: 'WRONG_MODEL' });
  }
  assert.equal(safeCameraProperties({ model: 'RICOH GR III', battery: '99' }).battery, null);
});

test('audit: listing rejects traversal JPEG paths and never includes RAW/video', () => {
  const list = parsePhotoList({ dirs: [{ name: folder, files: [name, 'R0000002.DNG', 'R0000003.MOV', name] }] });
  assert.equal(list.length, 1); assert.equal(list[0].name, name);
  for (const entry of ['../a.JPG', '/a.JPG', 'a%2fb.JPG', 'a".JPG', 'a\r\n.JPG']) {
    assert.throws(() => parsePhotoList({ dirs: [{ name: folder, files: [entry] }] }), { code: 'INVALID_PHOTO_PATH' });
  }
  for (const bad of [null, {}, {dirs:{}}, {dirs:[{name:'../x',files:[]}]}, {dirs:[{name:folder,files:[null]}]}]) assert.throws(() => parsePhotoList(bad));
});

test('audit: fixed camera address, GET only, no redirect and original has no resize query', async () => {
  const calls=[];
  const camera = new CameraAdapter({ fetchImpl: async (url, opts) => {
    calls.push({url, opts});
    if (url.endsWith('/props')) return jsonResponse({model:'RICOH GR III', password:'never forwarded', firmwareVersion:'1.91', battery:100});
    if (url.endsWith('/photos')) return jsonResponse({dirs:[{name:folder,files:[name]}]});
    return new Response(original, { headers: {'content-type':'image/jpeg'} });
  } });
  const result = await camera.connect(); assert.deepEqual(result.properties, {model:'RICOH GR III',firmware:'1.91',battery:100});
  await camera.readPhoto(photo,'original',undefined, async response => assert.deepEqual(Buffer.from(await response.arrayBuffer()), original));
  await camera.readPhoto(photo,'thumbnail',undefined, async response => response.body.cancel());
  await camera.readPhoto(photo,'preview',undefined, async response => response.body.cancel());
  assert.deepEqual(calls.map(c => c.url), [
    'http://192.168.0.1/v1/props', 'http://192.168.0.1/v1/photos',
    'http://192.168.0.1/v1/photos/100RICOH/R0000001.JPG', 'http://192.168.0.1/v1/photos/100RICOH/R0000001.JPG?size=thumb',
    'http://192.168.0.1/v1/photos/100RICOH/R0000001.JPG?size=view',
  ]);
  for (const {opts} of calls) { assert.equal(opts.method,'GET'); assert.equal(opts.redirect,'error'); assert.equal(opts.headers['Accept-Encoding'],'identity'); }
});

test('audit: adapter rejects non-allowlisted camera endpoints before fetch', async () => {
  let calls=0;
  const camera = new CameraAdapter({ fetchImpl: async () => { calls++; return jsonResponse({}); } });
  for (const path of ['/commands', '/../commands', '/photos/../../props', '/photos/100RICOH/a.JPG?size=screen', '//example.com/x']) {
    await assert.rejects(camera.request(path, undefined, 100), undefined, `Expected rejection for ${path}`);
  }
  assert.equal(calls,0);
});

test('audit: unsafe photo paths and invalid variants never call camera fetch', async () => {
  let calls=0; const camera = new CameraAdapter({fetchImpl: async () => { calls++; throw new Error('must not fetch'); }});
  for (const bad of [{folder:'../x',name}, {folder,name:'../a.JPG'}, {folder,name:'a.JPG?size=thumb'}]) await assert.rejects(camera.readPhoto(bad,'original'),{code:'INVALID_PHOTO_PATH'});
  await assert.rejects(camera.readPhoto(photo,'screen'),{code:'INVALID_VARIANT'});
  assert.equal(calls,0);
});

test('audit: malformed camera JSON, non-object payload, and reported errors are safely rejected', async () => {
  for (const raw of ['{"dirs":', 'null', '[]', '42']) {
    const camera = new CameraAdapter({ fetchImpl: async () => new Response(raw) });
    await assert.rejects(camera.list(), {code:'INVALID_CAMERA_RESPONSE'});
  }
  const camera = new CameraAdapter({fetchImpl: async () => jsonResponse({errCode:500, secret:'do not forward'})});
  await assert.rejects(camera.connect(), error => error.code==='CAMERA_REPORTED_ERROR' && !error.message.includes('secret'));
});

test('audit: encoded camera bytes and redirect/network errors fail closed', async () => {
  const camera = new CameraAdapter({fetchImpl: async () => new Response(original, {headers:{'content-encoding':'gzip'}})});
  await assert.rejects(camera.readPhoto(photo,'original',undefined,async () => assert.fail('Encoded response cannot be consumed')), {code:'ENCODED_RESPONSE'});
  const blocked = new CameraAdapter({fetchImpl: async () => { throw new TypeError('fetch failed with sensitive details'); }});
  await assert.rejects(blocked.connect(), error => error.code==='CAMERA_UNREACHABLE' && !error.message.includes('sensitive'));
});

test('audit: queued reads are serialized and cancelled queued work never starts', async () => {
  const queue = new ReadQueue(), entered = later(), release = later(); let active=0,max=0,cancelledCalled=false;
  const first = queue.run(async () => { max=Math.max(max,++active); entered.resolve(); await release.promise; active--; });
  await entered.promise;
  const cancel = new AbortController();
  const second = queue.run(async () => { cancelledCalled=true; }, cancel.signal);
  const rejected = assert.rejects(second, {name:'AbortError'});
  const third = queue.run(async () => { max=Math.max(max,++active); active--; });
  cancel.abort(); release.resolve(); await Promise.all([first,rejected,third]);
  assert.equal(max,1); assert.equal(cancelledCalled,false);
});

test('audit: loopback, Host, Origin, fetch-site, CSRF and methods enforced', async t => {
  let cameraCalls=0; const app=await bridge(t, adapter({connect: async () => { cameraCalls++; return {properties,photos:[photo]}; }}));
  assert.equal(app.server.address().address,'127.0.0.1');
  for (const headers of [ {Host:'evil.example'}, {Host:`192.0.2.1:${app.port}`}, {Origin:'https://evil.example'}, {Origin:'null'}, {'Sec-Fetch-Site':'cross-site'}, {'Sec-Fetch-Site':'same-site'} ]) {
    const response=await app.request('/api/session',{headers}); assert.equal(response.status,403);
  }
  for (const token of [undefined,'','bad','a'.repeat(48)]) {
    const response=await app.request('/api/connect',{method:'POST',value:{mode:'camera'},headers: token === undefined ? {} : {'X-CSRF-Token':token}}); assert.equal(response.status,403);
  }
  assert.equal((await app.request('/api/session',{method:'PUT'})).status,405);
  assert.equal(cameraCalls,0);
  const ok=await app.request('/api/session',{headers:{Origin:`http://127.0.0.1:${app.port}`,'Sec-Fetch-Site':'same-origin'}}); assert.equal(ok.status,200);
  for (const header of ['cache-control','content-security-policy','cross-origin-resource-policy','x-content-type-options','referrer-policy']) assert.ok(ok.headers[header]);
});

test('audit: invalid connect input does not contact camera or change disconnected state', async t => {
  let called=false; const app=await bridge(t,adapter({connect:async()=>{called=true;throw new Error('unexpected');}}));
  for (const value of [{mode:'other'}, {}, [], null]) assert.equal((await app.post('/api/connect',value)).status,400);
  assert.equal((await app.post('/api/connect',{}, {raw:'{broken'})).status,400);
  assert.equal((await app.post('/api/connect',{}, {raw:'{"a":"'+'x'.repeat(1500)+'"}'})).status,413);
  assert.equal((await app.post('/api/connect',{mode:'camera'},{headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await app.request('/api/session')).json().connected,false); assert.equal(called,false);
});

test('audit: demo original is byte-for-byte unchanged and never uses camera', async t => {
  const app=await bridge(t,adapter({connect:async()=>assert.fail('demo must not connect'),list:async()=>assert.fail('demo must not list')}));
  assert.equal((await app.post('/api/connect',{mode:'demo'})).status,200);
  const list=(await app.request('/api/photos')).json(); const chosen=list.photos.find(p=>p.id===photo.id);
  assert.equal(list.mode,'demo'); assert.equal(list.hardwareVerified,false); assert.equal(chosen.synthetic,true);
  const transfer=await app.request(chosen.originalUrl); assert.equal(transfer.status,200); assert.deepEqual(transfer.bytes,original);
  assert.equal(transfer.headers['content-disposition'],`attachment; filename="${name}"`);
  const preview=await app.request(chosen.previewUrl); assert.equal(preview.status,200);
  assert.deepEqual(preview.bytes,await readFile(`${fixtureRoot}/${photo.id}-preview.jpg`));
  assert.equal(preview.headers['content-disposition'],`inline; filename="${name}"`);
});

test('audit: camera original preserves every byte through oddly split chunks', async t => {
  const app=await bridge(t,adapter({readPhoto:async(p,v,signal,consume)=>{
    assert.equal(v,'original'); assert.equal(p.name,name);
    const chunks=[original.subarray(0,1), original.subarray(1,2), original.subarray(2,3), original.subarray(3,original.length-1), original.subarray(original.length-1)];
    return consume(new Response(new ReadableStream({start(c){for(const part of chunks)c.enqueue(part);c.close();}}),{headers:{'content-type':'application/octet-stream','content-length':String(original.length)}}));
  }}));
  await app.post('/api/connect',{mode:'camera'}); const list=(await app.request('/api/photos')).json();
  const transfer=await app.request(list.photos[0].originalUrl); assert.equal(transfer.status,200); assert.deepEqual(transfer.bytes,original);
});

test('audit: reconnect/disconnect invalidate old gallery download URLs', async t => {
  const app=await bridge(t); await app.post('/api/connect',{mode:'demo'});
  const old=(await app.request('/api/photos')).json().photos[0].originalUrl;
  await app.post('/api/disconnect'); assert.equal((await app.request(old)).status,409);
  await app.post('/api/connect',{mode:'demo'}); assert.equal((await app.request(old)).status,409);
  const fresh=(await app.request('/api/photos')).json().photos[0].originalUrl;
  assert.notEqual(old,fresh); assert.equal((await app.request(fresh)).status,200);
  assert.equal((await app.request(fresh.replace(/session=[a-f0-9]+/,'session=bad'))).status,409);
  assert.equal((await app.request(fresh.replace(photo.id,'0'.repeat(24)))).status,404);
});

test('audit: cancelled old connection cannot overwrite a newer demo session', async t => {
  const entered=later(), release=later(); let priorSignal;
  const app=await bridge(t,adapter({connect:async signal=>{priorSignal=signal;entered.resolve();await release.promise;return {properties,photos:[photo]};}}));
  const oldConnect=app.post('/api/connect',{mode:'camera'}); await entered.promise;
  await app.post('/api/connect',{mode:'demo'}); assert.equal(priorSignal.aborted,true);
  release.resolve(); assert.equal((await oldConnect).status,409);
  const state=(await app.request('/api/session')).json(); assert.equal(state.mode,'demo'); assert.equal(state.connected,true);
});

test('audit: late refresh cannot resurrect photos after disconnect', async t => {
  const entered=later(), release=later();
  const app=await bridge(t,adapter({list:async()=>{entered.resolve();await release.promise;return [photo];}}));
  await app.post('/api/connect',{mode:'camera'});
  const refresh=app.post('/api/refresh'); await entered.promise; await app.post('/api/disconnect'); release.resolve();
  assert.equal((await refresh).status,409); assert.equal((await app.request('/api/session')).json().photosCount,0);
});

test('audit: invalid MIME, declared lengths and missing EOI cannot complete downloads', async t => {
  const cases = [
    [Buffer.from('<html>camera error</html>'), {'content-type':'text/html'}],
    [original, {'content-length':String(original.length+10)}],
    [original, {'content-length':'134217729'}],
    [original.subarray(0,-2), {'content-type':'image/jpeg'}],
  ];
  for (const [bytes,headers] of cases) {
    const app=await bridge(t,adapter({readPhoto:async(p,v,s,consume)=>consume(new Response(bytes,{headers}))}));
    await app.post('/api/connect',{mode:'camera'}); const url=(await app.request('/api/photos')).json().photos[0].originalUrl;
    await assertFailedDownload(()=>app.request(url));
  }
});

test('audit: truncated JPEG with an EOI-shaped sequence only inside APP metadata is rejected', async t => {
  // A real JPEG header and APP segment with FF D9 as metadata, then an unfinished SOF.
  // The APP length consumes the apparent EOI, so it is not an image terminator.
  const malformed=Buffer.from([0xff,0xd8,0xff,0xe1,0x00,0x08,0x00,0xff,0xd9,0x00,0x00,0x00,0xff,0xc0]);
  const app=await bridge(t,adapter({readPhoto:async(p,v,s,consume)=>consume(new Response(malformed,{headers:{'content-type':'image/jpeg'}}))}));
  await app.post('/api/connect',{mode:'camera'}); const url=(await app.request('/api/photos')).json().photos[0].originalUrl;
  await assertFailedDownload(()=>app.request(url));
});

test('audit: SOI/EOI signature alone is not a valid original JPEG', async t => {
  const malformed=Buffer.from([0xff,0xd8,0xff,0xd9]);
  const app=await bridge(t,adapter({readPhoto:async(p,v,s,consume)=>consume(new Response(malformed,{headers:{'content-type':'image/jpeg'}}))}));
  await app.post('/api/connect',{mode:'camera'}); const url=(await app.request('/api/photos')).json().photos[0].originalUrl;
  await assertFailedDownload(()=>app.request(url));
});

test('audit: wrong camera model stops before requesting its photo list', async () => {
  const calls=[]; const camera=new CameraAdapter({fetchImpl:async url=>{calls.push(url);return jsonResponse({model:'RICOH GR IIIx'});}});
  await assert.rejects(camera.connect(),{code:'WRONG_MODEL'});
  assert.deepEqual(calls,['http://192.168.0.1/v1/props']);
});

test('audit: camera JSON response and photo count limits are enforced', async () => {
  const camera=new CameraAdapter({fetchImpl:async()=>new Response(' '.repeat(8*1024*1024+1))});
  await assert.rejects(camera.list(),{code:'LIST_TOO_LARGE'});
  const files=Array.from({length:50001},(_,i)=>`R${String(i).padStart(7,'0')}.JPG`);
  assert.throws(()=>parsePhotoList({dirs:[{name:folder,files}]}),{code:'LIST_TOO_LARGE'});
});

test('audit: real adapter props fields are filtered before local API response', async t => {
  const marker='SENSITIVE_TEST_VALUE';
  const camera=new CameraAdapter({fetchImpl:async url=>url.endsWith('/props')
    ? jsonResponse({model:'RICOH GR III', firmwareVersion:'1.91', battery:20, password:marker, serialNumber:marker, macAddress:marker, gps:{latitude:marker}, ssid:marker})
    : jsonResponse({dirs:[{name:folder,files:[name]}]})});
  const app=await bridge(t,camera);
  for (const response of [await app.post('/api/connect',{mode:'camera'}),await app.request('/api/session'),await app.request('/api/photos')]) {
    assert.equal(response.status,200); assert.equal(response.bytes.includes(Buffer.from(marker)),false);
  }
});

test('audit: aborting a pending fetch cancels it and releases camera queue', async () => {
  const entered=later(); let calls=0, upstreamSignal;
  const camera=new CameraAdapter({fetchImpl:async(url,options)=>{
    calls++; if(calls>1)return jsonResponse({dirs:[]});
    upstreamSignal=options.signal; entered.resolve();
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
  const controller=new AbortController(); const pending=camera.list(controller.signal); await entered.promise;
  controller.abort(); await assert.rejects(pending,{code:'CANCELLED'}); assert.equal(upstreamSignal.aborted,true);
  assert.deepEqual(await camera.list(),[]);
});

test('audit: upstream response body failure cannot complete an original download', async t => {
  const app=await bridge(t,adapter({readPhoto:async(p,v,s,consume)=>consume(new Response(new ReadableStream({
    start(c){c.enqueue(original.subarray(0,100));},
    pull(c){c.error(new Error('synthetic interrupted camera stream'));},
  }),{headers:{'content-type':'image/jpeg'}}))}));
  await app.post('/api/connect',{mode:'camera'}); const url=(await app.request('/api/photos')).json().photos[0].originalUrl;
  await assertFailedDownload(()=>app.request(url));
});

test('audit: disconnect aborts outstanding download signal without making further camera requests', async t => {
  const entered=later(); let seenSignal,reads=0;
  const app=await bridge(t,adapter({readPhoto:async(p,v,signal)=>{
    reads++;seenSignal=signal;entered.resolve();
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }}));
  await app.post('/api/connect',{mode:'camera'}); const url=(await app.request('/api/photos')).json().photos[0].originalUrl;
  const download=app.request(url); await entered.promise; await app.post('/api/disconnect');
  assert.equal((await download).status,409); assert.equal(seenSignal.aborted,true); assert.equal(reads,1);
});

function segmentOffset(bytes, target) {
  let offset=2;
  while(offset<bytes.length){
    assert.equal(bytes[offset],0xff); const marker=bytes[offset+1];
    if(marker===target)return offset;
    if(marker===0xda)break;
    offset += 2 + bytes.readUInt16BE(offset+2);
  }
  throw new Error(`Synthetic fixture has no ${target.toString(16)} marker`);
}
function validate(bytes, chunkSize=bytes.length) {
  const parser=new JpegValidator();
  for(let i=0;i<bytes.length;i+=chunkSize)parser.push(bytes.subarray(i,i+chunkSize));
  parser.finish();
}

test('audit: marker parser accepts every synthetic original, preview and thumbnail across arbitrary chunk boundaries', async () => {
  const manifest=JSON.parse(await readFile(`${fixtureRoot}/manifest.json`,'utf8'));
  for(const item of manifest){
    for(const suffix of ['','-thumb','-preview']){
      const bytes=await readFile(`${fixtureRoot}/${item.id}${suffix}.jpg`);
      for(const chunkSize of [1,2,3,17,4096]) assert.doesNotThrow(()=>validate(bytes,chunkSize),`${item.id}${suffix}, chunks ${chunkSize}`);
    }
  }
});

test('audit: embedded EOI in an APP segment is skipped while actual outer EOI is required', () => {
  const appSegment=Buffer.from([0xff,0xe1,0x00,0x08,0x00,0xff,0xd9,0x00,0x00,0x00]);
  const nested=Buffer.concat([original.subarray(0,2),appSegment,original.subarray(2)]);
  assert.doesNotThrow(()=>validate(nested,1));
  assert.throws(()=>validate(nested.subarray(0,-2),1),{code:'INCOMPLETE_JPEG'});
});

test('audit: marker-level entropy handling accepts stuffing/restarts across chunk boundaries', () => {
  const sos=segmentOffset(original,0xda), entropyStart=sos+2+original.readUInt16BE(sos+2);
  // This tests marker syntax only. Added entropy is deliberately not pixel-decoded.
  const synthetic=Buffer.concat([original.subarray(0,entropyStart),Buffer.from([0xff,0x00,0xff,0xd0]),original.subarray(entropyStart)]);
  assert.doesNotThrow(()=>validate(synthetic,1));
});

test('audit: marker parser rejects zero or inconsistent SOF component counts', () => {
  const sof=segmentOffset(original,0xc0);
  for(const count of [0,1,4,255]){
    const malformed=Buffer.from(original);malformed[sof+9]=count;
    assert.throws(()=>validate(malformed,3),{code:'INCOMPLETE_JPEG'},`SOF component count ${count}`);
  }
});

test('audit: marker parser rejects zero or inconsistent SOS component counts', () => {
  const sos=segmentOffset(original,0xda);
  for(const count of [0,1,4,255]){
    const malformed=Buffer.from(original);malformed[sos+4]=count;
    assert.throws(()=>validate(malformed,3),{code:'INCOMPLETE_JPEG'},`SOS component count ${count}`);
  }
});

test('audit: closing a local download aborts its camera read', async t => {
  const entered=later(),cancelled=later();let upstream;
  const app=await bridge(t,adapter({readPhoto:async(p,v,signal)=>{
    upstream=signal;entered.resolve();
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled.resolve();reject(signal.reason);},{once:true}));
  }}));
  await app.post('/api/connect',{mode:'camera'}); const url=(await app.request('/api/photos')).json().photos[0].originalUrl;
  const req=http.get({host:'127.0.0.1',port:app.port,path:url});req.on('error',()=>{});
  await entered.promise;req.destroy();
  await Promise.race([cancelled.promise,new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Local disconnect did not cancel read')),1000);timeout.unref();cancelled.promise.then(()=>clearTimeout(timeout));
  })]);
  assert.equal(upstream.aborted,true);
});

test('audit: cancellation while reading camera JSON is reported as cancellation', async () => {
  const entered=later();
  const camera=new CameraAdapter({fetchImpl:async(url,{signal})=>new Response(new ReadableStream({start(c){
    c.enqueue(Buffer.from('{"dirs":'));entered.resolve();
    signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});
  }}))});
  const controller=new AbortController();const pending=camera.list(controller.signal);
  await entered.promise;controller.abort();
  await assert.rejects(pending,{code:'CANCELLED',status:409});
});

test('audit: camera request timeout aborts fetch and releases the queue', async () => {
  let calls=0,upstream;
  const camera=new CameraAdapter({jsonTimeout:15,fetchImpl:async(url,{signal})=>{
    calls++;if(calls>1)return jsonResponse({dirs:[]});upstream=signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  // AbortSignal.timeout is unref'ed. This bounded guard keeps the test alive and cannot make camera requests.
  const guard=setTimeout(()=>{},1000);
  try{await assert.rejects(camera.list(),{code:'CAMERA_UNREACHABLE'});assert.equal(upstream.aborted,true);assert.deepEqual(await camera.list(),[]);}
  finally{clearTimeout(guard);}
});
