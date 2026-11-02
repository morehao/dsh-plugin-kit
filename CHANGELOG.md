# Changelog

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
