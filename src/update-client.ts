/**
 * 客户端侧 headless 控制器（不依赖 React、不 import node 内置模块）。
 *
 * 各插件的 UI 长得不一样，共享「状态机 + 单飞 + 错误收敛」就够了：
 * 插件用自己的 React / h() 订阅 `subscribe()`，按 `status` 渲染按钮与进度，
 * 文案与样式留在各插件里（错误码由插件翻译，不在这里塞 i18n）。
 *
 * 状态：idle → checking → available | current | failed
 *       available → applying → applied | restart-required | failed
 */
import type { ApplyResult, UpdateView } from './update.js';

export type UpdateClientStatus = 'idle' | 'checking' | 'available' | 'current' | 'failed' | 'applying' | 'applied' | 'restart-required';

/** 只保留界面要用的字段，便于测试与跨版本兼容。 */
export type UpdateClientView = Pick<
  UpdateView,
  'packageName' | 'currentVersion' | 'latestVersion' | 'updateAvailable' | 'checkFailed' | 'canApply' | 'installKind' | 'manualCommand'
> & { applying?: boolean; installSpec?: string };

export interface UpdateClientError {
  code?: string;
  message: string;
}

export interface UpdateClientState {
  status: UpdateClientStatus;
  view: UpdateClientView | null;
  error: UpdateClientError | null;
  /** 最近一次检查完成时间（ISO）；没检查过就是 undefined。 */
  checkedAt?: string;
}

export interface UpdateRequest {
  check(options: { fresh?: boolean; signal?: AbortSignal }): Promise<UpdateClientView>;
  apply(): Promise<Pick<ApplyResult, 'application' | 'updatedVersion'> & { restartRequired?: boolean }>;
}

export interface UpdateControllerOptions {
  request: UpdateRequest;
  onChange?: (state: UpdateClientState) => void;
  now?: () => number;
}

export interface UpdateController {
  getState(): UpdateClientState;
  subscribe(listener: (state: UpdateClientState) => void): () => void;
  check(options?: { fresh?: boolean }): Promise<void>;
  apply(): Promise<void>;
  reset(): void;
}

const IDLE: UpdateClientState = { status: 'idle', view: null, error: null };

/**
 * 视觉态：把控制器的 `status` + `view` 收敛成一组跨插件一致的「状态 → 视觉」判断。
 * 只描述“该显示成什么”（颜色/角标/旋转/徽标该不该出现/能否弹确认），
 * **不含**文案与样式——文案由插件按 `label.key` 用自己的 i18n 渲染，样式由插件的 CSS 决定。
 */
export type UpdateVisualState = 'latest' | 'available' | 'checking' | 'error' | 'ok-flash';

export interface UpdateUiState {
  /** 视觉态：latest=已最新；available=有新版本；checking=检查/更新中；error=失败；ok-flash=刚更新完待重启。 */
  visual: UpdateVisualState;
  /** 是否忙碌（检查中 / 更新中）——图标应旋转并禁用。 */
  busy: boolean;
  /** 是否已落定（更新完待重启 / 已应用）——图标转绿。 */
  settled: boolean;
  /** 有可自动更新的新版本（弹确认气泡的前提）。 */
  actionable: boolean;
  /** 是否显示「目标版本号」徽标（仅 available 且可自动更新、非忙碌、未落定时）。 */
  showBadge: boolean;
  /** 徽标要显示的版本号（无则 null）。 */
  badgeVersion: string | null;
  /** 一键更新是否可用（view.canApply）。 */
  canApply: boolean;
}

/**
 * 由控制器状态派生跨插件一致的视觉判断。纯函数、无副作用、无框架依赖。
 *
 * 典型用法：`const ui = deriveUpdateUiState(state)`，然后各插件用自己的 CSS 把
 * `ui.visual` 映射到 `data-state`，用 `ui.showBadge`/`ui.badgeVersion` 决定版本徽标。
 */
export function deriveUpdateUiState(state: UpdateClientState): UpdateUiState {
  const { status, view } = state;
  const busy = status === 'checking' || status === 'applying';
  const settled = status === 'restart-required' || status === 'applied';
  const updateAvailable = view !== null && view.updateAvailable;
  const canApply = view !== null && view.canApply;
  const latestVersion = view === null ? null : view.latestVersion ?? null;

  let visual: UpdateVisualState;
  if (busy) visual = 'checking';
  else if (settled) visual = 'ok-flash';
  else if (status === 'failed' || (view !== null && view.checkFailed)) visual = 'error';
  else if (updateAvailable) visual = 'available';
  else visual = 'latest';

  const actionable = updateAvailable && canApply && !busy && !settled;
  const showBadge = visual === 'available' && !busy && !settled && canApply && latestVersion !== null;

  return {
    visual,
    busy,
    settled,
    actionable,
    showBadge,
    badgeVersion: showBadge ? latestVersion : null,
    canApply,
  };
}

/**
 * 该显示哪一条「更新状态语义」（不含文案本身）。
 * 插件按 `key` 取自己的 i18n 字符串、按 `params` 插值（如 `{version}` / `{latest}`）。
 *
 * - `checking`   正在检查
 * - `applying`   正在更新到 v{version}
 * - `available`  有新版本 v{latest}
 * - `latest`     已是最新 v{version}
 * - `done`       已更新 · 重启生效（v{version}）
 * - `checkFailed` 检查失败（可重试）
 * - `failed`     更新失败
 */
export type UpdateStatusLabelKey =
  | 'checking'
  | 'applying'
  | 'available'
  | 'latest'
  | 'done'
  | 'checkFailed'
  | 'failed';

export interface UpdateStatusLabel {
  key: UpdateStatusLabelKey;
  params: Record<string, string>;
}

export function updateStatusLabel(state: UpdateClientState): UpdateStatusLabel {
  const { status, view } = state;
  const latest = view?.latestVersion ?? '';
  const current = view?.currentVersion ?? '';
  if (status === 'checking' || view === null || status === 'idle') {
    return { key: 'checking', params: {} };
  }
  if (status === 'applying') return { key: 'applying', params: { version: latest } };
  if (status === 'restart-required' || status === 'applied') return { key: 'done', params: { version: latest } };
  if (status === 'failed') {
    // CHECK_FAILED 是检查阶段失败（可重试）；其余（NO_UPDATE / NO_APPLY / apply 失败）算更新失败
    return state.error?.code === 'CHECK_FAILED' ? { key: 'checkFailed', params: {} } : { key: 'failed', params: {} };
  }
  if (view.checkFailed) return { key: 'checkFailed', params: {} };
  if (view.updateAvailable) return { key: 'available', params: { latest: latest } };
  return { key: 'latest', params: { version: current } };
}

function errorOf(error: unknown): UpdateClientError {
  if (error !== null && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown };
    const message = typeof value.message === 'string' && value.message !== '' ? value.message : '操作失败';
    return typeof value.code === 'string' ? { code: value.code, message } : { message };
  }
  return { message: String(error ?? '操作失败') };
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const now = options.now ?? Date.now;
  let state: UpdateClientState = { ...IDLE };
  const listeners = new Set<(state: UpdateClientState) => void>();
  let inFlight: 'check' | 'apply' | null = null;

  function emit(next: UpdateClientState): void {
    state = next;
    options.onChange?.(state);
    for (const listener of listeners) listener(state);
  }

  async function check(checkOptions: { fresh?: boolean } = {}): Promise<void> {
    if (inFlight !== null) return;
    inFlight = 'check';
    emit({ ...state, status: 'checking', error: null });
    try {
      const view = await options.request.check(checkOptions);
      const checkedAt = new Date(now()).toISOString();
      if (view.checkFailed) {
        emit({
          status: 'failed',
          view,
          error: { code: 'CHECK_FAILED', message: '检查更新失败：拿不到 registry 上的最新版本' },
          checkedAt,
        });
      } else {
        emit({ status: view.updateAvailable ? 'available' : 'current', view, error: null, checkedAt });
      }
    } catch (error) {
      emit({ ...state, status: 'failed', error: errorOf(error) });
    } finally {
      inFlight = null;
    }
  }

  async function apply(): Promise<void> {
    if (inFlight !== null) return;
    const view = state.view;
    if (view === null || !view.updateAvailable) {
      emit({ ...state, status: 'failed', error: { code: 'NO_UPDATE', message: '没有可更新的版本，请先检查更新' } });
      return;
    }
    if (!view.canApply) {
      emit({
        ...state,
        status: 'failed',
        error: { code: 'NO_APPLY', message: `当前环境不支持一键更新，请执行：${view.manualCommand}` },
      });
      return;
    }
    inFlight = 'apply';
    emit({ ...state, status: 'applying', error: null });
    try {
      const result = await options.request.apply();
      const restartRequired = result.restartRequired ?? result.application !== 'applied';
      emit({ ...state, status: restartRequired ? 'restart-required' : 'applied', error: null });
    } catch (error) {
      emit({ ...state, status: 'failed', error: errorOf(error) });
    } finally {
      inFlight = null;
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    apply,
    reset: () => emit({ ...IDLE }),
  };
}
