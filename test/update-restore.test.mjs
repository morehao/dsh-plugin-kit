import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createPendingStore, PENDING_TTL_MS } = await import('../dist/update-restore.js');

/** 最小 localStorage 存根：只实现 get/set/remove。 */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

test('write → read 往返，默认 keyPrefix', () => {
  const storage = fakeStorage();
  const store = createPendingStore({ storage, now: () => 1000 });
  store.write('0.3.1', '0.4.0');
  assert.ok(storage.map.has('dsh-plugin-update:update-pending'), '默认前缀写对 key');
  const got = store.read();
  assert.deepEqual(got, { from: '0.3.1', to: '0.4.0', at: 1000 });
});

test('自定义 keyPrefix（复用旧键，如 dsh-skills-console:）', () => {
  const storage = fakeStorage();
  const store = createPendingStore({ keyPrefix: 'dsh-skills-console:', storage, now: () => 5 });
  store.write('a', 'b');
  assert.ok(storage.map.has('dsh-skills-console:update-pending'));
  assert.equal(store.read().to, 'b');
});

test('过期（>ttl）→ null 并清理', () => {
  let clock = 0;
  const storage = fakeStorage();
  const store = createPendingStore({ storage, now: () => clock });
  store.write('0.3.1', '0.4.0');
  clock = PENDING_TTL_MS + 1;
  assert.equal(store.read(), null, '过期读不到');
  assert.equal(storage.map.has('dsh-plugin-update:update-pending'), false, '过期键被清理');
});

test('恰好未过期（=ttl 边界内）仍可读', () => {
  let clock = 0;
  const storage = fakeStorage();
  const store = createPendingStore({ storage, now: () => clock });
  store.write('1', '2');
  clock = PENDING_TTL_MS; // 4000 - 0 = ttl，不大于 ttl
  assert.ok(store.read(), 'ttl 边界内仍在');
});

test('损坏 JSON → null 并清理', () => {
  const storage = fakeStorage({ 'dsh-plugin-update:update-pending': '{not json' });
  const store = createPendingStore({ storage });
  assert.equal(store.read(), null);
  assert.equal(storage.map.has('dsh-plugin-update:update-pending'), false);
});

test('结构不符（缺 at / at 非数字）→ null 并清理', () => {
  const storage = fakeStorage({ 'dsh-plugin-update:update-pending': JSON.stringify({ from: 'a', to: 'b' }) });
  const store = createPendingStore({ storage });
  assert.equal(store.read(), null);
  assert.equal(storage.map.has('dsh-plugin-update:update-pending'), false);
});

test('明显未来时间戳（> now+60s）→ null 并清理', () => {
  const storage = fakeStorage();
  // 先以未来时钟写入 at=10_000_000，再用近零时钟读：at 远超 now+60s → 视为异常
  const future = createPendingStore({ storage, now: () => 10_000_000 });
  future.write('a', 'b');
  const store = createPendingStore({ storage, now: () => 1000 });
  assert.equal(store.read(), null);
  assert.equal(storage.map.has('dsh-plugin-update:update-pending'), false);
});

test('clear 清除记号', () => {
  const storage = fakeStorage();
  const store = createPendingStore({ storage, now: () => 1 });
  store.write('a', 'b');
  store.clear();
  assert.equal(store.read(), null);
  assert.equal(storage.map.has('dsh-plugin-update:update-pending'), false);
});

test('无 storage（无 window / 未注入）→ 全程 fail-open 不抛', () => {
  // 测试环境无全局 window.localStorage
  const store = createPendingStore();
  assert.doesNotThrow(() => store.write('a', 'b'));
  assert.equal(store.read(), null);
  assert.doesNotThrow(() => store.clear());
});

test('storage 抛错（隐私模式）→ fail-open', () => {
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const store = createPendingStore({ storage: throwing });
  assert.doesNotThrow(() => store.write('a', 'b'));
  assert.equal(store.read(), null);
  assert.doesNotThrow(() => store.clear());
});

test('from/to 非字符串 → 归一为空串', () => {
  const storage = fakeStorage();
  const store = createPendingStore({ storage, now: () => 1 });
  store.write(null, undefined);
  assert.deepEqual(store.read(), { from: '', to: '', at: 1 });
});
