import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createUpdateStateStore } = await import('../dist/update.js');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-update-state-'));
}

test('recordApplied：写 pendingVersion 与 lastSeenVersion，read 能读回', () => {
  const dir = tempDir();
  try {
    const store = createUpdateStateStore({ dir });
    assert.deepEqual(store.read(), {});
    store.recordApplied('0.3.0', '0.4.0');
    const state = store.read();
    assert.equal(state.pendingVersion, '0.4.0');
    assert.equal(state.lastSeenVersion, '0.3.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordApplied：防回退——已被新版本推进 lastSeen 时不写回旧值', () => {
  const dir = tempDir();
  try {
    // 模拟：新版代码先行把 lastSeen 推进到 0.5.0，随后旧流程用 from=0.3.0 记录。
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastSeenVersion: '0.5.0', pendingVersion: '0.5.0' }));
    const store = createUpdateStateStore({ dir });
    store.recordApplied('0.3.0', '0.4.0');
    const state = store.read();
    assert.equal(state.lastSeenVersion, '0.5.0'); // 不回退
    assert.equal(state.pendingVersion, '0.4.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearPending：清除 pendingVersion，保留 lastSeenVersion', () => {
  const dir = tempDir();
  try {
    const store = createUpdateStateStore({ dir });
    store.recordApplied('0.3.0', '0.4.0');
    store.clearPending();
    const state = store.read();
    assert.equal(state.pendingVersion, undefined);
    assert.equal(state.lastSeenVersion, '0.3.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('坏文件 / 缺失 → 读返回空状态，不抛', () => {
  const dir = tempDir();
  try {
    const store = createUpdateStateStore({ dir });
    assert.deepEqual(store.read(), {}); // 缺失
    writeFileSync(join(dir, 'state.json'), '{ not json');
    assert.deepEqual(store.read(), {}); // 坏 JSON
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写失败（目录不可写）不抛——尽力而为', () => {
  // 用文件占用目录名，制造 mkdir 失败
  const dir = tempDir();
  try {
    const store = createUpdateStateStore({ dir: join(dir, 'state.json', 'nested') });
    assert.doesNotThrow(() => store.recordApplied('0.1.0', '0.2.0'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
