import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { resolveDshHome, createJsonStore } = await import('../dist/state.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kit-state-'));
}

test('resolveDshHome：有/无 $DSH_HOME', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/home' }), '/custom/home');
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), path.join(os.homedir(), '.dsh'));
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
});

test('store.read：缺失 → fallback；坏 JSON → fallback；非对象 → fallback', () => {
  const dir = tmpDir();
  const store = createJsonStore({ dir, file: 'state.json', fallback: () => ({ n: 0 }) });
  assert.deepEqual(store.read(), { n: 0 });

  fs.writeFileSync(store.path, '{oops');
  assert.deepEqual(store.read(), { n: 0 });

  fs.writeFileSync(store.path, '[1,2,3]');
  assert.deepEqual(store.read(), { n: 0 });

  fs.writeFileSync(store.path, '"scalar"');
  assert.deepEqual(store.read(), { n: 0 });
});

test('store.write/read：往返一致，文件权限为 mode', () => {
  const dir = tmpDir();
  const store = createJsonStore({ dir, file: 'state.json', fallback: () => ({}), mode: 0o600 });
  store.write({ lastSeen: '1.2.3', ok: true });
  assert.deepEqual(store.read(), { lastSeen: '1.2.3', ok: true });
  assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
  // 写回格式：2 空格缩进 + 结尾换行
  assert.equal(fs.readFileSync(store.path, 'utf8'), `${JSON.stringify({ lastSeen: '1.2.3', ok: true }, null, 2)}\n`);
});

test('store：fallback 每次返回新对象（无共享引用）', () => {
  const store = createJsonStore({ dir: tmpDir(), file: 'x.json', fallback: () => ({ list: [] }) });
  const a = store.read();
  a.list.push(1);
  const b = store.read();
  assert.deepEqual(b.list, []);
});

test('store：异步读写往返一致', async () => {
  const dir = tmpDir();
  const store = createJsonStore({ dir, file: 'async.json', fallback: () => ({}) });
  await store.writeAsync({ v: 1 });
  assert.deepEqual(await store.readAsync(), { v: 1 });
  assert.deepEqual(store.read(), { v: 1 });
});

test('store：写失败抛错（只读目录）', () => {
  const dir = tmpDir();
  const sub = path.join(dir, 'ro');
  fs.mkdirSync(sub);
  const store = createJsonStore({ dir: sub, file: 's.json', fallback: () => ({}) });
  fs.chmodSync(sub, 0o500);
  try {
    assert.throws(() => store.write({ a: 1 }));
  } finally {
    fs.chmodSync(sub, 0o700);
  }
});
