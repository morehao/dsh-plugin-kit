import { test } from 'node:test';
import assert from 'node:assert/strict';

const semver = await import('../dist/index.js');

test('semver：合法/非法版本', () => {
  assert.equal(semver.parseSemver('v1.2.3')?.core.join('.'), '1.2.3');
  assert.deepEqual(semver.parseSemver('1.2.3-beta.1')?.prerelease, ['beta', '1']);
  assert.equal(semver.parseSemver('1.2'), undefined);
  assert.equal(semver.parseSemver('abc'), undefined);
  assert.equal(semver.parseSemver('1.2.3.4'), undefined);
  assert.equal(semver.parseSemver(''), undefined);
});

test('semver：严格新于才返回 true', () => {
  assert.equal(semver.isNewerVersion('0.3.0', '0.3.1'), true);
  assert.equal(semver.isNewerVersion('0.3.0', '0.3.0'), false);
  assert.equal(semver.isNewerVersion('0.3.1', '0.3.0'), false);
  assert.equal(semver.isNewerVersion('1.0.0', '1.0.0-rc.1'), false);
  assert.equal(semver.isNewerVersion('1.0.0-rc.1', '1.0.0'), true);
  assert.equal(semver.isNewerVersion('1.0.0-rc.1', '1.0.0-rc.2'), true);
  assert.equal(semver.isNewerVersion('1.0.0', 'NaN'), false);
  assert.equal(semver.compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(semver.compareVersions('x', '1.0.0'), undefined);
});

test('registry：路径编码、归一化与优先级', () => {
  assert.equal(semver.encodePackageName('@morehao/dsh-github-trending'), '@morehao%2Fdsh-github-trending');
  assert.equal(semver.encodePackageName('plain'), 'plain');
  assert.equal(semver.normalizeRegistry('https://registry.npmjs.org'), 'https://registry.npmjs.org/');
  assert.equal(semver.normalizeRegistry('ftp://x'), null);
  assert.equal(semver.normalizeRegistry(''), null);
  assert.deepEqual(
    semver.registryPlan({ resolved: 'https://a/', registry: 'https://b/', fallbackRegistries: ['https://a/', 'https://c'] }),
    ['https://a/', 'https://b/', 'https://c/'],
  );
  assert.deepEqual(semver.registryPlan(null), ['https://registry.npmjs.org/']);
  // 宿主 registries() 形状异常 / 全非法时 fail-open 到官方源，绝不抛。
  assert.deepEqual(semver.registryPlan({ resolved: null, registry: 'not a url', fallbackRegistries: ['ftp://x'] }), [
    'https://registry.npmjs.org/',
  ]);
  assert.deepEqual(semver.registryPlan({ resolved: 'https://only-resolved/' }), ['https://only-resolved/']);
  // 内置兜底 registryPlan（未注入宿主原生时的降级路径）不区分公有/私有源：resolved 是私有源时
  // 仍会继续去问 fallback 拿 latest（宽松探测）；宿主真正安装时对私有源只问它自己、不回退公有源。
  // 想与安装完全对齐应注入宿主原生 registryPlan，见 resolveRegistryPlan 的用例。
  assert.deepEqual(
    semver.registryPlan({ resolved: 'https://private.corp/', registry: 'https://b/', fallbackRegistries: ['https://c'] }),
    ['https://private.corp/', 'https://b/', 'https://c/'],
  );
  assert.equal(semver.manualCommand('@morehao/x', 'desktop'), 'dsh plugin --profile desktop add @morehao/x@latest');
  assert.equal(semver.manualCommand('@morehao/x'), 'dsh plugin add @morehao/x@latest');
});

test('resolveRegistryPlan：优先宿主原生，异常/异常形状回落内置兜底', () => {
  const reg = { resolved: 'https://resolved/', registry: 'https://cfg/', fallbackRegistries: ['https://fb/'] };
  // 注入主机原生：以它的返回为准（记下入参，确认 requested 传 undefined、configured 原样透传）
  let seen;
  const host = (requested, configured) => {
    seen = { requested, configured };
    return ['https://native-a/', 'https://native-b/'];
  };
  assert.deepEqual(semver.resolveRegistryPlan(reg, host), ['https://native-a/', 'https://native-b/']);
  assert.equal(seen.requested, undefined);
  assert.equal(seen.configured, reg);
  // 宿主返回含 null（意为「pnpm 自身配置的源」）→ 用 resolved 补成具体 URL
  assert.deepEqual(semver.resolveRegistryPlan(reg, () => [null, 'https://native-b/']), [
    'https://resolved/',
    'https://native-b/',
  ]);
  // 宿主对非法入参抛错 → 回落内置兜底，绝不外抛
  assert.deepEqual(
    semver.resolveRegistryPlan(reg, () => {
      throw new Error('bad registry');
    }),
    ['https://resolved/', 'https://cfg/', 'https://fb/'],
  );
  // 宿主返回非法形状 / 空数组 → 回落内置兜底
  assert.deepEqual(semver.resolveRegistryPlan(reg, () => null), ['https://resolved/', 'https://cfg/', 'https://fb/']);
  assert.deepEqual(semver.resolveRegistryPlan(reg, () => []), ['https://resolved/', 'https://cfg/', 'https://fb/']);
  // registries 为 null（拿不到）→ 直接内置兜底到官方
  assert.deepEqual(semver.resolveRegistryPlan(null, host), ['https://registry.npmjs.org/']);
  // 未注入 → 内置兜底
  assert.deepEqual(semver.resolveRegistryPlan(reg), ['https://resolved/', 'https://cfg/', 'https://fb/']);
});

test('profile：安装形态判定', () => {
  assert.equal(semver.classifyInstallSpec('link:../x'), 'link');
  assert.equal(semver.classifyInstallSpec('file:../x.tgz'), 'file');
  assert.equal(semver.classifyInstallSpec('workspace:*'), 'workspace');
  assert.equal(semver.classifyInstallSpec('^0.3.0'), 'registry');
  assert.equal(semver.classifyInstallSpec('npm:@scope/other@1.0.0'), 'registry');
  assert.equal(semver.classifyInstallSpec(undefined), 'unknown');
});
