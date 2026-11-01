import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createPluginMeta, readInstalledVersion } = await import('../dist/meta.js');

function fakeReader(obj) {
  return () => JSON.stringify(obj);
}

test('createPluginMeta：正常 package.json，repository 规范化为 https + repo 短名', () => {
  const meta = createPluginMeta({
    pkgUrl: 'file:///x/package.json',
    readFileSync: fakeReader({
      name: '@morehao/demo',
      version: '1.2.3',
      repository: { type: 'git', url: 'git+https://github.com/o/r.git' },
    }),
  });
  assert.equal(meta.name, '@morehao/demo');
  assert.equal(meta.version, '1.2.3');
  assert.equal(meta.repository, 'https://github.com/o/r');
  assert.equal(meta.repo, 'o/r');
});

test('createPluginMeta：repository 为字符串 / 缺失 / 非 GitHub', () => {
  const str = createPluginMeta({ pkgUrl: 'x', readFileSync: fakeReader({ name: 'n', version: '1.0.0', repository: 'git@github.com:a/b.git' }) });
  assert.equal(str.repository, 'https://github.com/a/b');
  assert.equal(str.repo, 'a/b');

  const none = createPluginMeta({ pkgUrl: 'x', readFileSync: fakeReader({ name: 'n', version: '1.0.0' }) });
  assert.equal(none.repository, undefined);
  assert.equal(none.repo, null);

  const gitlab = createPluginMeta({ pkgUrl: 'x', readFileSync: fakeReader({ name: 'n', version: '1.0.0', repository: 'https://gitlab.com/a/b' }) });
  assert.equal(gitlab.repository, undefined);
  assert.equal(gitlab.repo, null);
});

test('createPluginMeta：读失败 / 非法 JSON → defaultName + 0.0.0', () => {
  const thrown = createPluginMeta({
    pkgUrl: 'x',
    defaultName: '@fallback/name',
    readFileSync: () => {
      throw new Error('ENOENT');
    },
  });
  assert.deepEqual(thrown, { name: '@fallback/name', version: '0.0.0', repo: null });

  const bad = createPluginMeta({ pkgUrl: 'x', readFileSync: () => '{oops' });
  assert.deepEqual(bad, { name: '', version: '0.0.0', repo: null });
});

test('readInstalledVersion：每次重读，能读到更新后的新值', () => {
  let current = '1.0.0';
  const readFileSync = () => JSON.stringify({ name: 'n', version: current });
  assert.equal(readInstalledVersion({ pkgUrl: 'x', readFileSync }), '1.0.0');
  current = '2.0.0'; // 模拟更新后同一进程
  assert.equal(readInstalledVersion({ pkgUrl: 'x', readFileSync }), '2.0.0');
});

test('readInstalledVersion：读失败 / 无 version → 空串', () => {
  assert.equal(readInstalledVersion({ pkgUrl: 'x', readFileSync: () => { throw new Error('x'); } }), '');
  assert.equal(readInstalledVersion({ pkgUrl: 'x', readFileSync: () => JSON.stringify({ name: 'n' }) }), '');
});
