/**
 * semver 解析与比较（只做插件更新需要的部分）。
 *
 * 不引 semver 依赖：更新判定宁可不升级也不要误升，所以非法版本一律返回 undefined，
 * 由调用方按「不更新」处理。支持 `v1.2.3` / `1.2.3-beta.1` / `1.2.3+build`。
 */
export interface Semver {
  core: [number, number, number];
  prerelease: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value: unknown): Semver | undefined {
  const text = String(value ?? '').trim();
  const match = SEMVER.exec(text);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined;
  return { core: [major, minor, patch], prerelease: match[4] === undefined ? [] : match[4].split('.') };
}

/** semver 规则：有 prerelease 的版本低于同号稳定版；数字段按数值比，字母段按字典序。 */
function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const an = BigInt(a);
      const bn = BigInt(b);
      if (an !== bn) return an > bn ? 1 : -1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

/** `candidate` 是否严格新于 `current`；任一方不是合法 semver 都返回 false。 */
export function isNewerVersion(current: unknown, candidate: unknown): boolean {
  const a = parseSemver(current);
  const b = parseSemver(candidate);
  if (a === undefined || b === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = a.core[index] ?? 0;
    const right = b.core[index] ?? 0;
    if (right !== left) return right > left;
  }
  return comparePrerelease(b.prerelease, a.prerelease) > 0;
}

/** 比较两个版本：负数 / 0 / 正数；任一方非法返回 undefined。 */
export function compareVersions(left: unknown, right: unknown): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const an = a.core[index] ?? 0;
    const bn = b.core[index] ?? 0;
    if (an !== bn) return an > bn ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}
