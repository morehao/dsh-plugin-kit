import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createUpdateController } = await import('../dist/update-client.js');

const VIEW = {
  packageName: '@demo/plugin',
  currentVersion: '0.3.0',
  latestVersion: '0.4.0',
  updateAvailable: true,
  checkFailed: false,
  canApply: true,
  installKind: 'registry',
  manualCommand: 'dsh plugin --profile desktop add @demo/plugin@latest',
};

function request(overrides = {}) {
  const calls = [];
  return {
    calls,
    async check(options = {}) {
      calls.push(['check', options.fresh === true]);
      return overrides.check === undefined ? VIEW : overrides.check();
    },
    async apply() {
      calls.push(['apply']);
      return overrides.apply === undefined ? { application: 'restart-required', restartRequired: true, updatedVersion: '0.4.0' } : overrides.apply();
    },
  };
}

test('check：有更新 → available；无更新 → current', async () => {
  const controller = createUpdateController({ request: request() });
  await controller.check();
  assert.equal(controller.getState().status, 'available');
  assert.equal(controller.getState().view.latestVersion, '0.4.0');

  const fresh = createUpdateController({ request: request({ check: () => ({ ...VIEW, updateAvailable: false }) }) });
  await fresh.check({ fresh: true });
  assert.equal(fresh.getState().status, 'current');
  assert.deepEqual(fresh.getState().view.manualCommand, VIEW.manualCommand);
});

test('check 失败：保留 view 并标 CHECK_FAILED', async () => {
  const controller = createUpdateController({ request: request({ check: () => ({ ...VIEW, checkFailed: true, latestVersion: null, updateAvailable: false }) }) });
  await controller.check();
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(state.error.code, 'CHECK_FAILED');
  assert.equal(state.view.canApply, true);
});

test('网络异常收敛成 message', async () => {
  const controller = createUpdateController({
    request: request({ check: () => { throw Object.assign(new Error('offline'), { code: 'NETWORK' }); } }),
  });
  await controller.check();
  assert.deepEqual(controller.getState().error, { code: 'NETWORK', message: 'offline' });
});

test('apply：restart-required / applied / 失败', async () => {
  const restart = createUpdateController({ request: request() });
  await restart.check();
  await restart.apply();
  assert.equal(restart.getState().status, 'restart-required');

  const applied = createUpdateController({ request: request({ apply: () => ({ application: 'applied', restartRequired: false, updatedVersion: '0.4.0' }) }) });
  await applied.check();
  await applied.apply();
  assert.equal(applied.getState().status, 'applied');

  const failing = createUpdateController({
    request: request({ apply: () => { throw Object.assign(new Error('boom'), { code: 'INSTALL_FAILED' }); } }),
  });
  await failing.check();
  await failing.apply();
  assert.equal(failing.getState().status, 'failed');
  assert.deepEqual(failing.getState().error, { code: 'INSTALL_FAILED', message: 'boom' });
});

test('apply 前置：没有可用更新 / 不能自动更新', async () => {
  const idle = createUpdateController({ request: request() });
  await idle.apply();
  assert.equal(idle.getState().error.code, 'NO_UPDATE');

  const linked = createUpdateController({ request: request({ check: () => ({ ...VIEW, canApply: false, installKind: 'link' }) }) });
  await linked.check();
  await linked.apply();
  assert.equal(linked.getState().error.code, 'NO_APPLY');
  assert.match(linked.getState().error.message, /dsh plugin --profile desktop add/);
});

test('订阅、单飞与 reset', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const controller = createUpdateController({
    request: { check: async () => { await pending; return VIEW; }, apply: async () => ({ application: 'applied' }) },
  });
  const seen = [];
  const off = controller.subscribe((state) => seen.push(state.status));
  const first = controller.check();
  const second = controller.check();
  assert.equal(seen.at(-1), 'checking');
  release();
  await Promise.all([first, second]);
  assert.equal(seen.at(-1), 'available');
  assert.equal(seen.filter((status) => status === 'checking').length, 1);
  off();
  controller.reset();
  assert.equal(controller.getState().status, 'idle');
  assert.equal(seen.at(-1), 'available');
});
