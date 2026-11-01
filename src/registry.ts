/**
 * npm registry 约定：把包名拼成 `/latest` 端点，并按宿主给出的 registry 优先级发请求。
 *
 * **registry 列表与排序都优先复用宿主原生能力**（`@deepseek-ai/dsh-plugin-manager/registry` 的
 * `registryPlan(requested, configured)`，与 `installBundle` / `inspect` 内部用的是同一份源码）。
 * 但本包坚持**零 `@deepseek-ai/*` 运行时依赖**（见 package.json / update.ts），所以不直接 import，
 * 而是让调用方把原生函数**注入**进来（见 `HostRegistryPlan` / `LatestDeps.registryPlan`）：
 *
 *   - 注入了 → 用宿主原生排序（含私有源「只问它自己、不回退公有源」的语义，与安装完全一致）；
 *   - 没注入 / 调用抛错 / 结果不可用 → 退回本模块内置的 `registryPlan` 兜底（见下）。
 *
 * 为什么查最新版不复用 `pluginManager.inspect()`：`inspect(spec)` 在 registry 分支里先判
 * 「该包是否已在 profile 依赖中」，命中即返回 `already-installed`，**根本不会去问 registry**。
 * 而插件自更新要查的恰恰是「我自己这个已装包有没有新版」，必然命中该拦截。所以查 latest
 * 只能另走 `pnpm view`（见 `latest.ts` 的 `runPnpmView`）或 registry `/latest`，`inspect` 不可替代。
 */
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 宿主 `pluginManager.registries()` 的返回形状（对齐 @deepseek-ai/dsh-plugin-manager）。
 *
 * 设计取舍：字段都按可选 + unknown 收。宿主版本差异或字段改名时，内置兜底 `registryPlan` 用
 * `normalizeRegistry` 逐个校验，非法项直接跳过并最终退到官方源，**绝不因形状不符而抛错**
 * （fail-open：宁可退化到官方源，也不让自更新检查因宿主形状变化而崩）。
 */
export interface RegistriesLike {
  /** pnpm 在 profile 内解析出的实际 registry（继承 .npmrc），非空时最优先。 */
  resolved?: unknown;
  /** 配置里显式的 registry（可能为 null，表示「pnpm 自身配置的源」）。 */
  registry?: unknown;
  /** 回退源；宿主默认含 npmmirror。 */
  fallbackRegistries?: unknown;
}

/**
 * 宿主原生 `registryPlan` 的注入形状，对齐 `@deepseek-ai/dsh-plugin-manager/registry`。
 *
 * 调用方（各插件）自己 `import { registryPlan } from '@deepseek-ai/dsh-plugin-manager/registry'`
 * 后注入本包，即可让「查最新版的 registry 顺序」与宿主安装使用**完全一致**的排序与私有源语义。
 *
 * 入参/返回：
 * - `requested`：首位要问的 registry；`undefined` 表示交给宿主按 configured 首项决定。
 * - `configured`：`registries()` 的返回值（resolved / registry / fallbackRegistries）。
 * - 返回：依次要问的 registry 数组，**元素可能为 `null`**（表示 pnpm 自身配置的源）；宿主实现
 *   在入参非法时会**抛错**，所以本包调用处已包 try/catch 兜底。
 */
export type HostRegistryPlan = (requested: string | undefined, configured: RegistriesLike) => Array<string | null>;

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

/**
 * 内置兜底：把 `registries()` 的结果收敛成「查 latest 时要依次试的 registry 顺序」：
 * `resolved → registry → fallback`，去重；全非法/缺失时退到官方 registry，**绝不抛**。
 *
 * 这是**注入不到宿主原生 `registryPlan` 时的简化兜底**，不是宿主安装计划的等价物：它不区分
 * 公有/私有源。因此若 `resolved` 是私有源而其上查不到本包（镜像未同步），兜底会继续去问
 * fallback / 官方源拿 latest；而宿主真正安装时可能只问私有源并失败。差异只影响「能否查到版本」，
 * 不影响实际安装走哪条路。想与宿主机安装完全对齐，请注入原生 `registryPlan`（见 `HostRegistryPlan`）。
 */
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

/** 把宿主原生 `registryPlan` 的返回（可能含 `null`）收敛成可请求的绝对 URL 列表。 */
function planFromHost(hostPlan: HostRegistryPlan, registries: unknown): string[] | null {
  if (registries === null || typeof registries !== 'object') return null;
  const ordered: string[] = [];
  const push = (value: unknown): void => {
    const normalized = normalizeRegistry(value);
    if (normalized !== null && !ordered.includes(normalized)) ordered.push(normalized);
  };
  let result: Array<string | null>;
  try {
    result = hostPlan(undefined, registries as RegistriesLike);
  } catch {
    return null; // 宿主实现对非法入参会抛：交回内置兜底
  }
  if (!Array.isArray(result)) return null;
  for (const entry of result) {
    // 宿主可能返回 null（意为「pnpm 自身配置的源」）：先试 resolved 解析成具体 URL，拿不到就跳过。
    if (entry === null) {
      push((registries as RegistriesLike).resolved);
      continue;
    }
    push(entry);
  }
  return ordered.length === 0 ? null : ordered;
}

/**
 * 解析「查 latest 时要依次试的 registry 顺序」：
 * **优先用宿主原生 `registryPlan`**（注入且成功时，排序/私有源语义与宿主机安装完全一致），
 * 否则退回内置 `registryPlan` 兜底（fail-open，保证查询永远有一条可走的路）。
 *
 * @param registries 宿主 `registries()` 的返回值（任意形状，内部按 unknown 校验）。
 * @param hostPlan  可选的宿主原生 `registryPlan`（由调用方从 dsh-plugin-manager/registry 注入）。
 */
export function resolveRegistryPlan(registries: unknown, hostPlan?: HostRegistryPlan): string[] {
  if (typeof hostPlan === 'function') {
    const fromHost = planFromHost(hostPlan, registries);
    if (fromHost !== null) return fromHost;
  }
  return registryPlan(registries);
}

/** 手动更新命令：`dsh plugin --profile <name> add <pkg>@latest`。 */
export function manualCommand(packageName: string, profileName?: string | null): string {
  const spec = `${packageName}@latest`;
  return typeof profileName === 'string' && profileName !== ''
    ? `dsh plugin --profile ${profileName} add ${spec}`
    : `dsh plugin add ${spec}`;
}
