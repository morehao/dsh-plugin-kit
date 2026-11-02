# @morehao/dsh-plugin-kit

DeepSeek Harness（dsh）插件共用的工具包。当前提供这些能力：

- **插件自更新引擎**（`./update`）：查 npm 最新版 → 判断能不能一键更新 → 经宿主 `pluginManager` 重装自己。
- **headless 客户端控制器**（`./update/client`）：检查/更新的状态机与单飞，UI 由各插件自己渲染。
- **跨进程更新记号**（`./update/restore`）：一键更新卸载自身后，新进程读回「刚点过更新」的记号以渲染恢复提示（localStorage + TTL，fail-open；UI 留插件）。
- **HTTP 小工具**（`./http`）：自定义头鉴权、`no-store` JSON、有上限的 JSON body，以及薄路由 dispatcher（`createRouteHandler`）。
- **子进程执行**（`./exec`）：argv 直传（不经 shell）、环境白名单、超时/取消、输出上限，外加 `pnpm view` 版本解析。
- **原子写**（`./fs`）：`writeFileAtomicSync` / `writeFileAtomic`，杜绝「半个文件」。
- **JSON 状态持久化**（`./state`）：`$DSH_HOME` 解析 + `<home>/<plugin>/*.json` 读写（读 fail-open、写抛错）。
- **GitHub 工具**（`./github`）：仓库地址规范化 + Release 正文读取（带 TTL 缓存）。
- **插件身份**（`./meta`）：从自家 `package.json` 读 name / version / repository。

设计约束：**零 `@deepseek-ai/*` 运行时依赖**，宿主能力（`pluginManager` / `profileContext`）全部由调用方注入。进程策略由调用方把握：`./update` 常驻能力不主动 spawn，需要 `pnpm view` 时由调用方注入 `runPnpmView`；也可直接用 `./exec`（或 `createPnpmViewRunner`，默认走 `./exec`、可注入 `exec` 替换进程策略）。

## 安装

```bash
npm install @morehao/dsh-plugin-kit
```

## 能力边界：哪些复用宿主、哪些必须自建

自更新这件事在宿主（`@deepseek-ai/dsh-plugin-manager`）里已有大半能力，本包的原则是**能复用就复用**：

| 能力 | 来源 | 说明 |
|---|---|---|
| 安装 / 卸载 | **复用宿主** | apply 全程走 `pluginManager.installBundle` / `removeBundle`；`already-installed → remove → install` 就是宿主既定的更新流程，`applied/restart-required/overridden` 也直接来自宿主结果。 |
| registry 列表（镜像 / 私源 / token） | **复用宿主** | `resolved` 由宿主跑 `pnpm config get registry` 解析，本包不自己读 `.npmrc`。 |
| registry **排序 / 回退** | **复用宿主（注入）** | 优先用调用方注入的宿主原生 `registryPlan`（`@deepseek-ai/dsh-plugin-manager/registry`），与 `installBundle`/`inspect` 内部同一份源码、含私有源「只问它自己、不回退公有源」语义。本包不直接 import（保持零 `@deepseek-ai/*` 运行时依赖），由插件侧注入。未注入时用内置 `resolveRegistryPlan` 兜底（`resolved → registry → fallback` 宽松顺序，fail-open）。 |
| 查最新版 | **必须自建** | 宿主 `inspect()` 对「已装包」直接返回 `already-installed`，不会去问 registry；插件查的正是「我自己这个已装包」，必然被拦截。故只能走 `pnpm view`（`runPnpmView`，复用 profile 的包管理器）或 registry `/latest`。 |
| 安装形态判定 | **必须自建** | 宿主未暴露「本包以什么 spec 声明」；本包读 `<profile.dir>/package.json` 识别 `link:/file:/workspace:` 以拒绝把开发链接覆盖成 npm 版。 |

一句话：**装/卸、registry 取数与排序都复用宿主（排序原生能力通过注入复用）；查版本、判形态因宿主 API 缺口而自建；不注入原生 `registryPlan` 时才回落到内置兜底顺序。**

## 一键更新（host）

```ts
import { createPluginUpdater } from '@morehao/dsh-plugin-kit/update';
// 宿主原生 registry 排序（与 installBundle/inspect 同一份），由插件侧注入、本包不直接依赖
import { registryPlan as hostRegistryPlan } from '@deepseek-ai/dsh-plugin-manager/registry';

const updater = createPluginUpdater({
  meta: { name: pkg.name, version: pkg.version, ...(pkg.repository ? { repository: repoUrl(pkg.repository) } : {}) },
  getPluginManager: () => ctx.get('pluginManager'),
  getProfile: () => ctx.get('profileContext'),
  getProfileName: () => ctx.get('profileContext')?.name,
  // 可选但推荐：注入宿主原生 registryPlan，使「查版本的 registry 顺序」与宿主安装完全一致
  registryPlan: hostRegistryPlan,
  // 可选：用 profile 的包管理器查版本（继承 .npmrc 的镜像 / 私源 / token）
  runPnpmView: async (spec) => {
    const profile = ctx.get('profileContext');
    const result = await execCapture(profile.packageManager?.command ?? 'pnpm', [...(profile.packageManager?.args ?? []), 'view', spec, 'version', '--json'], {
      cwd: profile.dir,
      env: sanitizedEnv(process.env),
      timeoutMs: 8_000,
    });
    if (result.code !== 0) return null;
    const value = JSON.parse(result.stdout.trim() || 'null');
    return typeof (Array.isArray(value) ? value.at(-1) : value) === 'string' ? (Array.isArray(value) ? value.at(-1) : value) : null;
  },
  logger: (event, detail) => log(event, detail),
});

const view = await updater.check({ fresh: true });
// { packageName, currentVersion, latestVersion, updateAvailable, checkFailed,
//   canApply, installKind, installSpec?, manualCommand, applying, checkedAt }

const result = await updater.apply(); // 需要先 check()；只接受刚查到的版本
// { application: 'applied' | 'restart-required' | 'overridden', restartRequired, updatedVersion, installKind, steps }
```

`apply()` 的行为与边界：

- 只安装 **registry 上刚查到的 latest**，不接受调用方随手给的 spec（防注入）。
- `link:` / `file:` / `workspace:` 安装一律拒绝（`LINKED_INSTALL`），只给 `manualCommand`——避免把开发链接换成 npm 版。
- `installBundle` 返回 `already-installed` 时走 `removeBundle → installBundle`；remove 之后装失败会尝试装回原版本，仍失败报 `ROLLBACK_FAILED`。
- 单飞：同一实例同时只允许一次 `apply()`。
- 没有 `pluginManager.installBundle` 时报 `NO_MANAGER`，界面应展示 `manualCommand`。

错误码（`PluginUpdateError.code`）：`NO_MANAGER` `LINKED_INSTALL` `NOT_CHECKED` `NO_UPDATE` `INVALID_VERSION` `APPLY_IN_PROGRESS` `INSTALL_FAILED` `REMOVE_FAILED` `ROLLBACK_FAILED` `UNSUPPORTED_RESULT`。

固定事件名（便于更新把插件自己卸载后对账）：

| 事件 | 时机 |
|---|---|
| `plugin.update.latest` / `plugin.update.latest.failed` | 查到（或查不到）最新版 |
| `plugin.update.check` | 一次检查完成 |
| `plugin.update.apply.start` | 开始安装 |
| `plugin.update.apply` | 安装成功（带 `application` / `restartRequired`） |
| `plugin.update.apply.failed` | 安装失败（带 `code` / `steps`） |

## 客户端控制器（headless）

```ts
import { createUpdateController } from '@morehao/dsh-plugin-kit/update/client';

const controller = createUpdateController({
  request: {
    check: ({ fresh }) => api.getUpdate(fresh),   // 返回 UpdateClientView
    apply: () => api.applyUpdate(),               // 返回 { application, restartRequired? }
  },
});
controller.subscribe((state) => render(state));
await controller.check();
await controller.apply();
```

状态：`idle → checking → available | current | failed`；`available → applying → applied | restart-required | failed`。
控制器不做 i18n、不引 React：错误码（`CHECK_FAILED` / `NO_UPDATE` / `NO_APPLY` 或宿主抛的 code）交给插件翻译。

## 跨进程更新记号（`./update/restore`，headless）

一键更新会先把插件自己卸载、面板随之消失；新进程重开时要靠一条不随面板消失的「已安装，请完全退出再打开」提示。本子路径只负责把「我刚才点了更新」记进 localStorage 并读回（含 TTL、过期/损坏清理、fail-open），**提示条 UI 由各插件自己渲染**。

```ts
import { createPendingStore } from '@morehao/dsh-plugin-kit/update/restore';

const pending = createPendingStore({ keyPrefix: 'dsh-skills-console:' }); // 前缀按插件区分
// 点「确认更新」、动手前：
pending.write(currentVersion, latestVersion);
// 新进程重开（读回，过期/损坏自动清理）：
const notice = pending.read(); // { from, to, at } | null
// 用户点「知道了」：
pending.clear();
```

- 默认 `keyPrefix = 'dsh-plugin-update:'`；设成自家前缀即可复用已有 localStorage 键。
- `read()` 对过期（默认 24h）、损坏 JSON、结构不符、明显未来时间戳一律返回 `null` 并清理；无 `localStorage` / 隐私模式抛错 → 全程 fail-open，不影响插件挂载。
- 不依赖 React、不 import node 内置模块，可随客户端产物内联。

## HTTP 小工具

```ts
import { hasHeader, readJsonBody, sendJson, createRouteHandler } from '@morehao/dsh-plugin-kit/http';

if (!hasHeader(request, 'x-my-plugin')) return sendJson(response, 403, { ok: false, code: 'FORBIDDEN' });
const body = await readJsonBody(request, { maxBytes: 512 * 1024 });
sendJson(response, 200, { ok: true });

// 薄路由 dispatcher：统一 鉴权 → 剥前缀 → 读 body → 包 {ok:true} → 错误兜底。
// 不做路由表 DSL / 错误码翻译——matchRoute 与错误码映射留在你的 dispatch / onError 里。
const handler = createRouteHandler({
  prefix: '/api/morehao/my-plugin',
  header: 'x-dsh-my-plugin',
  dispatch: async ({ method, pathname, body }) => {
    if (method === 'GET' && pathname === '/state') return { state: getState() };
    throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  },
  onError: (error) => ({ status: error.code === 'NOT_FOUND' ? 404 : 500, code: error.code, message: error.message }),
});
```

## 子进程执行（`./exec`）

argv 直传、不经 shell；超时/取消先 SIGTERM、宽限后 SIGKILL；输出有上限且保留尾部；`spawn` 失败**不 reject**，落到 `error` 字段。

```ts
import { spawnCollect, sanitizedEnv, collectVersionView } from '@morehao/dsh-plugin-kit/exec';

const result = await spawnCollect('git', ['rev-parse', 'HEAD'], {
  cwd: repo,
  env: sanitizedEnv(process.env),      // 只放行 PATH/HOME/代理/证书/locale/git 身份等白名单
  timeoutMs: 8_000,
});
// { code, signal, stdout, stderr, output, timedOut, aborted, durationMs, error? }

// 从 `pnpm view <spec> version --json` 的输出里取版本串（单值或数组取尾；非法 → null）
const version = collectVersionView({ code: result.code, stdout: result.stdout });
```

## 原子写（`./fs`）

同目录临时文件 → fsync → rename → fsync(父目录)；Windows rename 有界重试；失败清理临时文件，原文件在 rename 前不被截断。

```ts
import { writeFileAtomicSync, writeFileAtomic } from '@morehao/dsh-plugin-kit/fs';

writeFileAtomicSync('/path/state.json', `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await writeFileAtomic('/path/state.json', content);  // 同语义异步版
```

`mode` 省略时沿用已有文件权限，新文件走 `defaultMode`（默认 `0o644`）。

## JSON 状态持久化（`./state`）

`$DSH_HOME` 解析 + `<home>/<plugin>/*.json` 读写。**读 fail-open**（缺失/坏 JSON/非对象 → `fallback()`，永不抛）；**写抛错**（写通常是一次事务，静默吞掉会掩盖数据丢失，需要「尽力而为」的调用方自行 try/catch）。

```ts
import { resolveDshHome, createJsonStore } from '@morehao/dsh-plugin-kit/state';

const store = createJsonStore({
  dir: `${resolveDshHome()}/my-plugin`,   // $DSH_HOME → ~/.dsh
  file: 'state.json',
  fallback: () => ({ lastSeenVersion: '' }), // 工厂函数，避免共享可变引用
});
const state = store.read();               // 坏文件也返回 fallback
store.write({ lastSeenVersion: '0.3.0' }); // 原子写
```

## 复用 `pnpm view` 查版本（`./update`）

三仓此前各手写一遍的「读 profile → 拼 `pnpm view` → 解析 → 校验」，收敛为一个工厂：

```ts
import { createPnpmViewRunner, createPluginUpdater } from '@morehao/dsh-plugin-kit/update';

const runPnpmView = createPnpmViewRunner({
  getProfile: () => ctx.get('profileContext'),
  // 可选：注入自定义 exec 以沿用本插件更细的进程策略；默认走 ./exec
  // exec: myExecCapture,
});
const updater = createPluginUpdater({ meta, getPluginManager: () => ctx.get('pluginManager'), runPnpmView });
```

拿不到 `profile.dir` / 命令失败 / 输出非法 / 版本不是合法 semver → 返回 `null`（交由 registry 兜底）。

## GitHub 工具（`./github`）

仓库地址规范化 + Release 正文读取（收敛各插件重复的正则与拉取逻辑）：

```ts
import { normalizeRepositoryUrl, repoSlug, createReleaseReader } from '@morehao/dsh-plugin-kit/github';

normalizeRepositoryUrl('git@github.com:o/r.git');   // → 'https://github.com/o/r'
repoSlug('https://github.com/o/r');                  // → 'o/r'

const reader = createReleaseReader({ repo: 'o/r' }); // ttlMs / failureTtlMs / timeoutMs / fetchImpl 可注入
const info = await reader.release('1.2.3');          // { version, body, htmlUrl, name } | null
// 拉 https://api.github.com/repos/o/r/releases/tags/v1.2.3；成功与失败都做 TTL 缓存，失败 → null（不抛）
```

本模块只依赖 `./semver`，**不 import 任何 node 内置**。

## 插件身份（`./meta`）

从自家 `package.json` 读出 name / version / repository（收敛三仓的 `PLUGIN_META` / `readPluginInfo`）：

```ts
import { createPluginMeta, readInstalledVersion } from '@morehao/dsh-plugin-kit/meta';

const pkgUrl = new URL('../package.json', import.meta.url); // 层级由插件自己给
const meta = createPluginMeta({ pkgUrl, defaultName: '@you/plugin' });
// { name, version, repository?: 'https://github.com/o/r', repo: 'o/r' | null }

readInstalledVersion({ pkgUrl }); // 每次重读（更新后同进程读到新值）；失败 → ''
```

只在 host 侧使用（含 `node:fs`），不被 `./update/client` 引用。

## 能力边界：什么进 kit、什么不进（决策基线）

本包定位是 **DSH 插件共用的横切能力库**，不是插件框架、也不是组件库。判断某个能力该不该进 kit，用下面四条判据，全部满足才进：

1. **≥2 个插件有真实需求**（不是「将来可能」）。当前消费方：`dsh-commands` / `dsh-github-trending` / `dsh-skills-console`。
2. **与 UI / 主题 / 文案无关**（headless）。凡是承载视觉、样式变量、文案、宿主渲染层的，一律**不进**——各插件用各自的 `h()` 工厂与主题变量自己渲染。
3. **有明确的复用边界**：是在定义一个通用机制/接口，而不是把某个插件的实现原样搬进来。
4. **符合本包硬约束**：零 `@deepseek-ai/*` 运行时依赖；host 侧子路径不得被 `./update/client` 引用；进客户端的子模块不 import node 内置模块、不 `require` react。

### 已判定的归属

| 能力 | 判定 | 理由 |
|---|---|---|
| 自更新 host 引擎、状态机、registry/semver/超时/缓存、Release 正文读取（host）、插件身份 | **已进** | 三插件共用、headless |
| 跨进程「刚点过更新」记号 + 恢复提示的**机制**（pending store：读写 + TTL + 按包名 keyPrefix，fail-open） | **已进**（`./update/restore`） | 任何做自更新的插件都会遇到「更新即卸载自身 → 面板消失 → 重开」，与 UI 无关 |
| 客户端 Release 正文的**纯函数**降级（`<details>` → 加粗小标题）+ 委托取数的薄 loader | **应进** | 纯逻辑 + 注入取数，避免各插件各写一遍 |
| 直连 GitHub API 的**客户端** reader | **不进** | 与 host `./github` 的 `createReleaseReader` 重复；token/限流是插件自己的事，用注入取数即可 |
| host 引擎的 `appliedVersion` 收敛（跨版本自更新后不再谎报「有新版本」） | **应进（改 `./update`）** | 引擎级行为，与 UI 无关，任何自更新插件都需要 |
| 更新**胶囊 / 两段确认 / 详情弹窗**等 UI 组件 | **不进（永不）** | 违反判据 2：各插件 `h()`、样式变量、文案体系不同，强行上提会造兼容多主题的巨型组件 |

### 工程铁律：依赖方向单向、消灭重复

- 依赖只能 `插件 → kit`，**kit 绝不反向依赖任何插件**，插件之间也不互相依赖。
- 够格进 kit 的能力，**最终形态应是「先在 kit 定义接口 → 各插件消费」**，而不是「先在某个插件里长出来 → 回头再抽出去」（后者会留下多份漂移实现，重复难以根除）。
- 插件里那份真正的私有逻辑（如 skills-console 的 `layout-selected` 布局卫生）**留在插件**，不因「看起来像更新相关」就上提。

## 版本与兼容

- Node `^22.20.0 || >=24.0.0`，纯 ESM。
- `./update`、`./http`、`./exec`、`./fs`、`./state`、`./github`、`./meta` 走 host 侧；`./update/client`、`./update/restore` 只含纯逻辑，不 import node 内置模块、不引 React（客户端产物只允许 react）。
- 宿主服务形状按结构化类型处理（`PluginManagerLike` / `ProfileLike`），宿主版本变化不会把插件一起拖下去。

## 开发

```bash
npm install
npm run check   # typecheck + build + 78 条离线测试（假 fetch / 假 pluginManager / 假 exec，不联网、不真装）
```
