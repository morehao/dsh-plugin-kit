# Changelog

## [v0.5.1] - 2026-11-05

### Features

- `check()` 优先复用宿主 0.2.2 的 `pluginManager.listVersions(name)`：逐版本带 `engines.dsh` / DSH peers 兼容性；自动跳过 incompatible，只选「兼容 + 稳定（或 dist-tag=latest）」，不自动推 prerelease。`UpdateView.versions` / `versionsOmitted` 暴露给 UI，用于解释「最新版为什么没被选中」。
- `apply()` 优先复用宿主 `pluginManager.updateBundle(name, version)`：目标校验、移除、安装、失败自动恢复全由宿主完成；`ROLLBACK_FAILED` / `INCOMPATIBLE_VERSION` / `UNSUPPORTED_PLATFORM` 为新映射的稳定错误码。`apply({ version })` 可从 `view.versions` 里选任意兼容版本。
- 新增 `HostVersionListing` / `HostVersionOption` 类型导出（`./update`）。

### Compatibility

- 旧宿主（无 `listVersions` / `updateBundle`）完整回退到原有 `pnpm view` / registry `/latest` + `installBundle → already-installed → removeBundle → installBundle` 路径，行为不变。
- `link:` / `file:` / `workspace:` 安装仍只给手动命令；`updateBundle` 的 `not-updatable` 也会回退。

## [v0.5.0] - 2026-11-04

### ⚠️ Breaking（语义变更，三个消费方须同步升级）

- **`UpdateView.currentVersion` 语义改为「磁盘已安装版本」**（此前是进程启动时的 `meta.version` 快照）。
  `updateAvailable` 改为 `isNewerVersion(currentVersion, latest)`，即基于磁盘判定。这修复了历史 bug：
  一键更新把新版写入磁盘后、进程未重启时，旧逻辑仍用启动快照判定「落后」，导致一直谎报有新版本、
  且允许重复卸载重装同一版本。`apply()` 的守卫同样改用磁盘版本，磁盘已最新直接 `NO_UPDATE`。
- 新增 `UpdateView.runtimeVersion`（本进程加载的代码版本）与 `UpdateView.restartRequired`
  （`currentVersion === latest && runtimeVersion !== latest` 推导，不再依赖易失内存变量）。
- 新增 `UpdaterDeps.readInstalledVersion?()`（默认读 `meta.pkgUrl`）与 `meta.pkgUrl`。

### Features

- 新增 `./update` 导出的 `createUpdateStateStore`：跨重启的「已装待重启」持久化（`lastSeenVersion` /
  `pendingVersion`），内含「prevLastSeen 不回退」防重复提示逻辑（下沉自 `dsh-commands` 的成熟实现）。
  `UpdaterDeps.stateStore` 注入后，`apply()` 成功写入 `pendingVersion`。
- `./update/client`：`UpdateClientView` 增加 `restartRequired?` / `runtimeVersion?`；`check()` 在
  `view.restartRequired` 为真时进入 `restart-required`（重启后新进程也能显示待重启）；
  `deriveUpdateUiState` 将其视为 settled；`updateStatusLabel` 的 `done` 参数支持无 latest 回退 currentVersion。

## [v0.4.2] - 2026-11-04

### Features

- 新增 `./test` 测试辅助：`createUndeclaredContext()`（Proxy 模拟 cordis「读未声明属性即抛 `cannot get property ... without inject`」）、`createAbsentContext()`（服务未挂载读返回 undefined）、`applyWithoutThrowing()`。供各插件断言 `apply()` 在服务缺失/未声明时降级而不抛，免各写一份守卫 Proxy。纯 headless、不 import node 内建、不引 React。

### Tests

- 新增 packed-exports 冒烟（`npm run check:packed`，并入 `check`）：`npm pack` → 解包 → 遍历 `exports` 每个子路径，断言 `default` 目标可 `import`、`types` 目标存在。兜住「构建成功但 tarball 缺文件/入口指向错」的 `files`/`exports` 白名单事故。

## [v0.4.0] - 2026-11-02

### Features

- 新增 `./update/restore`：headless 跨进程更新记号（pending store）。一键更新卸载自身后，新进程读回「刚点过更新」的记号以渲染恢复提示；支持 TTL、按 `keyPrefix` 区分插件、过期/损坏 fail-open 清理；不 import node 内建、不引 React。UI 仍由各插件自渲染。

## [v0.3.1] - 2026-11-01

### Features

- 补齐 P1（./github / ./meta / ./http dispatcher）并升 0.4.0 (#8)

**Full Changelog**: https://github.com/morehao/dsh-plugin-kit/compare/v0.3.0...v0.3.1

## [v0.3.0] - 2026-11-01

### Features

- 补齐 P0 通用底座（exec / fs / state）并升 0.3.0 (#6)

### Fixes

- **ci**: release.yml 建 Release 时去掉与 --notes-from-tag 冲突的 --repo (#4)

**Full Changelog**: https://github.com/morehao/dsh-plugin-kit/compare/v0.2.1...v0.3.0
