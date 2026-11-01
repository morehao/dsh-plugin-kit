/**
 * 子进程执行：argv 直传（不经 shell）、环境白名单、超时 / 取消、输出上限。
 *
 * 收敛此前 `@morehao/dsh-github-trending`（`core/exec.ts`）与 `@morehao/dsh-commands`
 * （`lib/proc.ts`）两份形状相近的实现，外加三仓都手写一遍的
 * 「`pnpm view <spec> version --json` 输出解析」（`collectVersionView`）。
 *
 * 设计取舍：
 * - **spawn 失败不 reject**：`ENOENT` 等同步/异步错误统一落到 `error` 字段、`code=null`，
 *   让调用方用「退出码 + error」判断，而不是混用两种失败范式（沿用 dsh-commands）。
 * - **超时/取消先 SIGTERM、宽限后 SIGKILL**：面向单进程短命令（不建 process group）。
 * - **输出有上限且保留尾部**：一个失控的子进程不能把整段输出塞进内存；尾部更接近排障要点。
 * - **本模块只做「拿版本字符串」**（`collectVersionView`），semver 合法性校验留在调用方，
 *   这样 `./exec` 不耦合 `./semver`，依赖更干净。
 */
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr 交错合并后的结果（同 dsh-commands 的 `output`）。 */
  output: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** spawn 本身失败（ENOENT / EACCES 等）时带出；此时 `code === null` 且不 reject。 */
  error?: Error;
}

/** 传给子进程的环境变量白名单：可执行、网络代理、证书、locale、git 身份。 */
const ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_GLOBAL',
  'GIT_SSH_COMMAND',
];

const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

/**
 * 从 `process.env` 里挑出白名单键 + 调用方额外给的键，拼成子进程环境。
 * 空字符串视为未设置（避免把 `KEY=` 传给子进程，部分工具会当成空值处理）。
 */
export function sanitizedEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...ENV_KEYS, ...PROXY_KEYS]) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  return env;
}

export interface ExecOptions {
  cwd?: string;
  /** 省略时继承 `process.env`；要清洗时先过 `sanitizedEnv` 再传进来。 */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 超时毫秒；默认 10_000。传 0 / Infinity / 非正数表示不设超时。 */
  timeoutMs?: number;
  /** SIGTERM 之后到 SIGKILL 的宽限；默认 2_000。 */
  abortGraceMs?: number;
  /** stdout 上限（保留尾部）；默认 1 MiB。 */
  maxStdout?: number;
  /** stderr 上限（保留尾部）；默认 1 MiB。 */
  maxStderr?: number;
  /** 合并 `output` 的上限（保留尾部）；默认 = maxStdout + maxStderr。 */
  maxOutput?: number;
  /** 写入子进程 stdin（写完即关闭）；省略则 stdin = 'ignore'。 */
  input?: string;
  /** 原始分片旁路（去 ANSI 由调用方决定）；回调抛错会被吞，不影响采集。 */
  onData?: (text: string, channel: 'stdout' | 'stderr') => void;
}

/** 保留文本尾部（超限时丢掉头部），用于有上限的缓冲。 */
function keepTail(text: string, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  return text.slice(text.length - limit);
}

/**
 * 执行一次命令并收集输出。永不 reject：进程级失败落到 `error` 字段。
 */
export async function spawnCollect(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const abortGraceMs = options.abortGraceMs ?? 2_000;
  const maxStdout = options.maxStdout ?? 1024 * 1024;
  const maxStderr = options.maxStderr ?? 1024 * 1024;
  const maxOutput = options.maxOutput ?? maxStdout + maxStderr;

  let stdout = '';
  let stderr = '';
  let output = '';
  let timedOut = false;

  return new Promise<ExecResult>((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve(failureResult(error, started, options.signal?.aborted === true));
      return;
    }

    if (options.input !== undefined) {
      child.stdin?.on('error', () => undefined); // 子进程提前退出时的 EPIPE 忽略
      child.stdin?.end(options.input);
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardKill: ReturnType<typeof setTimeout> | undefined;

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // 进程可能已退出
      }
    };
    const softKill = (): void => {
      killTree('SIGTERM');
      hardKill = setTimeout(() => killTree('SIGKILL'), abortGraceMs);
      hardKill.unref?.();
    };
    const onAbort = (): void => softKill();

    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (hardKill !== undefined) clearTimeout(hardKill);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        output,
        timedOut,
        aborted: options.signal?.aborted === true,
        durationMs: Date.now() - started,
        ...(error === undefined ? {} : { error }),
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = keepTail(stdout + chunk, maxStdout);
      output = keepTail(output + chunk, maxOutput);
      try {
        options.onData?.(chunk, 'stdout');
      } catch {
        /* 旁路观察者不影响采集 */
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = keepTail(stderr + chunk, maxStderr);
      output = keepTail(output + chunk, maxOutput);
      try {
        options.onData?.(chunk, 'stderr');
      } catch {
        /* 同上 */
      }
    });

    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        softKill();
      }, timeoutMs);
    }

    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signalName) => finish(code, signalName));
  });
}

function failureResult(error: unknown, started: number, aborted: boolean): ExecResult {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    output: err.message,
    timedOut: false,
    aborted,
    durationMs: Date.now() - started,
    error: err,
  };
}

/**
 * 从 `pnpm view <spec> version --json` 的 stdout 取版本字符串。
 * - 成功：可能返回单值或数组（多版本时 pnpm 给数组），取最后一个非空字符串；
 * - 空输出 / 非 JSON / 取不到字符串 → null。
 *
 * **不在这里做 semver 合法性校验**（避免 `./exec` 依赖 `./semver`），由调用方用 `parseSemver` 判定。
 */
export function collectVersionView(result: Pick<ExecResult, 'code' | 'stdout'>): string | null {
  if (result.code !== 0) return null;
  const text = result.stdout.trim();
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const value = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
