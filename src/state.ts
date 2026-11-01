/**
 * JSON 状态持久化 + DSH home 解析。
 *
 * 收敛三仓的 `<home>/<plugin>/*.json` 读写与 `$DSH_HOME` 解析（此前各写一遍，坏文件容错、
 * mkdir 权限、写回格式、是否原子各不相同）。设计取舍：
 *
 * - **读 fail-open、写抛错**（不对称）：读失败（缺失 / 坏 JSON / 非对象）返回 `fallback()`，
 *   插件启动提示之类不能因为状态文件坏了就报错；写失败（目录只读、磁盘满）**抛错**，因为写通常
 *   是一次事务的一部分，静默吞掉会掩盖数据丢失。需要「尽力而为」的调用方在调用处自行 try/catch。
 * - **序列化格式统一**：`JSON.stringify(value, null, 2) + "\n"`，与三仓现状一致。
 * - **home 解析只做 `$DSH_HOME → ~/.dsh`**：不把「插件目录名」编进来（各插件不同），也**不**统一
 *   `profileContext.home` 与 `$DSH_HOME` 的优先级（那属于插件侧既有逻辑，不在本模块越界）。
 * - **不做 watch / 不做跨进程锁**：`skills-console` 的 lock digest 防外部覆盖属其业务事务，留在仓内。
 */
import { mkdirSync, promises as fsp, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic, writeFileAtomicSync } from './fs.js';

/** `$DSH_HOME`（去空白、`path.resolve`）→ 缺省 `homedir()/.dsh`。与 dsh-core 及三仓既有实现一致。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim();
  return raw !== undefined && raw !== '' ? raw : join(homedir(), '.dsh');
}

export interface JsonStoreOptions<T> {
  /** 状态目录（绝对路径）。调用方用 `resolveDshHome` + 插件目录名拼。 */
  dir: string;
  /** 文件名，如 `'state.json'`。 */
  file: string;
  /** 读失败 / 缺失 / 非对象时返回的默认值（工厂函数，避免共享可变引用）。 */
  fallback: () => T;
  /** 写回时的文件权限位；默认 0o600（状态文件默认私有）。 */
  mode?: number;
  /** mkdir 的目录权限；默认 0o700。 */
  dirMode?: number;
  /** 测试注入：默认读真实文件。 */
  readFile?: (path: string) => Promise<string>;
  readFileSync?: (path: string) => string;
}

export interface JsonStore<T> {
  /** 状态文件的绝对路径。 */
  readonly path: string;
  /** 同步读：坏文件 / 缺失 / 非对象 → `fallback()`。永不抛。 */
  read(): T;
  /** 同步原子写（`writeFileAtomicSync`）。失败抛错。 */
  write(value: T): void;
  /** 异步读。 */
  readAsync(): Promise<T>;
  /** 异步原子写（`writeFileAtomic`）。失败抛错。 */
  writeAsync(value: T): Promise<void>;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 解析成对象才算数；数组 / 标量 / 坏 JSON 一律视为「没有」，交给 fallback。 */
function coerce<T>(text: string, fallback: () => T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fallback();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback();
  return parsed as T;
}

const defaultReadFileSync = (target: string): string => readFileSync(target, 'utf8');
const defaultReadFile = (target: string): Promise<string> => fsp.readFile(target, 'utf8');

export function createJsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const file = join(options.dir, options.file);
  const mode = options.mode ?? 0o600;
  const dirMode = options.dirMode ?? 0o700;
  const readFileSyncImpl = options.readFileSync ?? defaultReadFileSync;
  const readFileImpl = options.readFile ?? defaultReadFile;

  function read(): T {
    let text: string;
    try {
      text = readFileSyncImpl(file);
    } catch {
      return options.fallback();
    }
    return coerce(text, options.fallback);
  }

  async function readAsync(): Promise<T> {
    let text: string;
    try {
      text = await readFileImpl(file);
    } catch {
      return options.fallback();
    }
    return coerce(text, options.fallback);
  }

  function write(value: T): void {
    try {
      mkdirSync(options.dir, { recursive: true, mode: dirMode });
    } catch {
      /* 目录已存在或不可建：交给 writeFileAtomicSync 抛 */
    }
    writeFileAtomicSync(file, serialize(value), { mode });
  }

  async function writeAsync(value: T): Promise<void> {
    try {
      await fsp.mkdir(options.dir, { recursive: true, mode: dirMode });
    } catch {
      /* 交给 writeFileAtomic 抛 */
    }
    await writeFileAtomic(file, serialize(value), { mode });
  }

  return { path: file, read, write, readAsync, writeAsync };
}
