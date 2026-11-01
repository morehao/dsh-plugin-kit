import { test } from 'node:test';
import assert from 'node:assert/strict';

const { spawnCollect, sanitizedEnv, collectVersionView } = await import('../dist/exec.js');

const NODE = process.execPath;

test('spawnCollect：正常命令 exit 0 并收集 stdout', async () => {
  const result = await spawnCollect(NODE, ['-e', 'process.stdout.write("hello")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.output, 'hello');
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(typeof result.durationMs, 'number');
});

test('spawnCollect：非 0 退出码如实返回', async () => {
  const result = await spawnCollect(NODE, ['-e', 'process.exit(3)']);
  assert.equal(result.code, 3);
});

test('spawnCollect：超时 → timedOut 且被终止', async () => {
  const result = await spawnCollect(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200, abortGraceMs: 200 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null);
});

test('spawnCollect：abort → aborted 且被终止', async () => {
  const controller = new AbortController();
  const promise = spawnCollect(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal, abortGraceMs: 200 });
  setTimeout(() => controller.abort(), 100);
  const result = await promise;
  assert.equal(result.aborted, true);
});

test('spawnCollect：输出上限保留尾部', async () => {
  const result = await spawnCollect(NODE, ['-e', 'process.stdout.write("a".repeat(1000) + "TAIL")'], { maxStdout: 10 });
  assert.equal(result.stdout.length, 10);
  assert.equal(result.stdout.endsWith('TAIL'), true);
});

test('spawnCollect：input 写入 stdin', async () => {
  const result = await spawnCollect(NODE, ['-e', 'process.stdin.on("data", d => process.stdout.write(d))'], { input: 'piped-in' });
  assert.equal(result.stdout, 'piped-in');
});

test('spawnCollect：ENOENT 不 reject，落到 error', async () => {
  const result = await spawnCollect('definitely-not-a-real-binary-xyz', []);
  assert.equal(result.code, null);
  assert.equal(result.error instanceof Error, true);
  assert.equal(result.error.code, 'ENOENT');
});

test('spawnCollect：onData 旁路回调收到分片', async () => {
  const seen = [];
  await spawnCollect(NODE, ['-e', 'process.stdout.write("x")'], { onData: (text) => seen.push(text) });
  assert.equal(seen.join(''), 'x');
});

test('sanitizedEnv：只保留白名单 + extra 覆盖，空值丢弃', () => {
  const env = sanitizedEnv(
    { PATH: '/bin', HOME: '/home/u', SECRET_TOKEN: 'leak', EMPTY: '' },
    { EXTRA: 'yes', ALSO_EMPTY: '' },
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.EMPTY, undefined);
  assert.equal(env.EXTRA, 'yes');
  assert.equal(env.ALSO_EMPTY, undefined);
});

test('collectVersionView：单值 / 数组取尾 / 非 JSON / 空 / 非 0', () => {
  assert.equal(collectVersionView({ code: 0, stdout: '"1.2.3"' }), '1.2.3');
  assert.equal(collectVersionView({ code: 0, stdout: '["1.0.0","2.0.0"]' }), '2.0.0');
  assert.equal(collectVersionView({ code: 0, stdout: 'not json' }), null);
  assert.equal(collectVersionView({ code: 0, stdout: '' }), null);
  assert.equal(collectVersionView({ code: 1, stdout: '"1.2.3"' }), null);
  assert.equal(collectVersionView({ code: 0, stdout: '{"a":1}' }), null);
});
