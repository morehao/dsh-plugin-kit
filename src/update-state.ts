/**
 * 插件自更新的**持久化收敛状态**（host 侧，落 `<home>/<plugin>/state.json`）。
 *
 * 为什么需要它（终局模型的关键一块）：
 * - `update.ts` 的 `UpdateView` 已经改成「磁盘版本落后才提示更新」（`updateAvailable` 基于
 *   `installedVersion`）。这解决了「更新完不重启仍谎报有新版本」。
 * - 但还剩一个跨进程的展示问题：更新会把插件自己卸载、面板消失，新进程重开时**磁盘已是新版**，
 *   单看磁盘版本会显示「已是最新」，用户就不知道「其实刚更新、需重启才真正生效」。
 * - 所以这里记 `pendingVersion`：apply 成功后写入；新进程启动时若 `installedVersion === pendingVersion`
 *   且 `runtimeVersion !== pendingVersion`（说明进程加载的还是旧代码），即为「已装新版、待重启」。
 *
 * 实现刻意下沉了 `dsh-commands` 里已验证的那套防回退逻辑（`tool-plugin-update.ts` 中
 * 「prevLastSeen 不回退」）：removeBundle/installBundle 会先触发插件重载，新版代码可能已把
 * `lastSeenVersion` 推进到目标版本；若之后写回旧版本就会回退，让下一次加载再次判定「有新版本」
 * 并重复提示。本模块把这条规则固化进 `recordApplied`。
 *
 * 边界：读 fail-open（坏文件/缺失 → 空状态），写尽力而为（失败不抛，只是下次少一条提示）。
 */
import { createJsonStore, type JsonStore } from './state.js';
import { isNewerVersion } from './semver.js';

/** `state.json` 的结构。字段都可缺省（老文件、手改、坏 JSON 都容错）。 */
export interface UpdateState {
  /** 已向用户宣告过的最高版本（防重复「有新版本」提示）。 */
  lastSeenVersion?: string;
  /** 已安装待重启宣告的目标版本；重启确认后清空。 */
  pendingVersion?: string;
}

export interface UpdateStateStoreOptions {
  /** 状态目录（绝对路径）。调用方用 `resolveDshHome` + 插件目录名拼。 */
  dir: string;
  /** 文件名，默认 `state.json`。 */
  file?: string;
  /** 测试注入。 */
  readFile?: (path: string) => Promise<string>;
  readFileSync?: (path: string) => string;
}

export interface UpdateStateStore {
  readonly path: string;
  /** 读当前状态（永不抛）。 */
  read(): UpdateState;
  /**
   * 记录一次成功 apply：写入 `pendingVersion`，并按「不回退」规则维护 `lastSeenVersion`。
   * 写失败不抛（尽カ而为）。
   */
  recordApplied(fromVersion: string, toVersion: string): void;
  /** 清空 pending（用户确认 / 已重启生效）。 */
  clearPending(): void;
}

export function createUpdateStateStore(options: UpdateStateStoreOptions): UpdateStateStore {
  const store: JsonStore<UpdateState> = createJsonStore<UpdateState>({
    dir: options.dir,
    file: options.file ?? 'state.json',
    fallback: () => ({}),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    ...(options.readFileSync === undefined ? {} : { readFileSync: options.readFileSync }),
  });

  function read(): UpdateState {
    return store.read();
  }

  function writeSafe(value: UpdateState): void {
    try {
      store.write(value);
    } catch {
      /* 状态目录只读 / 磁盘满：不阻塞更新主流程，最多少一条重启提示。 */
    }
  }

  function recordApplied(fromVersion: string, toVersion: string): void {
    const prev = read();
    const prevLastSeen = typeof prev.lastSeenVersion === 'string' ? prev.lastSeenVersion : null;
    // 防回退：若新版本代码已先行把 lastSeen 推进到更新的版本，不要再写回旧值。
    const lastSeenVersion =
      prevLastSeen !== null && isNewerVersion(fromVersion, prevLastSeen) ? prevLastSeen : fromVersion;
    writeSafe({ ...prev, lastSeenVersion, pendingVersion: toVersion });
  }

  function clearPending(): void {
    const prev = read();
    if (prev.pendingVersion === undefined) return;
    const { pendingVersion: _drop, ...rest } = prev;
    writeSafe(rest);
  }

  return { path: store.path, read, recordApplied, clearPending };
}
