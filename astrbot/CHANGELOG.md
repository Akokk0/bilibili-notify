# Changelog · AstrBot 插件

`astrbot_plugin_bilibili_notify` AstrBot 平台插件版本历史。
发布到 [Akokk0/astrbot_plugin_bilibili_notify](https://github.com/Akokk0/astrbot_plugin_bilibili_notify)
独立仓库；`astrbot/core/metadata.yaml#version` 为版本事实源。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [v0.1.0-alpha.1] — 2026-06-20

### Added

- AI 总结人格现在委托给 AstrBot 自身的人格系统：新增 `aiPersonaId` 配置项，可在控制台选择 AstrBot 人格；留空时使用 AstrBot 默认人格，插件不再内置独立人格设置；支持在 Dashboard 为单个 UP 主单独覆盖人格 (d65bde1)

### Fixed

- 词云推送不再因静态资源缺失而失败：将 wordcloud 所需的静态字体 / 数据文件打包进 sidecar 镜像，部署后词云卡片直接可用，无需额外手动复制资源 (fb56f60)

### Changed

- Dashboard 新建订阅默认关闭推送开关，避免误推；插件版本改为从 `metadata.yaml` 单一来源读取，消除版本号不一致风险 (3f5fd6c)
- 移除 `metadata.yaml` 中的可选 `astrbot_version` 字段（AstrBot 不再要求此字段）；插件简介本地化为中文 (c3b89dd)

---

## [v0.1.0-alpha.0] — 2026-06-12

首次发布。核心功能：

- 监听 B 站 UP 主**动态**（普通动态、视频投稿）与**直播**（开播 / 下播）事件
- 渲染成图片卡片（puppeteer-core + Chrome 自动探测）并推送到 AstrBot 所有已配置渠道
- Node sidecar 架构：Python 插件启动独立 Node 进程承载 B 站 API / 渲染引擎，自动管理进程生命周期
- Dashboard 内嵌于 AstrBot 控制台页面：订阅管理 / 推送目标 / 实时日志 / 历史记录
- 可选 AI 总结（对接 AstrBot AI Provider），可按 UP 主单独开关
- 词云推送：直播弹幕词云生成并推送
- 支持图集（多图）、@全体提醒、SC 打赏高亮等推送类型
