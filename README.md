# @morehao/dsh-plugin-kit

DeepSeek Harness（dsh）插件共用的工具包。当前提供三件事：

- **插件自更新引擎**（`./update`）：查 npm 最新版 → 判断能不能一键更新 → 经宿主 `pluginManager` 重装自己。
- **headless 客户端控制器**（`./update/client`）：检查/更新的状态机与单飞，UI 由各插件自己渲染。
- **HTTP 小工具**（`./http`）：自定义头鉴权、`no-store` JSON、有上限的 JSON body。

设计约束：**零 `@deepseek-ai/*` 运行时依赖**，宿主能力（`pluginManager` / `profileContext`）全部由调用方注入；进程相关的策略（比如用哪个包管理器查版本）也由插件自己决定，本包不替你 spawn。

## 安装

```bash
npm install @morehao/dsh-plugin-kit
```

## 一键更新（host）

```ts
import { createPluginUpdater } from '@morehao/dsh-plugin-kit/update';

const updater = createPluginUpdater({
  meta: { name: pkg.name, version: pkg.version, ...(pkg.repository ? { repository: repoUrl(pkg.repository) } : {}) },
  getPluginManager: () => ctx.get('pluginManager'),
  getProfile: () => ctx.get('profileContext'),
  getProfileName: () => ctx.get('profileContext')?.name,
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

## HTTP 小工具

```ts
import { hasHeader, readJsonBody, sendJson } from '@morehao/dsh-plugin-kit/http';

if (!hasHeader(request, 'x-my-plugin')) return sendJson(response, 403, { ok: false, code: 'FORBIDDEN' });
const body = await readJsonBody(request, { maxBytes: 512 * 1024 });
sendJson(response, 200, { ok: true });
```

## 版本与兼容

- Node `^22.20.0 || >=24.0.0`，纯 ESM。
- `./update` 与 `./http` 走 host 侧；`./update/client` 只含状态机，不 import node 内置模块（客户端产物只允许 react）。
- 宿主服务形状按结构化类型处理（`PluginManagerLike` / `ProfileLike`），宿主版本变化不会把插件一起拖下去。

## 开发

```bash
npm install
npm run check   # typecheck + build + 24 条离线测试（假 fetch / 假 pluginManager，不联网、不真装）
```
