/**
 * 查 npm 上某个包的最新版本。
 *
 * 顺序（可配置）：
 *   1. 调用方注入的 `runPnpmView`（让插件用自己 profile 的包管理器查，继承 .npmrc 的
 *      镜像 / 私源 / token；宿主内裸 fetch 读不到这些配置）；
 *   2. 宿主 `pluginManager.registries()` 给出的 registry 计划，依次问 `<base><pkg>/latest`；
 *   3. 都没有就用官方 registry。
 *
 * 全部失败返回 null（不抛）：调用方用它标记 `checkFailed`，界面照常可用。
 */
import { DEFAULT_CACHE_TTL_MS, DEFAULT_TIMEOUT_MS, encodePackageName, registryPlan } from './registry.js';
import { parseSemver } from './semver.js';

export type Logger = (event: string, detail?: Record<string, unknown>) => void;

export interface PluginMeta {
  name: string;
  version: string;
  repository?: string;
}

export interface LatestDeps {
  meta: PluginMeta;
  getPluginManager?: () => unknown;
  fetchImpl?: typeof fetch;
  /** 可选：用 profile 的包管理器查 `pkg@latest`，返回版本号或 null。 */
  runPnpmView?: (spec: string) => Promise<string | null>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  logger?: Logger;
}

interface CacheEntry {
  version: string;
  expiresAt: number;
  source: string;
}

export interface LatestResolver {
  latest(options?: { fresh?: boolean }): Promise<string | null>;
  peek(): { version: string; expiresAt: number; source: string } | null;
}

export function createLatestResolver(deps: LatestDeps): LatestResolver {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? (() => {});
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let cache: CacheEntry | null = null;

  function manager(): Record<string, unknown> | null {
    try {
      const value = deps.getPluginManager?.();
      return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function readRegistries(): Promise<unknown> {
    const service = manager();
    if (service === null || typeof service.registries !== 'function') return null;
    try {
      return await (service.registries as () => unknown)();
    } catch {
      return null;
    }
  }

  function remember(version: string, source: string): string {
    cache = { version, expiresAt: now() + cacheTtlMs, source };
    return version;
  }

  async function viaPnpm(): Promise<string | null> {
    if (typeof deps.runPnpmView !== 'function') return null;
    try {
      const value = await deps.runPnpmView(`${deps.meta.name}@latest`);
      const version = typeof value === 'string' ? value.trim() : '';
      return parseSemver(version) === undefined ? null : version;
    } catch {
      return null;
    }
  }

  async function viaRegistries(): Promise<{ version: string; source: string } | null> {
    const plan = registryPlan(await readRegistries());
    for (const base of plan) {
      try {
        const response = await fetchImpl(`${base}${encodePackageName(deps.meta.name)}/latest`, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) continue;
        const value = (await response.json()) as { version?: unknown };
        const version = typeof value.version === 'string' ? value.version.trim() : '';
        if (parseSemver(version) !== undefined) return { version, source: base };
      } catch {
        // 这个 registry 不通 / 超时 / 响应非法：试下一个
      }
    }
    return null;
  }

  async function latest(options: { fresh?: boolean } = {}): Promise<string | null> {
    if (deps.meta.name.trim() === '') return null;
    if (options.fresh === true) cache = null;
    if (cache !== null && now() < cache.expiresAt) return cache.version;
    const pnpm = await viaPnpm();
    if (pnpm !== null) {
      logger('plugin.update.latest', { source: 'pnpm', version: pnpm });
      return remember(pnpm, 'pnpm');
    }
    const registry = await viaRegistries();
    if (registry !== null) {
      logger('plugin.update.latest', { source: registry.source, version: registry.version });
      return remember(registry.version, registry.source);
    }
    logger('plugin.update.latest.failed', { package: deps.meta.name });
    return null;
  }

  return { latest, peek: () => (cache === null ? null : { ...cache }) };
}
