/**
 * 插件自更新的 host 引擎：查最新版 → 判定能否一键更新 → 经宿主 `pluginManager` 重装。
 *
 * 设计约束（三个 DSH 插件共用这份逻辑）：
 * - **零 `@deepseek-ai/*` 运行时依赖**：pluginManager / profileContext 都由调用方用
 *   `ctx.get(...)` 惰性取。本包定位就是 DSH 插件，宿主必然在；但 `installBundle` 是
 *   可选/远程能力，取不到只是「当前部署未暴露该能力」，退化成「只检查 + 手动命令」。
 * - **复用优先**：registry 顺序优先用调用方注入的宿主原生 `registryPlan`（与宿主安装完全一致，
 *   含私有源语义），未注入则内置兜底（见 `registry.ts` 的 `resolveRegistryPlan`）；查最新版走
 *   `pnpm view` / registry `/latest`（`inspect()` 对已装包返回 already-installed，不可替代）。
 * - **不自作主张升级**：只有 registry 明确给出合法且严格更新的版本才允许安装；
 *   `link:` / `file:` / `workspace:` 安装一律禁止一键更新（会把开发链接换成 npm 版）。
 * - **装不上要能回退**：宿主 `installBundle` 对已装包会返回 `already-installed`，按官方
 *   更新路径先 remove 再 install；remove 之后 install 失败则尝试装回原版本。
 * - **不重写宿主进程策略**：需要 `pnpm view` 时由调用方注入 `runPnpmView`（进程/环境
 *   白名单是各插件自己的事），本包只做 registry 兜底。为免三个插件各抄一遍「读 profile → 拼
 *   `pnpm view` → 解析 → 校验」，本模块导出 `createPnpmViewRunner` 供直接复用（内部走 `./exec`，
 *   环境清洗仍由调用方把握；也可注入 `exec` 替换进程策略）。
 * - 更新会把运行中的插件自己卸载，界面会一起消失：全过程落固定事件名，便于事后对账。
 */
import { type ExecOptions, type ExecResult, collectVersionView, sanitizedEnv, spawnCollect } from './exec.js';
import { createLatestResolver, type LatestResolver, type Logger, type PluginMeta } from './latest.js';
import type { InstallKind, ProfileLike } from './profile.js';
import { detectInstallKind, normalizeProfile } from './profile.js';
import { manualCommand, type HostRegistryPlan } from './registry.js';
import { isNewerVersion, parseSemver } from './semver.js';

export type { Logger, PluginMeta } from './latest.js';
export type { InstallKind, ProfileLike } from './profile.js';
export type { HostRegistryPlan } from './registry.js';

export type UpdateErrorCode =
  | 'NO_MANAGER'
  | 'LINKED_INSTALL'
  | 'NOT_CHECKED'
  | 'NO_UPDATE'
  | 'INVALID_VERSION'
  | 'APPLY_IN_PROGRESS'
  | 'INSTALL_FAILED'
  | 'REMOVE_FAILED'
  | 'ROLLBACK_FAILED'
  | 'UNSUPPORTED_RESULT';

export class PluginUpdateError extends Error {
  readonly code: UpdateErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: UpdateErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PluginUpdateError';
    this.code = code;
    this.detail = detail;
  }
}

export interface UpdateView {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** 查询失败（网络 / registry 都不可用），不等于「已是最新」。 */
  checkFailed: boolean;
  canApply: boolean;
  installKind: InstallKind;
  installSpec?: string;
  manualCommand: string;
  applying: boolean;
  checkedAt?: string;
}

export interface ApplyResult {
  application: 'applied' | 'restart-required' | 'overridden';
  restartRequired: boolean;
  updatedVersion: string;
  installKind: InstallKind;
  /** 实际走过的步骤，给界面/日志做进度展示。 */
  steps: string[];
}

export interface PluginManagerLike {
  installBundle?: (spec: string) => Promise<unknown>;
  removeBundle?: (name: string) => Promise<unknown>;
  registries?: () => unknown;
}

export interface UpdaterDeps {
  meta: PluginMeta;
  getPluginManager?: () => unknown;
  getProfile?: () => unknown;
  getProfileName?: () => string | null;
  fetchImpl?: typeof fetch;
  runPnpmView?: (spec: string) => Promise<string | null>;
  /** 可选：注入宿主原生 `registryPlan`（dsh-plugin-manager/registry），让查版本的 registry 顺序与安装一致。 */
  registryPlan?: HostRegistryPlan;
  readFile?: (path: string) => Promise<string>;
  logger?: Logger;
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
}

export interface Updater {
  check(options?: { fresh?: boolean }): Promise<UpdateView>;
  view(): UpdateView | null;
  latestVersion(options?: { fresh?: boolean }): Promise<string | null>;
  apply(options?: { version?: string }): Promise<ApplyResult>;
  isApplying(): boolean;
}

interface UnwrappedResult {
  application?: unknown;
  error?: { code?: unknown; message?: unknown; diagnostic?: unknown } | undefined;
}

/** 宿主 `installBundle` / `removeBundle` 的结果两种形态都接：本地 `{application,error?}`，远程可能再包一层 `{ok,value|error}`。 */
function unwrapResult(result: unknown): UnwrappedResult {
  if (result === null || typeof result !== 'object') return {};
  const value = result as Record<string, unknown>;
  if (typeof value.ok === 'boolean' && !('application' in value) && ('value' in value || 'error' in value)) {
    return value.ok ? unwrapResult(value.value) : { error: asError(value.error) };
  }
  const unwrapped: UnwrappedResult = {};
  if ('application' in value) unwrapped.application = value.application;
  if ('error' in value && value.error !== undefined && value.error !== null) unwrapped.error = asError(value.error);
  return unwrapped;
}

function asError(value: unknown): { code?: unknown; message?: unknown; diagnostic?: unknown } {
  if (value !== null && typeof value === 'object') return value as { code?: unknown; message?: unknown; diagnostic?: unknown };
  return { message: String(value ?? '') };
}

function failureMessage(error: UnwrappedResult['error']): string {
  if (error === undefined) return '';
  for (const key of ['diagnostic', 'message', 'code'] as const) {
    const value = error[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

const APPLICATIONS = new Set(['applied', 'restart-required', 'overridden']);

export function createPluginUpdater(deps: UpdaterDeps): Updater {
  const logger = deps.logger ?? (() => {});
  const now = deps.now ?? Date.now;
  const resolver: LatestResolver = createLatestResolver({
    meta: deps.meta,
    ...(deps.getPluginManager === undefined ? {} : { getPluginManager: deps.getPluginManager }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.runPnpmView === undefined ? {} : { runPnpmView: deps.runPnpmView }),
    ...(deps.registryPlan === undefined ? {} : { registryPlan: deps.registryPlan }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.cacheTtlMs === undefined ? {} : { cacheTtlMs: deps.cacheTtlMs }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    logger,
  });
  let lastView: UpdateView | null = null;
  let applying = false;

  function manager(): PluginManagerLike | null {
    try {
      const value = deps.getPluginManager?.();
      return value !== null && typeof value === 'object' ? (value as PluginManagerLike) : null;
    } catch {
      return null;
    }
  }

  function profile(): ProfileLike | null {
    try {
      return normalizeProfile(deps.getProfile?.());
    } catch {
      return null;
    }
  }

  function profileName(): string | null {
    try {
      const fromDep = deps.getProfileName?.();
      if (typeof fromDep === 'string' && fromDep !== '') return fromDep;
      return profile()?.name ?? null;
    } catch {
      return null;
    }
  }

  function canApplyWith(kind: InstallKind): boolean {
    const service = manager();
    if (service === null || typeof service.installBundle !== 'function') return false;
    return kind === 'registry' || kind === 'unknown';
  }

  async function check(options: { fresh?: boolean } = {}): Promise<UpdateView> {
    const install = await detectInstallKind({
      profile: profile(),
      packageName: deps.meta.name,
      ...(deps.readFile === undefined ? {} : { readFile: deps.readFile }),
    });
    const latest = await resolver.latest(options.fresh === true ? { fresh: true } : {});
    const view: UpdateView = {
      packageName: deps.meta.name,
      currentVersion: deps.meta.version,
      latestVersion: latest,
      updateAvailable: latest !== null && isNewerVersion(deps.meta.version, latest),
      checkFailed: latest === null,
      canApply: canApplyWith(install.kind),
      installKind: install.kind,
      ...(install.spec === undefined ? {} : { installSpec: install.spec }),
      manualCommand: manualCommand(deps.meta.name, profileName()),
      applying,
      checkedAt: new Date(now()).toISOString(),
    };
    lastView = view;
    logger('plugin.update.check', {
      current: view.currentVersion,
      latest: view.latestVersion,
      updateAvailable: view.updateAvailable,
      checkFailed: view.checkFailed,
      canApply: view.canApply,
      installKind: view.installKind,
    });
    return view;
  }

  async function apply(options: { version?: string } = {}): Promise<ApplyResult> {
    if (applying) throw new PluginUpdateError('APPLY_IN_PROGRESS', '已有一次更新在进行中');
    const view = lastView;
    if (view === null) {
      throw new PluginUpdateError('NOT_CHECKED', '还没有检查过更新，请先检查再更新');
    }
    if (view.checkFailed || view.latestVersion === null) {
      throw new PluginUpdateError('NOT_CHECKED', '还没有拿到可用的最新版本，请先检查更新', { checkFailed: view.checkFailed });
    }
    const target = view.latestVersion;
    if (options.version !== undefined && options.version !== target) {
      throw new PluginUpdateError('INVALID_VERSION', `只能更新到刚查到的 ${target}，不接受 ${options.version}`, {
        requested: options.version,
        target,
      });
    }
    if (!view.updateAvailable || !isNewerVersion(deps.meta.version, target)) {
      throw new PluginUpdateError('NO_UPDATE', `当前 v${deps.meta.version} 已是最新（registry: ${target}）`);
    }
    if (parseSemver(target) === undefined) {
      throw new PluginUpdateError('INVALID_VERSION', `registry 返回的版本不是合法 semver：${target}`);
    }
    const install = await detectInstallKind({
      profile: profile(),
      packageName: deps.meta.name,
      ...(deps.readFile === undefined ? {} : { readFile: deps.readFile }),
    });
    if (install.kind === 'link' || install.kind === 'file' || install.kind === 'workspace') {
      throw new PluginUpdateError(
        'LINKED_INSTALL',
        `当前是本地 ${install.kind} 安装（${install.spec ?? '未知 spec'}），不能用 registry 版本覆盖；请手动执行 ${view.manualCommand}`,
        { installKind: install.kind, spec: install.spec },
      );
    }
    const service = manager();
    if (service === null || typeof service.installBundle !== 'function') {
      // 注意：这不是「宿主缺失」——本包定位就是 DSH 插件，宿主必然在。
      // 而是「当前部署未向本插件暴露 installBundle 能力」（pluginManager 是可选/远程服务），
      // 或该服务尚未就绪。此时退回手动命令，界面照常可用。
      throw new PluginUpdateError('NO_MANAGER', '当前 profile 未提供一键安装能力（pluginManager.installBundle 不可用），请手动更新', {
        manualCommand: view.manualCommand,
      });
    }
    const installBundle = service.installBundle.bind(service);
    const removeBundle = typeof service.removeBundle === 'function' ? service.removeBundle.bind(service) : null;
    const spec = `${deps.meta.name}@${target}`;
    const steps: string[] = [];
    applying = true;
    lastView = { ...view, applying: true };
    logger('plugin.update.apply.start', { from: deps.meta.version, target, installKind: install.kind });
    try {
      steps.push(`install ${spec}`);
      let installed = unwrapResult(await installBundle(spec));
      let removed = false;
      if (installed.error?.code === 'already-installed' && removeBundle !== null) {
        steps.push(`remove ${deps.meta.name}`);
        const removal = unwrapResult(await removeBundle(deps.meta.name));
        if (removal.error !== undefined || removal.application === 'failed') {
          throw new PluginUpdateError('REMOVE_FAILED', `移除旧版本失败：${failureMessage(removal.error)}`, { steps });
        }
        removed = true;
        steps.push(`install ${spec}`);
        installed = unwrapResult(await installBundle(spec));
      }
      if (installed.error !== undefined) {
        const message = failureMessage(installed.error) || '安装新版本失败';
        if (removed) {
          steps.push(`rollback ${deps.meta.name}@${deps.meta.version}`);
          let rollback;
          try {
            rollback = unwrapResult(await installBundle(`${deps.meta.name}@${deps.meta.version}`));
          } catch (error) {
            throw new PluginUpdateError('ROLLBACK_FAILED', `更新失败且回滚失败：${message}`, {
              steps,
              cause: error instanceof Error ? error.message : String(error),
            });
          }
          if (rollback.error !== undefined) {
            throw new PluginUpdateError('ROLLBACK_FAILED', `更新失败且回滚失败：${message}`, {
              steps,
              rollback: failureMessage(rollback.error),
            });
          }
        }
        throw new PluginUpdateError('INSTALL_FAILED', `安装 v${target} 失败：${message}`, { steps });
      }
      const application = typeof installed.application === 'string' ? installed.application : 'unknown';
      if (!APPLICATIONS.has(application)) {
        throw new PluginUpdateError('UNSUPPORTED_RESULT', `更新未生效（application=${application}）`, { steps });
      }
      const result: ApplyResult = {
        application: application as ApplyResult['application'],
        restartRequired: application !== 'applied',
        updatedVersion: target,
        installKind: install.kind,
        steps,
      };
      logger('plugin.update.apply', { ...result });
      return result;
    } catch (error) {
      const normalized =
        error instanceof PluginUpdateError
          ? error
          : new PluginUpdateError('INSTALL_FAILED', error instanceof Error ? error.message : String(error), { steps });
      logger('plugin.update.apply.failed', { code: normalized.code, message: normalized.message, steps });
      throw normalized;
    } finally {
      applying = false;
      if (lastView !== null) lastView = { ...lastView, applying: false };
    }
  }

  return {
    check,
    view: () => lastView,
    latestVersion: (options: { fresh?: boolean } = {}) => resolver.latest(options),
    apply,
    isApplying: () => applying,
  };
}

export interface PnpmViewRunnerDeps {
  /** 取宿主 `profileContext`（提供 `dir` / `packageManager`）；可抛，内部会兜。 */
  getProfile: () => unknown;
  /**
   * 可注入的子进程执行器（默认 `./exec` 的 `spawnCollect`）。
   * 各插件若要沿用自己更细的进程策略（环境白名单 / 输出上限 / 作业面板旁路），注入即可。
   */
  exec?: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  /** 环境来源；默认 `process.env`，内部过 `sanitizedEnv` 清洗。 */
  env?: NodeJS.ProcessEnv;
  /** 单个查询超时毫秒；默认 8_000。 */
  timeoutMs?: number;
}

/**
 * 造一个 `runPnpmView`：用 profile 的包管理器在 profile 目录执行
 * `pnpm view <spec> version --json`，继承 `.npmrc` 的镜像 / 私源 / token。
 *
 * 返回 `(spec) => Promise<string | null>`，与 `UpdaterDeps.runPnpmView` 兼容：
 * 拿不到 profile.dir / 命令失败 / 输出非法 / 版本不是合法 semver → `null`（交由 registry 兜底）。
 * 三个插件此前各自手写这段，本工厂与它们的历史行为一致。
 */
export function createPnpmViewRunner(deps: PnpmViewRunnerDeps): (spec: string) => Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? 8_000;
  const run = deps.exec ?? spawnCollect;
  const env = sanitizedEnv(deps.env ?? process.env);
  return async (spec: string): Promise<string | null> => {
    let profile: ProfileLike | null;
    try {
      profile = normalizeProfile(deps.getProfile());
    } catch {
      return null;
    }
    if (profile === null || typeof profile.dir !== 'string' || profile.dir === '') return null;
    const command = profile.packageManager?.command ?? 'pnpm';
    const prefix = profile.packageManager?.args ?? [];
    let result: ExecResult;
    try {
      result = await run(command, [...prefix, 'view', spec, 'version', '--json'], {
        cwd: profile.dir,
        env,
        timeoutMs,
        maxStdout: 64 * 1024,
        maxStderr: 16 * 1024,
      });
    } catch {
      return null;
    }
    const version = collectVersionView(result);
    return version !== null && parseSemver(version) !== undefined ? version : null;
  };
}
