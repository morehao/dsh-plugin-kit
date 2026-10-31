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
  assert.equal(semver.manualCommand('@morehao/x', 'desktop'), 'dsh plugin --profile desktop add @morehao/x@latest');
  assert.equal(semver.manualCommand('@morehao/x'), 'dsh plugin add @morehao/x@latest');
});

test('profile：安装形态判定', () => {
  assert.equal(semver.classifyInstallSpec('link:../x'), 'link');
  assert.equal(semver.classifyInstallSpec('file:../x.tgz'), 'file');
  assert.equal(semver.classifyInstallSpec('workspace:*'), 'workspace');
  assert.equal(semver.classifyInstallSpec('^0.3.0'), 'registry');
  assert.equal(semver.classifyInstallSpec('npm:@scope/other@1.0.0'), 'registry');
  assert.equal(semver.classifyInstallSpec(undefined), 'unknown');
});
