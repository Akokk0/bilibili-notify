# Changelog

## 1.0.0-alpha.1

### Patch Changes

- fdc2c7b: fix: move internal packages to devDependencies so they are bundled into the output
- Updated dependencies [fdc2c7b]
  - koishi-plugin-bilibili-notify@4.0.0-alpha.1

## [1.0.0-alpha.0] - 2026-04-04

### Breaking Changes

- 重构为 monorepo 子包，Config 抽离至 `advanced-subscription.ts`
- 插件入口 `apply` 由 `applyAdvancedSub` 提供，`index.ts` 重新导出为 Koishi 标准格式

### Added

- 每个 UP 主独立配置推送平台和频道列表
- 每个频道可单独开关：动态、动态@全体、直播、开播@全体、SC、上舰、词云、直播总结、特别关注弹幕、特别关注进场
- 自定义直播消息模板（开播 / 直播中 / 下播）
- 自定义直播总结模板
- 自定义上舰消息模板及舰长 / 提督 / 总督图片链接
- 自定义推送卡片渐变颜色和底板颜色
- 特别关注弹幕用户列表及消息模板
- 特别关注进入直播间用户列表及消息模板
