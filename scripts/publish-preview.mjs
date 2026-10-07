/** Publish only verified main-run test artifacts. Uses the workflow's existing GitHub identity. */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const exactSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
async function tagCommit(github, repo, tag) {
  let object;
  try { object = (await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` })).data.object; }
  catch (error) { if (error.status === 404) return null; throw error; }
  for (let depth = 0; depth < 8; depth++) {
    if (object?.type === 'commit' && exactSha(object.sha)) return object.sha;
    if (object?.type !== 'tag' || !exactSha(object.sha)) throw new Error('Unsupported release tag reference');
    object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha })).data.object;
  }
  throw new Error('Release tag nesting exceeds verification limit');
}
async function collectAssets(desktopDirectory, androidDirectory, context, version, testedApkSha256) {
  const archives = ['arm64', 'x64'].map(arch => `camera-transfer-darwin-${arch}.tar.gz`);
  const expected = archives.flatMap(name => [name, `${name}.sha256`]);
  const names = await readdir(desktopDirectory);
  if (names.length !== expected.length || names.some(name => !expected.includes(name))) throw new Error('Expected exactly both current-run Mac archives and checksums');
  const assets = [];
  for (const name of archives) {
    const bytes = await readFile(path.join(desktopDirectory, name));
    if (bytes.length < 2 || bytes.length > MAX_ASSET_BYTES || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Invalid or oversized Mac archive');
    const sha = digest(bytes), checksum = await readFile(path.join(desktopDirectory, `${name}.sha256`), 'utf8');
    if (checksum.trim() !== `${sha.slice(7)}  ${name}`) throw new Error('Mac archive checksum does not match its verified build');
    assets.push({ name, bytes, digest: sha, type: 'application/gzip' });
  }
  // This exact artifact is also installed by the successful emulator job in this run.
  const apk = await readFile(path.join(androidDirectory, 'debug', 'app-debug.apk'));
  if (apk.length < 4 || apk.length > MAX_ASSET_BYTES || !apk.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('Invalid or oversized test APK');
  if (digest(apk).slice(7) !== testedApkSha256) throw new Error('APK bytes differ from the successful emulator job');
  assets.push({ name: 'camera-transfer-android-debug.apk', bytes: apk, digest: digest(apk), type: 'application/vnd.android.package-archive' });
  const buildInfo = Buffer.from(`${JSON.stringify({
    formatVersion: 1, version, sourceCommit: context.sha, workflowRun: context.runId,
    hardwareVerified: false, macSignedOrNotarized: false, androidReleaseIdentity: false,
    scope: 'Synthetic workflow tests and artifact-byte checks. Not physical camera, user Mac, or phone acceptance.',
    files: assets.map(asset => ({ name: asset.name, bytes: asset.bytes.length, sha256: asset.digest.slice(7) })),
  }, null, 2)}\n`);
  assets.push({ name: 'BUILD-INFO.json', bytes: buildInfo, digest: digest(buildInfo), type: 'application/json' });
  const sums = Buffer.from(`${assets.map(asset => `${asset.digest.slice(7)}  ${asset.name}`).join('\n')}\n`);
  assets.push({ name: 'SHA256SUMS.txt', bytes: sums, digest: digest(sums), type: 'text/plain' });
  return assets;
}
export async function publishPreview({ github, context, core, version, testedApkSha256, desktopDirectory = 'release-desktop', androidDirectory = 'release-android', wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  if (context.eventName !== 'push' || context.ref !== 'refs/heads/main' || !exactSha(context.sha)) throw new Error('Publishing requires an exact main push');
  if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(version)) throw new Error('Invalid preview version');
  if (!Number.isSafeInteger(context.runId) || context.runId < 1) throw new Error('Missing current workflow run');
  if (typeof testedApkSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(testedApkSha256)) throw new Error('Missing successful emulator APK digest');
  const assets = await collectAssets(desktopDirectory, androidDirectory, context, version, testedApkSha256), repo = context.repo;
  const required = ['Verify original transfer', 'Verify Chinese browser UI'];
  const deadline = now() + 10 * 60 * 1000;
  while (true) {
    const { data } = await github.rest.actions.listWorkflowRunsForRepo({ ...repo, head_sha: context.sha, event: 'push', per_page: 100 });
    const runs = required.map(name => data.workflow_runs.find(run => run.name === name && run.head_sha === context.sha && run.event === 'push'));
    if (runs.some(run => run?.status === 'completed' && run.conclusion !== 'success')) throw new Error('A required exact-commit workflow did not pass');
    if (runs.every(run => run?.status === 'completed' && run.conclusion === 'success')) break;
    if (now() >= deadline) throw new Error('Exact-commit checks are still pending; no release was published');
    await wait(10000);
  }
  // The workflow additionally requires its own Android lint/build, emulator, and both Mac builds.
  if ((await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data.commit.sha !== context.sha) { core.notice('Main advanced; this build will not publish'); return null; }
  const tag = `v${version}`;
  let release;
  try { release = (await github.rest.repos.getReleaseByTag({ ...repo, tag })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  if (!release) {
    const matches = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await github.rest.repos.listReleases({ ...repo, per_page: 100, page });
      matches.push(...data.filter(item => item.tag_name === tag));
      if (data.length < 100) break;
      if (page === 10) throw new Error('Release history exceeds safe lookup limit');
    }
    if (matches.length > 1) throw new Error('Multiple drafts share this tag');
    release = matches[0];
  }
  if (release && !release.draft) { core.notice('This preview is already published; published files were not changed'); return null; }
  if (release && release.target_commitish !== context.sha) throw new Error('Draft belongs to another commit');
  let tagged = await tagCommit(github, repo, tag);
  if (tagged && tagged !== context.sha) throw new Error('Tag belongs to another commit');
  if (!tagged) {
    try { await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha: context.sha }); }
    catch (error) { if (error.status !== 422) throw error; }
    tagged = await tagCommit(github, repo, tag);
    if (tagged !== context.sha) throw new Error('Exact verified tag could not be reserved');
  }
  if (!release) release = (await github.rest.repos.createRelease({
    ...repo, tag_name: tag, target_commitish: context.sha, name: `GR Relay ${version} · tested previews`, draft: true, prerelease: true,
    body: `相机原片传输测试版：macOS Apple Silicon / Intel 便携包，以及 Android 10+ 测试 APK。\n\nSource commit: ${context.sha}\nWorkflow run: https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}\n\n同一提交的协议、原片字节、真实 Chromium、Android lint/build、API29 模拟器 MediaStore 保存校验/重启，以及双 Mac 内置运行时冒烟检查通过后才发布。使用生成的测试图片；尚未通过真实 GR III、用户 Mac 或手机验证。仅支持 GR III JPEG，RAW 只显示配对信息。\n\nMac 包未签名、未公证，请勿绕过系统安全拦截。APK 为开发测试签名，可能与旧测试包签名不同而无法覆盖安装；升级前先保存暂存原片，确认相册副本可打开并完成备份；卸载会删除应用私有原片。无法导出时请保留旧应用。没有导出、复用或持久化发布密钥。\n\n照片由本机处理。Android 相册或系统已有的云备份可能上传保存后的照片。SHA256SUMS.txt 和 BUILD-INFO.json 核对下载包与来源，不代替真实相机原片比对。`,
  })).data;
  let existing = (await github.rest.repos.listReleaseAssets({ ...repo, release_id: release.id, per_page: 100 })).data;
  if (existing.some(item => !assets.some(asset => asset.name === item.name)) || new Set(existing.map(item => item.name)).size !== existing.length) throw new Error('Draft contains unexpected assets');
  for (const item of existing) {
    const asset = assets.find(candidate => candidate.name === item.name);
    if (item.state === 'starter' && item.size === 0 && Number.isSafeInteger(item.id) && item.id > 0) continue;
    if (item.state !== 'uploaded' || item.digest !== asset.digest || item.size !== asset.bytes.length) throw new Error('Existing draft asset differs; nothing was overwritten');
  }
  // GitHub may leave an empty starter placeholder after a failed upload. It has
  // no file bytes; only remove expected placeholders in this exact-SHA draft.
  for (const item of existing.filter(item => item.state === 'starter')) {
    await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: item.id });
  }
  existing = existing.filter(item => item.state !== 'starter');
  for (const asset of assets) {
    let uploaded = existing.find(item => item.name === asset.name);
    if (!uploaded) uploaded = (await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: release.id, name: asset.name, data: asset.bytes, headers: { 'content-type': asset.type, 'content-length': asset.bytes.length } })).data;
    if (uploaded.state !== 'uploaded' || uploaded.digest !== asset.digest || uploaded.size !== asset.bytes.length) throw new Error('Uploaded asset digest/size could not be verified; release stays draft');
  }
  const finalAssets = (await github.rest.repos.listReleaseAssets({ ...repo, release_id: release.id, per_page: 100 })).data;
  if (finalAssets.length !== assets.length || new Set(finalAssets.map(item => item.name)).size !== assets.length || finalAssets.some(item => {
    const asset = assets.find(candidate => candidate.name === item.name);
    return !asset || item.state !== 'uploaded' || item.digest !== asset.digest || item.size !== asset.bytes.length;
  })) throw new Error('Final release assets do not match verified files; release stays draft');
  if ((await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data.commit.sha !== context.sha) { core.notice('Main advanced during upload; release stays draft'); return null; }
  if (await tagCommit(github, repo, tag) !== context.sha) throw new Error('Tag changed during upload; release stays draft');
  const finalRuns = (await github.rest.actions.listWorkflowRunsForRepo({ ...repo, head_sha: context.sha, event: 'push', per_page: 100 })).data.workflow_runs;
  if (!required.every(name => {
    const run = finalRuns.find(item => item.name === name && item.head_sha === context.sha && item.event === 'push');
    return run?.status === 'completed' && run.conclusion === 'success';
  })) throw new Error('Exact-commit checks changed during upload; release stays draft');
  release = (await github.rest.repos.updateRelease({ ...repo, release_id: release.id, draft: false, prerelease: true })).data;
  core.setOutput('release_url', release.html_url); core.info(`Published verified test preview: ${release.html_url}`);
  return release;
}
