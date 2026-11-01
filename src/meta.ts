/**
 * 插件自身身份：从自家 `package.json` 读 name / version / repository。
 *
 * 收敛三仓此前各写一遍的实现（`dsh-commands` 的 `PLUGIN_META` + `readInstalledVersion`、
 * `dsh-skills-console` 的 `PLUGIN_META`、`dsh-github-trending` 的 `readPluginInfo`）。
 *
 * 设计取舍：
 * - **`pkgUrl` 由调用方给**：各仓 package.json 相对层级不同（`../` vs `../../`），kit 不替它猜。
 * - **`readInstalledVersion` 每次重读、不缓存**：插件自更新后同一进程内要能读到新版本号，
 *   这是 `dsh-commands` 的既有语义，必须保留。
 * - **repository 规范化复用 `./github`**：`git+`/ssh 归一与 `owner/repo` 短名只有一处真源。
 * - 本模块只在 host 侧使用（含 `node:fs`），不被 `./update/client` 引用。
 */
import { readFileSync as fsReadFileSync } from 'node:fs';

import { normalizeRepositoryUrl, repoSlug } from './github.js';

export interface PluginMetaInfo {
  name: string;
  version: string;
  /** 规范化后的 `https://github.com/owner/repo`；解析不了则缺省。 */
  repository?: string;
  /** `owner/repo` 短名；解析不了为 null。 */
  repo: string | null;
}

export interface ReadFileSyncLike {
  (path: string | URL): string;
}

function defaultReadFileSync(path: string | URL): string {
  return fsReadFileSync(path as string, 'utf8');
}

export interface CreatePluginMetaOptions {
  /** `new URL('../package.json', import.meta.url)` 这类导入地址。 */
  pkgUrl: URL | string;
  defaultName?: string;
  /** 注入读文件（测试/奇特环境）；默认 `node:fs` readFileSync。 */
  readFileSync?: ReadFileSyncLike;
}

/** 读一次 package.json，产出插件身份；读失败用 defaultName + `0.0.0` 兜底。 */
export function createPluginMeta(options: CreatePluginMetaOptions): PluginMetaInfo {
  const readFileSync = options.readFileSync ?? defaultReadFileSync;
  const fallbackName = options.defaultName ?? '';
  try {
    const parsed: unknown = JSON.parse(readFileSync(options.pkgUrl));
    if (parsed === null || typeof parsed !== 'object') {
      return { name: fallbackName, version: '0.0.0', repo: null };
    }
    const pkg = parsed as { name?: unknown; version?: unknown; repository?: unknown };
    const rawRepo =
      typeof pkg.repository === 'string'
        ? pkg.repository
        : pkg.repository !== null && typeof pkg.repository === 'object'
          ? (pkg.repository as { url?: unknown }).url
          : undefined;
    const repository = normalizeRepositoryUrl(rawRepo);
    const repo = repoSlug(repository);
    return {
      name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : fallbackName,
      version: typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0',
      ...(repository === undefined ? {} : { repository }),
      repo,
    };
  } catch {
    return { name: fallbackName, version: '0.0.0', repo: null };
  }
}

export interface ReadInstalledVersionOptions {
  pkgUrl: URL | string;
  readFileSync?: ReadFileSyncLike;
}

/** 每次重读 package.json 的 version（更新插件后同进程能读到新值）；失败 → ''。 */
export function readInstalledVersion(options: ReadInstalledVersionOptions): string {
  const readFileSync = options.readFileSync ?? defaultReadFileSync;
  try {
    const parsed: unknown = JSON.parse(readFileSync(options.pkgUrl));
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string') return version.trim();
    }
    return '';
  } catch {
    return '';
  }
}
