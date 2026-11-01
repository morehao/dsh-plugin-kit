/**
 * semver 解析与比较（只做插件更新需要的部分）。
 *
 * 底层用主流实现 `semver`（npm 官方维护），不再自研版本解析 / 预发布比较，避免边界 bug。
 * 本模块只做两件事：
 *   - 保留本包既有的窄接口：`parseSemver` / `isNewerVersion` / `compareVersions`；
 *   - 把「非法版本」统一收敛成 `undefined` / `false`（更新判定宁可不升级也不要误升），
 *     而 `semver` 包对非法输入多数返回 `null` 或抛错，这里抹平成稳定契约。
 *
 * 支持 `v1.2.3` / `1.2.3-beta.1` / `1.2.3+build`（`semver` 本身接受前导 `v`）。
 */
import semver from 'semver';

/** 保留旧接口形状：核心三段 + 预发布标识（字符串数组）。 */
export interface Semver {
  core: [number, number, number];
  prerelease: string[];
}

/** 解析成 `Semver`；非法（含空串 / `1.2` / `1.2.3.4` / 非版本串）返回 undefined。 */
export function parseSemver(value: unknown): Semver | undefined {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  const parsed = semver.parse(text);
  if (parsed === null) return undefined;
  return {
    core: [parsed.major, parsed.minor, parsed.patch],
    // semver 会把纯数字预发布段解析为 number，这里统一转回字符串以保持旧契约。
    prerelease: parsed.prerelease.map((part) => String(part)),
  };
}

/** `candidate` 是否严格新于 `current`；任一方不是合法 semver 都返回 false。 */
export function isNewerVersion(current: unknown, candidate: unknown): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (a === undefined || b === undefined) return false;
  const left = String(current).trim();
  const right = String(candidate).trim();
  return semver.gt(right, left);
}

/** 比较两个版本：负数 / 0 / 正数；任一方非法返回 undefined。 */
export function compareVersions(left: unknown, right: unknown): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) return undefined;
  return semver.compare(String(left).trim(), String(right).trim());
}
