# Changelog

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
