import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createPluginUpdater, PluginUpdateError } = await import('../dist/update.js');

const META = { name: '@demo/plugin', version: '0.3.0' };
const PROFILE = { name: 'desktop', dir: '/profiles/desktop' };

function profileJson(spec) {
  return JSON.stringify({ dependencies: { '@demo/plugin': spec } });
}

function fakeManager(handlers = {}) {
  const calls = [];
  return {
    calls,
    async installBundle(spec) {
      calls.push(['install', spec]);
      return handlers.install === undefined ? { application: 'applied' } : handlers.install(spec, calls);
    },
    async removeBundle(name) {
      calls.push(['remove', name]);
      return handlers.remove === undefined ? { application: 'applied' } : handlers.remove(name, calls);
    },
    ...(handlers.registries === undefined ? {} : { registries: handlers.registries }),
  };
}

function fetchOf(versions, options = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const base = String(url);
    if (options.throwFor !== undefined && base.includes(options.throwFor)) throw new Error('network down');
    const version = versions[base] ?? options.default;
    if (version === undefined) return { ok: false, status: 404, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { version }; } };
  };
  impl.calls = calls;
  return impl;
}

function updater(overrides = {}) {
  const logs = [];
  const manager = overrides.manager ?? fakeManager();
  const fetchImpl = overrides.fetchImpl ?? fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' });
  return createPluginUpdater({
    meta: META,
    getPluginManager: () => manager,
    getProfile: () => PROFILE,
    readFile: overrides.readFile ?? (async () => profileJson('^0.3.0')),
    fetchImpl,
    ...(overrides.runPnpmView === undefined ? {} : { runPnpmView: overrides.runPnpmView }),
    ...(overrides.registryPlan === undefined ? {} : { registryPlan: overrides.registryPlan }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.cacheTtlMs === undefined ? {} : { cacheTtlMs: overrides.cacheTtlMs }),
    logger: (event, detail) => logs.push([event, detail]),
    ...(overrides.meta === undefined ? {} : { meta: overrides.meta }),
    ...(overrides.getProfile === undefined ? {} : { getProfile: overrides.getProfile }),
    ...(overrides.getPluginManager === undefined ? {} : { getPluginManager: overrides.getPluginManager }),
    ...(overrides.readInstalledVersion === undefined ? {} : { readInstalledVersion: overrides.readInstalledVersion }),
    ...(overrides.stateStore === undefined ? {} : { stateStore: overrides.stateStore }),
  });
}

test('check：有新版 / 已是最新 / 查询失败', async () => {
  const latest = updater();
  const view = await latest.check();
  assert.equal(view.updateAvailable, true);
  assert.equal(view.latestVersion, '0.4.0');
  assert.equal(view.canApply, true);
  assert.equal(view.installKind, 'registry');
  assert.equal(view.manualCommand, 'dsh plugin --profile desktop add @demo/plugin@latest');

  const same = updater({ fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.3.0' }) });
  assert.equal((await same.check()).updateAvailable, false);

  const failing = updater({ fetchImpl: async () => { throw new Error('offline'); } });
  const failed = await failing.check();
  assert.equal(failed.checkFailed, true);
  assert.equal(failed.latestVersion, null);
  assert.equal(failed.updateAvailable, false);
});

test('registry 计划优先，失败按回退顺序继续', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://mirror.example/')) return { ok: false, status: 500, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { version: '0.5.0' }; } };
  };
  const manager = fakeManager({ registries: async () => ({ resolved: 'https://mirror.example', fallbackRegistries: ['https://fallback.example'] }) });
  const instance = updater({ manager, fetchImpl });
  const view = await instance.check();
  assert.equal(view.latestVersion, '0.5.0');
  assert.deepEqual(calls, [
    'https://mirror.example/@demo%2Fplugin/latest',
    'https://fallback.example/@demo%2Fplugin/latest',
  ]);
});

test('注入宿主原生 registryPlan：查版本的 registry 顺序以它为准', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, async json() { return { version: '0.6.0' }; } };
  };
  // 宿主的原生 plan 把 custom 源放首位（模拟私有源「只问它自己」），内置兜底则会问 resolved+fallback
  const hostRegistryPlan = () => ['https://private.example/'];
  const manager = fakeManager({
    registries: async () => ({ resolved: 'https://public.example', fallbackRegistries: ['https://fallback.example'] }),
  });
  const instance = updater({ manager, fetchImpl, registryPlan: hostRegistryPlan });
  const view = await instance.check();
  assert.equal(view.latestVersion, '0.6.0');
  assert.deepEqual(calls, ['https://private.example/@demo%2Fplugin/latest']);
});

test('pnpm view 优先生效，命中后不再打 registry', async () => {
  const before = fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' });
  const instance = updater({ fetchImpl: before, runPnpmView: async () => '9.9.9' });
  const view = await instance.check();
  assert.equal(view.latestVersion, '9.9.9');
  assert.equal(before.calls.length, 0);
});

test('缓存：默认命中，fresh 重新查', async () => {
  let now = 1_000;
  const fetchImpl = fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' });
  const instance = updater({ fetchImpl, now: () => now, cacheTtlMs: 1000 });
  await instance.check();
  await instance.check();
  assert.equal(fetchImpl.calls.length, 1);
  now = 3_000;
  await instance.check();
  assert.equal(fetchImpl.calls.length, 2);
  await instance.check({ fresh: true });
  assert.equal(fetchImpl.calls.length, 3);
});

test('link: 安装：不能一键更新，apply 直接拒绝', async () => {
  const instance = updater({ readFile: async () => profileJson('link:../dsh-plugin-kit') });
  const view = await instance.check();
  assert.equal(view.installKind, 'link');
  assert.equal(view.canApply, false);
  await assert.rejects(instance.apply(), (error) => error instanceof PluginUpdateError && error.code === 'LINKED_INSTALL');
});

test('没有 pluginManager：只给手动命令', async () => {
  const instance = updater({ getPluginManager: () => undefined });
  const view = await instance.check();
  assert.equal(view.canApply, false);
  await assert.rejects(instance.apply(), (error) => error.code === 'NO_MANAGER');
});

test('apply：already-installed → remove → install 成功', async () => {
  let installCount = 0;
  const manager = fakeManager({
    install: () => {
      installCount += 1;
      return installCount === 1 ? { error: { code: 'already-installed' } } : { application: 'restart-required' };
    },
  });
  const instance = updater({ manager });
  await instance.check();
  const result = await instance.apply();
  assert.equal(result.application, 'restart-required');
  assert.equal(result.restartRequired, true);
  assert.equal(result.updatedVersion, '0.4.0');
  assert.deepEqual(manager.calls, [
    ['install', '@demo/plugin@0.4.0'],
    ['remove', '@demo/plugin'],
    ['install', '@demo/plugin@0.4.0'],
  ]);
  assert.deepEqual(result.steps, ['install @demo/plugin@0.4.0', 'remove @demo/plugin', 'install @demo/plugin@0.4.0']);
});

test('apply：remove 之后安装失败 → 回滚到原版本并报错', async () => {
  let installCount = 0;
  const manager = fakeManager({
    install: (spec) => {
      installCount += 1;
      if (installCount === 1) return { error: { code: 'already-installed' } };
      if (installCount === 2) return { error: { message: 'disk full' } };
      return { application: 'applied' };
    },
  });
  const instance = updater({ manager });
  await instance.check();
  await assert.rejects(instance.apply(), (error) => error.code === 'INSTALL_FAILED' && error.message.includes('disk full'));
  assert.deepEqual(manager.calls.at(-1), ['install', '@demo/plugin@0.3.0']);
});

test('apply：版本/状态前置校验', async () => {
  const instance = updater();
  await assert.rejects(instance.apply(), (error) => error.code === 'NOT_CHECKED');
  await instance.check();
  await assert.rejects(instance.apply({ version: '0.9.9' }), (error) => error.code === 'INVALID_VERSION');

  const current = updater({ fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.3.0' }) });
  await current.check();
  await assert.rejects(current.apply(), (error) => error.code === 'NO_UPDATE');
});

test('apply：结果形态包了一层 {ok,value} 也能接', async () => {
  const manager = fakeManager({ install: async () => ({ ok: true, value: { application: 'applied' } }) });
  const instance = updater({ manager });
  await instance.check();
  const result = await instance.apply();
  assert.equal(result.application, 'applied');
  assert.equal(result.restartRequired, false);
});

test('事件名固定：check / apply.start / apply / apply.failed', async () => {
  const events = [];
  const manager = fakeManager({ install: async () => ({ error: { message: 'boom' } }) });
  const instance = createPluginUpdater({
    meta: META,
    getPluginManager: () => manager,
    getProfile: () => PROFILE,
    readFile: async () => profileJson('^0.3.0'),
    fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' }),
    logger: (event) => events.push(event),
  });
  await instance.check();
  await assert.rejects(instance.apply());
  assert.deepEqual(events, [
    'plugin.update.latest',
    'plugin.update.check',
    'plugin.update.apply.start',
    'plugin.update.apply.failed',
  ]);
});

// ── 磁盘版本真相链 ────────────────────────────────────────────────────

test('磁盘版本：快照落后但磁盘已最新 → 不报有更新，且 restartRequired 为真', async () => {
  // 进程加载的是 0.3.0（runtime），但磁盘已经装到 0.4.0（=latest），仅未重启。
  const instance = updater({
    readInstalledVersion: () => '0.4.0',
    fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' }),
  });
  const view = await instance.check();
  assert.equal(view.currentVersion, '0.4.0'); // 磁盘真身
  assert.equal(view.runtimeVersion, '0.3.0'); // 进程快照
  assert.equal(view.updateAvailable, false); // 不再谎报
  assert.equal(view.restartRequired, true); // 但要重启
});

test('磁盘版本：磁盘落后 → 有更新、不待重启', async () => {
  const instance = updater({
    readInstalledVersion: () => '0.3.0',
    fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' }),
  });
  const view = await instance.check();
  assert.equal(view.currentVersion, '0.3.0');
  assert.equal(view.updateAvailable, true);
  assert.equal(view.restartRequired, false);
});

test('磁盘版本：磁盘已最新再点 apply → NO_UPDATE（杜绝重复安装循环）', async () => {
  let installs = 0;
  const manager = fakeManager({ install: () => { installs += 1; return { application: 'restart-required' }; } });
  const instance = updater({
    manager,
    readInstalledVersion: () => '0.3.0',
    fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' }),
  });
  await instance.check();
  const result = await instance.apply();
  assert.equal(result.updatedVersion, '0.4.0');
  assert.equal(installs, 1);
  // 模拟磁盘已被更新到 0.4.0：再次 check 后 apply 必须 NO_UPDATE
  const again = updater({
    manager,
    readInstalledVersion: () => '0.4.0',
    fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' }),
  });
  await again.check();
  await assert.rejects(again.apply(), (error) => error.code === 'NO_UPDATE');
});

test('磁盘版本：readInstalledVersion 读失败（空串）→ 回退 runtime，不谎报', async () => {
  const instance = updater({
    readInstalledVersion: () => '',
    fetchImpl: fetchOf({ 'https://registry.npmjs.org/@demo%2Fplugin/latest': '0.4.0' }),
  });
  const view = await instance.check();
  assert.equal(view.currentVersion, '0.3.0'); // 回退 meta.version
  assert.equal(view.updateAvailable, true);
});

test('apply 成功写 pendingVersion（stateStore）', async () => {
  const writes = [];
  const stateStore = {
    read: () => ({}),
    recordApplied: (from, to) => writes.push([from, to]),
    clearPending: () => {},
  };
  const manager = fakeManager({ install: () => ({ application: 'restart-required' }) });
  const instance = updater({ manager, stateStore });
  await instance.check();
  await instance.apply();
  assert.deepEqual(writes, [['0.3.0', '0.4.0']]);
});

// ── createPnpmViewRunner ──────────────────────────────────────────────
const { createPnpmViewRunner } = await import('../dist/update.js');

function fakeExec(handler) {
  const calls = [];
  const impl = async (command, args, options) => {
    calls.push({ command, args, options });
    return handler({ command, args, options });
  };
  impl.calls = calls;
  return impl;
}

test('pnpmView runner：正常版本串透传', async () => {
  const exec = fakeExec(() => ({ code: 0, signal: null, stdout: '"1.2.3"\n', stderr: '', output: '', timedOut: false, aborted: false, durationMs: 1 }));
  const run = createPnpmViewRunner({ getProfile: () => PROFILE, exec, env: { PATH: '/bin' } });
  assert.equal(await run('@demo/plugin@latest'), '1.2.3');
  assert.deepEqual(exec.calls[0].args, ['view', '@demo/plugin@latest', 'version', '--json']);
  assert.equal(exec.calls[0].options.cwd, '/profiles/desktop');
});

test('pnpmView runner：无 profile.dir / 命令失败 / 非法版本 → null', async () => {
  const noDir = createPnpmViewRunner({ getProfile: () => ({ name: 'x' }), exec: fakeExec(() => ({ code: 0, stdout: '"1.0.0"' })) });
  assert.equal(await noDir('@demo/plugin@latest'), null);

  const failing = createPnpmViewRunner({ getProfile: () => PROFILE, exec: fakeExec(() => ({ code: 1, stdout: '' })) });
  assert.equal(await failing('@demo/plugin@latest'), null);

  const badVersion = createPnpmViewRunner({ getProfile: () => PROFILE, exec: fakeExec(() => ({ code: 0, stdout: '"not-a-version"' })) });
  assert.equal(await badVersion('@demo/plugin@latest'), null);

  const throwing = createPnpmViewRunner({ getProfile: () => { throw new Error('no ctx'); }, exec: fakeExec(() => ({ code: 0 })) });
  assert.equal(await throwing('@demo/plugin@latest'), null);
});

// ── 0.2.2+：宿主 listVersions / updateBundle ─────────────────────────

function fakeVersionManager(handlers = {}) {
  const calls = [];
  return {
    calls,
    ...(handlers.listVersions === undefined ? {} : {
      async listVersions(name) {
        calls.push(['listVersions', name]);
        return handlers.listVersions(name, calls);
      },
    }),
    ...(handlers.updateBundle === undefined ? {} : {
      async updateBundle(name, version, options) {
        calls.push(['updateBundle', name, version, options]);
        return handlers.updateBundle(name, version, options, calls);
      },
    }),
    ...(handlers.installBundle === undefined ? {} : { installBundle: handlers.installBundle }),
  };
}

function listed(versions, extra = {}) {
  return {
    status: 'listed',
    installed: '0.3.0',
    registry: 'https://registry.npmjs.org/',
    versions,
    omitted: 0,
    ...extra,
  };
}

test('listVersions：跳过 incompatible，选兼容稳定版；view.versions 保留原因', async () => {
  const manager = fakeVersionManager({
    listVersions: () => listed([
      { version: '0.5.0', tags: ['latest'], prerelease: false, incompatible: { requirements: { 'engines.dsh': '>=0.3.0' } } },
      { version: '0.4.0', tags: [], prerelease: false },
    ]),
    updateBundle: () => ({ step: 'install', result: { application: 'restart-required' } }),
  });
  const instance = updater({ manager });
  const view = await instance.check();
  assert.equal(view.latestVersion, '0.4.0', '最新版不兼容时退到次新兼容版');
  assert.equal(view.updateAvailable, true);
  assert.equal(view.checkFailed, false);
  assert.equal(view.versions.length, 2);
  assert.match(view.versions[0].incompatible, /engines\.dsh/);
  assert.equal(view.versions[1].incompatible, undefined);

  const result = await instance.apply();
  assert.equal(result.application, 'restart-required');
  assert.equal(result.updatedVersion, '0.4.0');
  assert.deepEqual(manager.calls.filter((call) => call[0] === 'updateBundle'), [
    ['updateBundle', '@demo/plugin', '0.4.0', undefined],
  ]);
});

test('listVersions：没有可更新版本 → 已是最新，不算查询失败', async () => {
  const manager = fakeVersionManager({ listVersions: () => listed([]) });
  const instance = updater({ manager, fetchImpl: async () => { throw new Error('should not be asked'); } });
  const view = await instance.check();
  assert.equal(view.latestVersion, '0.3.0');
  assert.equal(view.updateAvailable, false);
  assert.equal(view.checkFailed, false);
  assert.deepEqual(view.versions, []);
});

test('listVersions：refused / 抛错 → 回退 pnpm / registry', async () => {
  const refused = fakeVersionManager({ listVersions: () => ({ status: 'refused', problem: 'not-updatable', reason: 'link install' }) });
  const a = updater({ manager: refused });
  assert.equal((await a.check()).latestVersion, '0.4.0');

  const throwing = fakeVersionManager({ listVersions: () => { throw new Error('host down'); } });
  const b = updater({ manager: throwing });
  assert.equal((await b.check()).latestVersion, '0.4.0');
});

test('updateBundle：不支持平台 / 不兼容 / 恢复失败分别映射', async () => {
  const platform = fakeVersionManager({
    listVersions: () => listed([{ version: '0.4.0', tags: ['latest'], prerelease: false }]),
    updateBundle: () => ({ step: 'check', result: { error: { code: 'unsupported-platform', message: 'darwin only' } } }),
  });
  const a = updater({ manager: platform });
  await a.check();
  await assert.rejects(a.apply(), (error) => error.code === 'UNSUPPORTED_PLATFORM');

  const incompatible = fakeVersionManager({
    listVersions: () => listed([{ version: '0.4.0', tags: ['latest'], prerelease: false }]),
    updateBundle: () => ({ step: 'check', result: { error: { code: 'incompatible-version', message: 'needs newer dsh' } } }),
  });
  const b = updater({ manager: incompatible });
  await b.check();
  await assert.rejects(b.apply(), (error) => error.code === 'INCOMPATIBLE_VERSION');

  const rollback = fakeVersionManager({
    listVersions: () => listed([{ version: '0.4.0', tags: ['latest'], prerelease: false }]),
    updateBundle: () => ({
      step: 'install',
      result: { error: { code: 'operation-error', message: 'disk full' } },
      restore: { error: { code: 'operation-error', message: 'restore failed' } },
    }),
  });
  const c = updater({ manager: rollback });
  await c.check();
  await assert.rejects(c.apply(), (error) => error.code === 'ROLLBACK_FAILED');
});

test('updateBundle：apply({version}) 只能选列表里的兼容版本', async () => {
  const manager = fakeVersionManager({
    listVersions: () => listed([
      { version: '0.5.0', tags: ['latest'], prerelease: false },
      { version: '0.4.0', tags: [], prerelease: false },
    ]),
    updateBundle: (name, version) => ({ step: 'install', result: { application: 'applied', version } }),
  });
  const instance = updater({ manager });
  await instance.check();
  const result = await instance.apply({ version: '0.4.0' });
  assert.equal(result.updatedVersion, '0.4.0');
  assert.deepEqual(manager.calls.at(-1).slice(0, 3), ['updateBundle', '@demo/plugin', '0.4.0']);
  await assert.rejects(instance.apply({ version: '9.9.9' }), (error) => error.code === 'INVALID_VERSION');
});
