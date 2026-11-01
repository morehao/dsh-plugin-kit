/**
 * 原子整文件写：同目录临时文件 → fsync → rename → fsync(父目录)，杜绝「半个文件」。
 *
 * 为什么自建而不直接用宿主 `@deepseek-ai/dsh-atomic-write`：宿主只有 `fs/promises` 异步版，
 * 而插件的状态 / 锁是**同步热路径**（`StateStore.save` 被大量同步调用，无法 await）。本模块是
 * 「语义对齐宿主」的同步实现 + 一个同语义异步版，供三仓共用，替代此前各写各的 4+ 份。
 *
 * 语义（对齐 DSH）：
 * - 写前对临时文件 fsync，rename 后对父目录 fsync（POSIX；Windows 跳过目录 fsync）；
 * - Windows 上 rename 可能被占用进程短暂阻塞，做有界重试；
 * - 失败清理临时文件，不留下半成品；原文件在 rename 前不会被截断。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface WriteFileAtomicOptions {
  /** 目标权限位；省略时沿用已有文件权限，新文件用 `defaultMode`。 */
  mode?: number;
  /** 新文件默认权限位；已有文件仍沿用其原权限。默认 0o644。 */
  defaultMode?: number;
}

const WINDOWS_TRANSIENT_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 200, 200, 200, 200];

function resolveMode(file: string, options: WriteFileAtomicOptions): number {
  if (typeof options.mode === 'number') return options.mode;
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return options.defaultMode ?? 0o644;
  }
}

function tempPath(dir: string, base: string): string {
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetrySync(from: string, to: string): void {
  if (process.platform !== 'win32') {
    fs.renameSync(from, to);
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === undefined || !WINDOWS_TRANSIENT_RENAME.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt] as number);
    }
  }
}

function fsyncDirSync(dir: string): void {
  if (process.platform === 'win32') return; // Windows 不支持打开目录句柄
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* 个别平台不支持目录 fsync；rename 已完成，忽略 */
  }
}

/** 同步原子整文件替换（`mkdir → open('wx') → write → fsync → rename → fsync(dir)`）。 */
export function writeFileAtomicSync(file: string, content: string, options: WriteFileAtomicOptions = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const mode = resolveMode(file, options);
  const tmp = tempPath(dir, path.basename(file));
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameWithRetrySync(tmp, file);
    fsyncDirSync(dir);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** 异步原子整文件替换，语义与同步版一致（`fs/promises`）。 */
export async function writeFileAtomic(file: string, content: string, options: WriteFileAtomicOptions = {}): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const mode = resolveMode(file, options);
  const tmp = tempPath(dir, path.basename(file));
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, file);
    if (process.platform !== 'win32') {
      try {
        const dirFd = await fsp.open(dir, 'r');
        try {
          await dirFd.sync();
        } finally {
          await dirFd.close();
        }
      } catch {
        /* 忽略目录 fsync 失败 */
      }
    }
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}
