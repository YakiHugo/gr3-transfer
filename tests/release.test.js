import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { publishPreview } from '../scripts/publish-preview.mjs';
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), version = '0.2.0-preview.1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'camera-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const desktopDirectory = path.join(root, 'desktop'), androidDirectory = path.join(root, 'android');
  await mkdir(desktopDirectory); await mkdir(path.join(androidDirectory, 'debug'), { recursive: true });
  for (const arch of ['arm64', 'x64']) {
    const name = `camera-transfer-darwin-${arch}.tar.gz`, bytes = gzipSync(Buffer.from(`Synthetic archive ${arch}`));
    await writeFile(path.join(desktopDirectory, name), bytes); await writeFile(path.join(desktopDirectory, `${name}.sha256`), `${hash(bytes)}  ${name}\n`);
  }
  await writeFile(path.join(androidDirectory, 'debug', 'app-debug.apk'), Buffer.from([0x50,0x4b,3,4,1,2,3,4]));
  const state = { main: SHA, tag: null, release: null, assets: [], clock: 0, uploads: 0, writes: [], published: false,
    runs: ['Verify original transfer', 'Verify Chinese browser UI'].map(name => ({ name, head_sha: SHA, event: 'push', status: 'completed', conclusion: 'success' })) };
  const missing = () => { throw Object.assign(new Error('not found'), { status: 404 }); };
  const github = { rest: { actions: { listWorkflowRunsForRepo: async () => ({ data: { workflow_runs: state.runs } }) }, git: {
    getRef: async () => state.tag ? { data: { object: { type: 'commit', sha: state.tag } } } : missing(),
    createRef: async args => { state.writes.push('tag'); state.tag = args.sha; return { data: {} }; },
  }, repos: {
    getBranch: async () => ({ data: { commit: { sha: state.main } } }),
    getReleaseByTag: async () => state.release ? { data: state.release } : missing(),
    listReleases: async () => ({ data: [] }),
    createRelease: async args => { state.writes.push('draft'); state.release = { ...args, id: 1, html_url: 'https://github.com/example/camera/releases/tag/v0.2.0-preview.1' }; return { data: state.release }; },
    listReleaseAssets: async () => ({ data: state.assets }),
    uploadReleaseAsset: async args => {
      state.uploads++; if (state.failUpload === state.uploads) throw new Error('synthetic upload failure');
      const asset = { id: state.uploads + 100, state: 'uploaded', name: args.name, size: args.data.length, digest: `sha256:${hash(args.data)}`, bytes: args.data };
      state.assets.push(asset); state.writes.push('upload');
      if (state.advanceOnUpload) state.main = OTHER;
      if (state.moveTagOnUpload) state.tag = OTHER;
      if (state.failCheckOnUpload) state.runs[0].conclusion = 'failure';
      if (state.extraAssetOnUpload && state.uploads === 5) state.assets.push({ name: 'unexpected.zip' });
      return { data: state.badDigest ? { ...asset, digest: 'sha256:wrong' } : asset };
    },
    deleteReleaseAsset: async args => { state.writes.push('delete-starter'); state.assets = state.assets.filter(asset => asset.id !== args.asset_id); return {}; },
    updateRelease: async args => { assert.equal(state.assets.length, 5); assert.equal(args.draft, false); state.writes.push('publish'); state.published = true; state.release.draft = false; return { data: state.release }; },
  } } };
  const args = { github, context: { eventName: 'push', ref: 'refs/heads/main', sha: SHA, runId: 123, repo: { owner: 'example', repo: 'camera' } }, core: { notice() {}, info() {}, setOutput() {} }, version, testedApkSha256: hash(Buffer.from([0x50,0x4b,3,4,1,2,3,4])), desktopDirectory, androidDirectory, now: () => state.clock, wait: async ms => { state.clock += ms; } };
  return { args, state, run: () => publishPreview(args), desktopDirectory, androidDirectory };
}

test('release: uploads only both verified Mac bundles, tested APK, provenance and checksums before publishing', async t => {
  const h = await harness(t); const release = await h.run(); assert.equal(release.draft, false); assert.equal(h.state.published, true);
  assert.deepEqual(h.state.assets.map(a => a.name), ['camera-transfer-darwin-arm64.tar.gz','camera-transfer-darwin-x64.tar.gz','camera-transfer-android-debug.apk','BUILD-INFO.json','SHA256SUMS.txt']);
  const info = JSON.parse(h.state.assets.find(a => a.name === 'BUILD-INFO.json').bytes); assert.equal(info.sourceCommit, SHA); assert.equal(info.workflowRun,123); assert.equal(info.hardwareVerified,false);
  const sums = h.state.assets.find(a => a.name === 'SHA256SUMS.txt').bytes.toString();
  for (const asset of h.state.assets.slice(0,-1)) assert.ok(sums.includes(`${hash(asset.bytes)}  ${asset.name}\n`));
  assert.equal(h.state.writes.at(-1),'publish');
});

test('release: rejects non-main and untrusted invocation metadata before any writes', async t => {
  for (const patch of [{eventName:'pull_request'}, {ref:'refs/heads/other'}, {sha:'main'}, {runId:0}]) {
    const h=await harness(t); Object.assign(h.args.context,patch); await assert.rejects(h.run()); assert.deepEqual(h.state.writes,[]);
  }
  const h=await harness(t);h.args.version='0.2.0; touch /tmp/unsafe';await assert.rejects(h.run(),/version/);assert.deepEqual(h.state.writes,[]);
});

test('release: exact-head failed, cancelled, missing and foreign-event checks fail closed', async t => {
  for (const change of [runs=>{runs[0].conclusion='failure';},runs=>{runs[0].conclusion='cancelled';},runs=>{runs.pop();},runs=>{runs[0].head_sha=OTHER;},runs=>{runs[0].event='pull_request';}]) {
    const h=await harness(t);change(h.state.runs);await assert.rejects(h.run(),/workflow|pending/);assert.deepEqual(h.state.writes,[]);
  }
});

test('release: waits for exact-head checks to finish rather than treating in-progress as success', async t => {
  const h=await harness(t);h.state.runs[1].status='in_progress';h.args.wait=async ms=>{h.state.clock+=ms;h.state.runs[1].status='completed';};await h.run();assert.equal(h.state.clock,10000);assert.equal(h.state.published,true);
});

test('release: stale main is skipped before a tag or release is created', async t => {
  const h=await harness(t);h.state.main=OTHER;assert.equal(await h.run(),null);assert.deepEqual(h.state.writes,[]);
});

test('release: altered archives, missing architecture, unexpected files and invalid APK are rejected', async t => {
  for (const mutation of [
    h=>writeFile(path.join(h.desktopDirectory,'camera-transfer-darwin-arm64.tar.gz'),gzipSync(Buffer.from('changed'))),
    h=>rm(path.join(h.desktopDirectory,'camera-transfer-darwin-x64.tar.gz')),
    h=>writeFile(path.join(h.desktopDirectory,'unreviewed.txt'),'extra'),
    h=>writeFile(path.join(h.androidDirectory,'debug','app-debug.apk'),'not an APK'),
  ]) { const h=await harness(t);await mutation(h);await assert.rejects(h.run());assert.deepEqual(h.state.writes,[]); }
});

test('release: does not overwrite a published version or mismatched draft or tag', async t => {
  const h=await harness(t);h.state.release={draft:false,target_commitish:OTHER};assert.equal(await h.run(),null);assert.deepEqual(h.state.writes,[]);
  const draft=await harness(t);draft.state.release={id:1,draft:true,target_commitish:OTHER};await assert.rejects(draft.run(),/another commit/);assert.deepEqual(draft.state.writes,[]);
  const tag=await harness(t);tag.state.tag=OTHER;await assert.rejects(tag.run(),/another commit/);assert.deepEqual(tag.state.writes,[]);
});

test('release: unexpected or mismatched existing assets keep a draft unpublished', async t => {
  for (const asset of [{name:'extra.zip',size:1,digest:'wrong'},{name:'camera-transfer-darwin-arm64.tar.gz',size:1,digest:'wrong'}]) {
    const h=await harness(t);h.state.release={id:1,draft:true,target_commitish:SHA};h.state.tag=SHA;h.state.assets=[asset];await assert.rejects(h.run(),/unexpected|differs/);assert.equal(h.state.published,false);assert.deepEqual(h.state.writes,[]);
  }
});

test('release: interrupted upload leaves a resumable draft and matching uploaded bytes are not uploaded twice', async t => {
  const h=await harness(t);h.state.failUpload=2;await assert.rejects(h.run(),/synthetic upload/);assert.equal(h.state.release.draft,true);assert.equal(h.state.assets.length,1);
  h.state.failUpload=null;await h.run();assert.equal(h.state.published,true);assert.equal(h.state.assets.length,5);assert.equal(h.state.uploads,6);
});

test('release: uploaded digest mismatches never publish a draft', async t => {
  const h=await harness(t);h.state.badDigest=true;await assert.rejects(h.run(),/digest/);assert.equal(h.state.release.draft,true);assert.equal(h.state.published,false);
});

test('release: main or tag moving during upload prevents publication', async t => {
  const h=await harness(t);h.state.advanceOnUpload=true;assert.equal(await h.run(),null);assert.equal(h.state.release.draft,true);
  const tag=await harness(t);tag.state.moveTagOnUpload=true;await assert.rejects(tag.run(),/Tag changed/);assert.equal(tag.state.release.draft,true);
});

test('release: workflow requires all current-run builds and emulator before its scoped main-only publisher', async () => {
  const yaml=await readFile(new URL('../.github/workflows/android.yml',import.meta.url),'utf8');
  assert.match(yaml,/needs: \[android, emulator, desktop-previews\]/);assert.match(yaml,/publish-preview:\s+if: github.event_name == 'push' && github.ref == 'refs\/heads\/main'/);
  assert.match(yaml,/uses: \.\/\.github\/workflows\/desktop-preview.yml/);assert.match(yaml,/pattern: camera-transfer-macos-\*/);
  assert.match(yaml,/tested-apk-sha256: \$\{\{ steps\.native-tests\.outputs\.apk-sha256 \}\}/);
  assert.match(yaml,/TESTED_APK_SHA256: \$\{\{ needs\.emulator\.outputs\.tested-apk-sha256 \}\}/);
  assert.doesNotMatch(yaml,/secrets\.|gh auth|sdkmanager --licenses/);
});


test('release: APK must match digest output by the successful emulator before any release writes', async t => {
  for (const checksum of [undefined, '', 'invalid', 'b'.repeat(64)]) {
    const h = await harness(t); h.args.testedApkSha256 = checksum;
    await assert.rejects(h.run(), /digest|APK bytes/); assert.deepEqual(h.state.writes, []);
  }
  const h = await harness(t);
  await writeFile(path.join(h.androidDirectory, 'debug', 'app-debug.apk'), Buffer.from([0x50,0x4b,3,4,9,8,7,6]));
  await assert.rejects(h.run(), /APK bytes/); assert.deepEqual(h.state.writes, []);
});

test('release: retries only documented empty starter placeholders in exact-source drafts', async t => {
  const h = await harness(t); h.state.release = {id:1,draft:true,target_commitish:SHA}; h.state.tag = SHA;
  h.state.assets = [{id:99, name:'camera-transfer-darwin-arm64.tar.gz',state:'starter',size:0}];
  await h.run(); assert.equal(h.state.published,true); assert.equal(h.state.writes[0],'delete-starter');
  for (const patch of [{size:1},{state:'uploaded'},{name:'unknown.apk'},{id:undefined}]) {
    const invalid = await harness(t); invalid.state.release = {id:1,draft:true,target_commitish:SHA}; invalid.state.tag = SHA;
    invalid.state.assets = [{id:99,name:'camera-transfer-darwin-arm64.tar.gz',state:'starter',size:0,...patch}];
    await assert.rejects(invalid.run(),/unexpected|differs/); assert.deepEqual(invalid.state.writes,[]);
  }
});

test('release: a changed required workflow or unexpected final asset blocks publication', async t => {
  const checks = await harness(t); checks.state.failCheckOnUpload = true;
  await assert.rejects(checks.run(),/checks changed/); assert.equal(checks.state.published,false); assert.equal(checks.state.release.draft,true);
  const assets = await harness(t); assets.state.extraAssetOnUpload = true;
  await assert.rejects(assets.run(),/Final release assets/); assert.equal(assets.state.published,false); assert.equal(assets.state.release.draft,true);
});
