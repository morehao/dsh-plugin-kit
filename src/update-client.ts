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
