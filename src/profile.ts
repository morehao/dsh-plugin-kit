/**
 * profile 读取：判断本插件是以什么形态装进当前 profile。
 *
 * 一键更新最危险的场景是「开发用的本地链接」：profile 里写的是 `link:/path/to/repo`，
 * 一旦用 registry 重装，本地的 link 会被换成 npm 版，开发流就被悄悄改掉了。所以
 * 更新前先读 `<profile.dir>/package.json` 的依赖声明，link: / file: / workspace: 一律
 * 关闭一键更新，只给手动命令。
 */
export type InstallKind = 'registry' | 'link' | 'file' | 'workspace' | 'unknown';

export interface ProfileLike {
  name?: string;
  dir?: string;
  home?: string;
  packageManager?: { command?: string; args?: string[] };
}

export interface InstallKindResult {
  kind: InstallKind;
  /** profile package.json 里声明的原始 spec（读不到就是 undefined）。 */
  spec?: string;
  /** 说明来源，便于日志与界面提示。 */
  source?: string;
}

/** 把宿主 `profileContext`（任意形状）收敛成只含我们关心的字段；拿不到返回 null。 */
export function normalizeProfile(value: unknown): ProfileLike | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const profile: ProfileLike = {};
  if (typeof raw.name === 'string' && raw.name !== '') profile.name = raw.name;
  if (typeof raw.dir === 'string' && raw.dir !== '') profile.dir = raw.dir;
  if (typeof raw.home === 'string' && raw.home !== '') profile.home = raw.home;
  if (raw.packageManager !== null && typeof raw.packageManager === 'object') {
    const pm = raw.packageManager as Record<string, unknown>;
    const command = typeof pm.command === 'string' && pm.command !== '' ? pm.command : undefined;
    const args = Array.isArray(pm.args) ? pm.args.filter((item): item is string => typeof item === 'string') : undefined;
    if (command !== undefined || args !== undefined) {
      profile.packageManager = { ...(command === undefined ? {} : { command }), ...(args === undefined ? {} : { args }) };
    }
  }
  return profile;
}

/** `dependencies` 里声明的 spec 决定安装形态；`npm:` 别名仍按 registry 处理。 */
export function classifyInstallSpec(spec: unknown): InstallKind {
  if (typeof spec !== 'string') return 'unknown';
  const text = spec.trim();
  if (text === '') return 'unknown';
  if (text.startsWith('link:')) return 'link';
  if (text.startsWith('file:')) return 'file';
  if (text.startsWith('workspace:')) return 'workspace';
  return 'registry';
}

async function defaultReadFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

export interface DetectDeps {
  profile: ProfileLike | null;
  packageName: string;
  /** 测试注入；默认读真实文件。 */
  readFile?: (path: string) => Promise<string>;
  readJson?: (path: string) => Promise<unknown>;
}

/** 读 profile 的 package.json，返回本插件声明的 spec（找不到返回 undefined）。 */
export async function readDeclaredSpec(deps: DetectDeps): Promise<{ spec?: string; source?: string }> {
  const { profile, packageName } = deps;
  if (profile === null || typeof profile.dir !== 'string' || profile.dir === '') return {};
  const path = `${profile.dir.replace(/\/+$/, '')}/package.json`;
  const readFile = deps.readFile ?? defaultReadFile;
  const readJson = deps.readJson ?? (async (target: string): Promise<unknown> => JSON.parse(await readFile(target)) as unknown);
  let parsed: unknown;
  try {
    parsed = await readJson(path);
  } catch {
    return { source: 'profile-package-json-unreadable' };
  }
  if (parsed === null || typeof parsed !== 'object') return { source: 'profile-package-json-invalid' };
  const pkg = parsed as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const block = pkg[field];
    if (block === null || typeof block !== 'object') continue;
    const spec = (block as Record<string, unknown>)[packageName];
    if (typeof spec === 'string') return { spec, source: `${path}#${field}` };
  }
  return { source: `${path}#no-entry` };
}

export async function detectInstallKind(deps: DetectDeps): Promise<InstallKindResult> {
  const declared = await readDeclaredSpec(deps);
  const result: InstallKindResult = { kind: classifyInstallSpec(declared.spec) };
  if (declared.spec !== undefined) result.spec = declared.spec;
  if (declared.source !== undefined) result.source = declared.source;
  return result;
}
