import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeRepositoryUrl, repoSlug, createReleaseReader } = await import('../dist/github.js');

test('normalizeRepositoryUrl：git+/ssh/https 归一，非 GitHub/非法拒绝', () => {
  assert.equal(normalizeRepositoryUrl('git+https://github.com/o/r.git'), 'https://github.com/o/r');
  assert.equal(normalizeRepositoryUrl('git@github.com:o/r.git'), 'https://github.com/o/r');
  assert.equal(normalizeRepositoryUrl('https://github.com/o/r'), 'https://github.com/o/r');
  assert.equal(normalizeRepositoryUrl('https://github.com/o/r/'), 'https://github.com/o/r');
  assert.equal(normalizeRepositoryUrl('https://gitlab.com/o/r'), undefined);
  assert.equal(normalizeRepositoryUrl('git@gitlab.com:o/r.git'), undefined);
  assert.equal(normalizeRepositoryUrl(''), undefined);
  assert.equal(normalizeRepositoryUrl(null), undefined);
  assert.equal(normalizeRepositoryUrl('not a url'), undefined);
});

test('repoSlug：owner/repo 短名 / 从 URL 提取 / 非法 null', () => {
  assert.equal(repoSlug('o/r'), 'o/r');
  assert.equal(repoSlug('https://github.com/o/r'), 'o/r');
  assert.equal(repoSlug('git@github.com:o/r.git'), 'o/r');
  assert.equal(repoSlug('https://gitlab.com/o/r'), null);
  assert.equal(repoSlug(''), null);
  assert.equal(repoSlug(undefined), null);
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler({ url: String(url), options });
  };
  impl.calls = calls;
  return impl;
}

test('createReleaseReader：成功解析 body/htmlUrl/name', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      return { body: 'notes', html_url: 'https://x', name: 'v1.2.3' };
    },
  }));
  const reader = createReleaseReader({ repo: 'o/r', fetchImpl });
  const info = await reader.release('1.2.3');
  assert.deepEqual(info, { version: '1.2.3', body: 'notes', htmlUrl: 'https://x', name: 'v1.2.3' });
  assert.equal(fetchImpl.calls[0].url, 'https://api.github.com/repos/o/r/releases/tags/v1.2.3');
  assert.equal(fetchImpl.calls[0].options.headers.accept, 'application/vnd.github+json');
});

test('createReleaseReader：404 → null；非法版本不发请求', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 404, async json() { return {}; } }));
  const reader = createReleaseReader({ repo: 'o/r', fetchImpl });
  assert.equal(await reader.release('1.2.3'), null);
  assert.equal(fetchImpl.calls.length, 1);
  // 非法版本
  assert.equal(await reader.release('not-a-version'), null);
  assert.equal(fetchImpl.calls.length, 1); // 没有新增请求
});

test('createReleaseReader：网络抛错 → null（不抛）', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error('network down');
  });
  const reader = createReleaseReader({ repo: 'o/r', fetchImpl });
  assert.equal(await reader.release('1.2.3'), null);
});

test('createReleaseReader：成功缓存命中不重复请求；失败也短缓存', async () => {
  let n = 0;
  const fetchImpl = fakeFetch(() => {
    n += 1;
    return { ok: true, status: 200, async json() { return { body: 'b' }; } };
  });
  let clock = 1000;
  const reader = createReleaseReader({ repo: 'o/r', fetchImpl, ttlMs: 1000, now: () => clock });
  await reader.release('1.0.0');
  await reader.release('1.0.0');
  assert.equal(n, 1); // 第二次命中缓存
  clock = 3000; // 过期
  await reader.release('1.0.0');
  assert.equal(n, 2);

  // 失败短缓存
  let f = 0;
  const failFetch = fakeFetch(() => {
    f += 1;
    return { ok: false, status: 404, async json() { return {}; } };
  });
  let c2 = 1000;
  const reader2 = createReleaseReader({ repo: 'o/r', fetchImpl: failFetch, failureTtlMs: 500, now: () => c2 });
  await reader2.release('2.0.0');
  await reader2.release('2.0.0');
  assert.equal(f, 1); // 失败也缓存，第二次不再请求
});

test('createReleaseReader：repo 为空 → null 不发请求', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, async json() { return {}; } }));
  const reader = createReleaseReader({ repo: '  ', fetchImpl });
  assert.equal(await reader.release('1.0.0'), null);
  assert.equal(fetchImpl.calls.length, 0);
});
