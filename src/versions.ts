/**
 * 宿主 `pluginManager.listVersions` 的适配层（0.2.2+）。
 *
 * 为什么需要它：宿主从 0.2.2 起为**已安装的** bundle 提供 `listVersions(name)`，
 * 返回“比已装版本新”的版本列表，并逐版本给出 `engines.dsh` / DSH peers 的兼容性。
 * 这正是自更新需要的来源；旧宿主没有该方法时返回 null，调用方回退到
 * `pnpm view` / registry `/latest`（见 `latest.ts`）。
 *
 * 本模块只做「取数 + 形状校验 + 缓存」，不决定选哪个版本；选择策略在 `update.ts`。
 */
import type { Logger, PluginMeta } from './latest.js';
import { DEFAULT_CACHE_TTL_MS } from './registry.js';
import { parseSemver } from './semver.js';

/** 宿主列表里的一个版本。 */
export interface HostVersionOption {
  readonly version: string;
  readonly tags: readonly string[];
  readonly prerelease: boolean;
  readonly deprecated?: string;
  /** 宿主给出的不兼容说明；absent = 可安装。原样保留，不解释。 */
  readonly incompatible?: unknown;
}

/** 宿主 `listVersions` 的可用结果。 */
export type HostVersionListing =
  | {
    readonly status: 'listed';
    readonly installed: string;
    readonly registry: string;
    readonly versions: readonly HostVersionOption[];
    readonly omitted: number;
  }
  | {
    readonly status: 'refused';
    readonly problem: 'not-updatable' | 'not-found' | 'network' | 'unknown';
    readonly reason: string;
  };

/** 读版本列表的接口；`null` 表示宿主没有该能力或读取失败，调用方应回退。 */
export interface VersionLister {
  list(options?: { fresh?: boolean }): Promise<HostVersionListing | null>;
}

export interface VersionListerDeps {
  meta: PluginMeta;
  getPluginManager?: () => unknown;
  cacheTtlMs?: number;
  now?: () => number;
  logger?: Logger;
}

interface CacheEntry {
  listing: HostVersionListing;
  expiresAt: number;
}

const PROBLEMS = new Set(['not-updatable', 'not-found', 'network', 'unknown']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 校验并收敛一个版本项；非法项直接丢弃（由调用方决定是否整体回退）。 */
function toOption(value: unknown): HostVersionOption | undefined {
  if (!isRecord(value)) return undefined;
  const version = nonEmptyString(value.version);
  if (version === undefined || parseSemver(version) === undefined) return undefined;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const deprecated = nonEmptyString(value.deprecated);
  return {
    version,
    tags,
    prerelease: value.prerelease === true,
    ...(deprecated === undefined ? {} : { deprecated }),
    ...(value.incompatible === undefined || value.incompatible === null ? {} : { incompatible: value.incompatible }),
  };
}

function toListing(value: unknown): HostVersionListing | null {
  if (!isRecord(value)) return null;
  if (value.status === 'refused') {
    const problem = typeof value.problem === 'string' && PROBLEMS.has(value.problem) ? value.problem as 'not-updatable' | 'not-found' | 'network' | 'unknown' : 'unknown';
    return { status: 'refused', problem, reason: nonEmptyString(value.reason) ?? '' };
  }
  if (value.status !== 'listed') return null;
  const installed = nonEmptyString(value.installed);
  const registry = nonEmptyString(value.registry);
  if (installed === undefined || registry === undefined || !Array.isArray(value.versions)) return null;
  const versions = value.versions.map(toOption).filter((option): option is HostVersionOption => option !== undefined);
  const omitted = typeof value.omitted === 'number' && Number.isFinite(value.omitted) && value.omitted >= 0 ? value.omitted : 0;
  return { status: 'listed', installed, registry, versions, omitted };
}

export function createVersionLister(deps: VersionListerDeps): VersionLister {
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? (() => {});
  let cache: CacheEntry | null = null;

  function manager(): Record<string, unknown> | null {
    try {
      const value = deps.getPluginManager?.();
      return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function list(options: { fresh?: boolean } = {}): Promise<HostVersionListing | null> {
    if (options.fresh === true) cache = null;
    if (cache !== null && now() < cache.expiresAt) return cache.listing;

    const service = manager();
    if (service === null || typeof service.listVersions !== 'function') return null;
    try {
      const raw = await (service.listVersions as (name: string) => Promise<unknown>).call(service, deps.meta.name);
      const listing = toListing(raw);
      if (listing === null) {
        logger('plugin.update.versions.invalid', { name: deps.meta.name });
        return null;
      }
      logger('plugin.update.versions', {
        name: deps.meta.name,
        status: listing.status,
        ...(listing.status === 'listed' ? { count: listing.versions.length, omitted: listing.omitted } : { problem: listing.problem }),
      });
      // refused 可能随安装形态变化（例如 link → registry），不缓存；只缓存有效列表。
      if (listing.status === 'listed') cache = { listing, expiresAt: now() + cacheTtlMs };
      return listing;
    } catch (error) {
      logger('plugin.update.versions.failed', {
        name: deps.meta.name,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return { list };
}
