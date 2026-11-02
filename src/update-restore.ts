/**
 * 跨进程「刚点过更新」记号（pending store）——headless，不依赖 React、不 import node 内置模块。
 *
 * 为什么需要它：插件一键更新会**先把运行中的自己卸载**，面板随之消失；新进程重开时，
 * 需要一条不随面板消失的「更新已安装、请完全退出再打开」提示。把「我刚才点了更新」记在
 * 浏览器 localStorage，重开后的新进程读回来渲染恢复提示——这正是各插件唯一能承载这句
 * 提示的位置。本模块只负责**记号的读写与过期/损坏的清理**，提示条 UI 由各插件自己渲染
 * （与 `./update/client` 同一哲学：headless 能力进 kit，UI 留插件）。
 *
 * 边界（硬性）：
 * - 全程 fail-open：storage 不存在（SSR / 测试 vm）/ 隐私模式抛错 / JSON 损坏 →
 *   读写一律当「没有」处理，绝不影响插件正常挂载。
 * - 只做前端展示，不参与任何写判据，也不碰宿主权威状态。
 * - 按 `keyPrefix` 区分插件（各插件用各自包名的前缀，互不覆盖）。
 */
export interface PendingUpdate {
  /** 更新前版本（展示用）。 */
  from: string;
  /** 更新目标版本（展示用）。 */
  to: string;
  /** 写入时刻（毫秒时间戳），用于过期判定。 */
  at: number;
}

/** 恢复提示最多保留 24h：更久之前的记号多半是没重开就换了别的事，忽略掉免打扰。 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** localStorage 的最小结构化契约（不依赖 DOM lib，host / 客户端均可传）。 */
export interface PendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingStoreOptions {
  /**
   * key 前缀（按插件区分）。最终 key = `${keyPrefix}update-pending`。
   * 默认 `'dsh-plugin-update:'`。设成 `'dsh-skills-console:'` 等即可复用旧的 localStorage 键。
   */
  keyPrefix?: string;
  /** 存储实现；默认取 `window.localStorage`，拿不到/抛错则全程 fail-open。 */
  storage?: PendingStorage;
  /** 过期毫秒；默认 {@link PENDING_TTL_MS}。 */
  ttlMs?: number;
  /** 当前时刻注入（测试用）；默认 `Date.now`。 */
  now?: () => number;
}

export interface PendingStore {
  /** 写入「刚点了更新」的记号。 */
  write(from: string, to: string): void;
  /**
   * 读取记号。结构不符 / 过期 / 损坏 / 明显未来时间戳 → 返回 null 并清理该键。
   */
  read(): PendingUpdate | null;
  /** 清除记号（用户点「知道了」或已确认重开）。 */
  clear(): void;
}

const DEFAULT_KEY_PREFIX = 'dsh-plugin-update:';
const FUTURE_TOLERANCE_MS = 60 * 1000;

/** 拿到可用的 Storage；拿不到（无 window / 未注入 / 抛错）返回 null。 */
function resolveStorage(explicit: PendingStorage | undefined): PendingStorage | null {
  if (explicit !== undefined) {
    // 显式注入：探一次读写，抛错就当不可用
    try {
      const probeKey = '__dsh_pending_probe__';
      explicit.setItem(probeKey, '1');
      explicit.removeItem(probeKey);
      return explicit;
    } catch {
      return null;
    }
  }
  try {
    const w: any = typeof globalThis !== 'undefined' ? (globalThis as any) : undefined;
    const s = w?.localStorage;
    if (!s) return null;
    const probeKey = '__dsh_pending_probe__';
    s.setItem(probeKey, '1');
    s.removeItem(probeKey);
    return s as PendingStorage;
  } catch {
    return null;
  }
}

export function createPendingStore(options: PendingStoreOptions = {}): PendingStore {
  const keyPrefix = options.keyPrefix === undefined ? DEFAULT_KEY_PREFIX : options.keyPrefix;
  const key = `${keyPrefix}update-pending`;
  const ttlMs = options.ttlMs === undefined ? PENDING_TTL_MS : options.ttlMs;
  const now = options.now === undefined ? Date.now : options.now;
  // storage 惰性解析：每次调用都重新取，避免模块加载时无 window 就永久失效。
  const storage = () => resolveStorage(options.storage);

  function removeKey(): void {
    const s = storage();
    if (!s) return;
    try { s.removeItem(key); } catch { /* ignore */ }
  }

  function write(from: string, to: string): void {
    const s = storage();
    if (!s) return;
    const value: PendingUpdate = { from: String(from || ''), to: String(to || ''), at: now() };
    try {
      s.setItem(key, JSON.stringify(value));
    } catch {
      // 配额满 / 隐私模式：记不上就算了，不影响主流程
    }
  }

  function read(): PendingUpdate | null {
    const s = storage();
    if (!s) return null;
    let raw: string | null;
    try {
      raw = s.getItem(key);
    } catch {
      return null;
    }
    if (raw === null || raw === '') return null;
    let value: any;
    try {
      value = JSON.parse(raw);
    } catch {
      // 损坏就当没有，顺手清掉避免反复解析失败
      removeKey();
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const { from, to, at } = value as any;
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      removeKey();
      return null;
    }
    const current = now();
    // 过期（含明显未来的异常时间戳）：清掉，不展示
    if (current - at > ttlMs || at > current + FUTURE_TOLERANCE_MS) {
      removeKey();
      return null;
    }
    return { from: typeof from === 'string' ? from : '', to: typeof to === 'string' ? to : '', at };
  }

  function clear(): void {
    removeKey();
  }

  return { write, read, clear };
}
