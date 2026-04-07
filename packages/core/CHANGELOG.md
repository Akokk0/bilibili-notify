# Changelog

## 4.0.0-alpha.4

### Patch Changes

- Updated dependencies [ed0e7c9]
  - @bilibili-notify/api@0.0.2-alpha.0

## 4.0.0-alpha.3

### Patch Changes

- 921f0ad: Workspace replace

## 4.0.0-alpha.2

### Patch Changes

- 2a11604: Alpha

## 4.0.0-alpha.1

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output

## [4.0.0-alpha.0] - 2026-04-04

### Breaking Changes

- 重构为 Yarn workspace monorepo，核心包路径变更为 `packages/core`
- 动态推送、直播推送、图片渲染拆分为独立可选插件，需单独安装
- 订阅配置格式调整，旧版订阅需重新配置

### Added

- 新增 `bilibili-notify/plugin-error` 事件，用于子插件向核心上报错误
- 控制台扫码登录 UI

### Changed

- Config 抽离至独立文件 `config.ts`，导出 `BilibiliNotifyConfig` + `BilibiliNotifyConfigSchema`
- `SubscriptionLoader` 重命名为 `SubscriptionManager`，移至 `@bilibili-notify/subscription` 包
