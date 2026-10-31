/**
 * npm registry 约定：把包名拼成 `/latest` 端点，并按宿主给出的 registry 优先级发请求。
 *
 * 宿主 `pluginManager.registries()` 会把 profile 的镜像 / 私源 / token 计划交出来；
 * 拿不到就退回官方 registry。这里只做纯函数（不含网络），网络在 `latest.ts`。
 */
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** 宿主 registry 计划的形状（字段都当可选处理，宿主版本差异不该让我们崩）。 */
export interface RegistriesLike {
  resolved?: unknown;
  registry?: unknown;
  fallbackRegistries?: unknown;
}

/** npm 包名转 registry 路径：`@scope/name` → `@scope%2Fname`（保留 @，斜杠编码）。 */
export function encodePackageName(name: string): string {
  const text = name.trim();
  if (text.startsWith('@')) {
    const slash = text.indexOf('/');
    if (slash < 0) return `@${encodeURIComponent(text.slice(1))}`;
    return `@${encodeURIComponent(text.slice(1, slash))}%2F${encodeURIComponent(text.slice(slash + 1))}`;
  }
  return encodeURIComponent(text);
}

/** registry 归一成 `https://host/` 形式；非法（非 http(s) / 解析失败）返回 null。 */
export function normalizeRegistry(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(`${text}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** 由宿主的 registries() 结果拼出要问的 registry 顺序：resolved → registry → fallback，去重。 */
export function registryPlan(registries: unknown): string[] {
  const ordered: string[] = [];
  const push = (value: unknown): void => {
    const normalized = normalizeRegistry(value);
    if (normalized !== null && !ordered.includes(normalized)) ordered.push(normalized);
  };
  if (registries !== null && typeof registries === 'object') {
    const plan = registries as RegistriesLike;
    push(plan.resolved);
    push(plan.registry);
    const fallback = plan.fallbackRegistries;
    if (Array.isArray(fallback)) for (const item of fallback) push(item);
  }
  if (ordered.length === 0) ordered.push(OFFICIAL_REGISTRY);
  return ordered;
}

/** 手动更新命令：`dsh plugin --profile <name> add <pkg>@latest`。 */
export function manualCommand(packageName: string, profileName?: string | null): string {
  const spec = `${packageName}@latest`;
  return typeof profileName === 'string' && profileName !== ''
    ? `dsh plugin --profile ${profileName} add ${spec}`
    : `dsh plugin add ${spec}`;
}
