/**
 * GitHub 通用小工具：仓库地址规范化 + Release 正文读取。
 *
 * 收敛三处此前各写一遍的逻辑：
 * - `normalizeRepositoryUrl`：`git+https://…` / `git@github.com:…` / 裸 `https://…` 统一成
 *   `https://github.com/owner/repo`（只放行 GitHub；解析失败 → undefined），替代
 *   `dsh-github-trending` 的 `plugin-info.ts` 与 `dsh-commands` / `dsh-skills-console` 的
 *   `PLUGIN_META` 里那三段 `github.com[/:]…` 正则。
 * - `createReleaseReader`：拉 `api.github.com/repos/<repo>/releases/tags/v<version>` 的正文，
 *   带 TTL 缓存（成功与失败都缓存，避免连点重复打网络），失败一律 `null`（不抛）。
 *
 * 设计边界：只依赖纯逻辑（`./semver`），**不 import 任何 node 内置**——这样 `./github` 在
 * 客户端侧引用也不会破坏纯净度（虽然当前只有 host 侧用）。
 */
import { parseSemver } from './semver.js';

const GITHUB_HOST = 'github.com';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * `git+https://github.com/o/r.git` / `git@github.com:o/r.git` / `https://github.com/o/r`
 * → `https://github.com/o/r`。非 GitHub / 解析失败 → undefined。
 */
export function normalizeRepositoryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url = value.trim();
  if (url === '') return undefined;
  url = url.replace(/^git\+/i, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(url);
  if (ssh !== null) url = `https://github.com/${ssh[1]}/${ssh[2]}`;
  url = url.replace(/\.git$/i, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return undefined;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (pathname === '') return undefined;
    return `https://github.com${pathname}`;
  } catch {
    return undefined;
  }
}

/** 从仓库地址（或 `owner/repo` 短名）取 `owner/repo`；拿不到返回 null。 */
export function repoSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  // 已经是 owner/repo 形态
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return text;
  const normalized = normalizeRepositoryUrl(text);
  if (normalized === undefined) return null;
  const pathname = normalized.slice(`https://github.com/`.length);
  return pathname === '' ? null : pathname;
}

export interface ReleaseInfo {
  version: string;
  body: string;
  htmlUrl: string | null;
  name: string | null;
}

export interface ReleaseReaderDeps {
  /** `owner/repo`。 */
  repo: string;
  fetchImpl?: typeof fetch;
  /** 成功缓存 TTL；默认 10 分钟。 */
  ttlMs?: number;
  /** 失败短缓存 TTL；默认 = ttlMs（与既有实现一致，失败也缓存 10 分钟）。 */
  failureTtlMs?: number;
  /** 单次请求超时；默认 8s。 */
  timeoutMs?: number;
  now?: () => number;
}

export interface ReleaseReader {
  /** 拉某版本 Release 正文；无 repo / 网络 / 404 / 超时 / 非法版本 → null（不抛）。 */
  release(version: string): Promise<ReleaseInfo | null>;
}

interface CacheEntry {
  value: ReleaseInfo | null;
  expiresAt: number;
}

export function createReleaseReader(deps: ReleaseReaderDeps): ReleaseReader {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const failureTtlMs = deps.failureTtlMs ?? ttlMs;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const repo = deps.repo.trim();
  const cache = new Map<string, CacheEntry>();

  async function release(version: string): Promise<ReleaseInfo | null> {
    const target = String(version ?? '').trim();
    if (repo === '' || parseSemver(target) === undefined) return null;
    const cached = cache.get(target);
    if (cached !== undefined && now() < cached.expiresAt) return cached.value;
    const tag = `v${target.replace(/^v/, '')}`;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
        headers: { accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value: ReleaseInfo | null = response.ok
        ? await response.json().then((raw: unknown) => {
            const release = (raw ?? {}) as Record<string, unknown>;
            return {
              version: target,
              body: typeof release.body === 'string' ? release.body : '',
              htmlUrl: typeof release.html_url === 'string' ? release.html_url : null,
              name: typeof release.name === 'string' ? release.name : null,
            };
          })
        : null;
      cache.set(target, { value, expiresAt: now() + ttlMs });
      return value;
    } catch {
      // 失败也短缓存：避免连点重复打网络；TTL 到期后自然重试。
      cache.set(target, { value: null, expiresAt: now() + failureTtlMs });
      return null;
    }
  }

  return { release };
}
