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
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.cacheTtlMs === undefined ? {} : { cacheTtlMs: overrides.cacheTtlMs }),
    logger: (event, detail) => logs.push([event, detail]),
    ...(overrides.meta === undefined ? {} : { meta: overrides.meta }),
    ...(overrides.getProfile === undefined ? {} : { getProfile: overrides.getProfile }),
    ...(overrides.getPluginManager === undefined ? {} : { getPluginManager: overrides.getPluginManager }),
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
