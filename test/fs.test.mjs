import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { writeFileAtomicSync, writeFileAtomic } = await import('../dist/fs.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kit-fs-'));
}

function leftoverTemps(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('writeFileAtomicSync：自动建多层目录并写入', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'a', 'b', 'c.json');
  writeFileAtomicSync(file, '{"ok":true}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
  assert.deepEqual(leftoverTemps(path.dirname(file)), []);
});

test('writeFileAtomicSync：覆盖已有文件并保留原 mode', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  writeFileAtomicSync(file, 'v1', { defaultMode: 0o600 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writeFileAtomicSync(file, 'v2');
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); // 沿用原 mode
});

test('writeFileAtomicSync：显式 mode 生效', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.txt');
  writeFileAtomicSync(file, 'x', { mode: 0o640 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test('writeFileAtomicSync：写入抛错时清理临时文件', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'locked.json');
  // 把目标目录设为只读，mkdir 已存在成功、open('wx') 会失败
  fs.writeFileSync(file, 'orig');
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => writeFileAtomicSync(file, 'new'));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  // 原文件未被截断
  assert.equal(fs.readFileSync(file, 'utf8'), 'orig');
  assert.deepEqual(leftoverTemps(dir), []);
});

test('writeFileAtomic：异步版与同步版产出一致', async () => {
  const dir = tmpDir();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  await writeFileAtomic(a, 'same-content', { mode: 0o600 });
  writeFileAtomicSync(b, 'same-content', { mode: 0o600 });
  assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'));
  assert.equal(fs.statSync(a).mode & 0o777, fs.statSync(b).mode & 0o777);
  assert.deepEqual(leftoverTemps(dir), []);
});
