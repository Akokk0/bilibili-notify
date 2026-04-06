# koishi-plugin-bilibili-notify-dynamic

[![npm](https://img.shields.io/npm/v/koishi-plugin-bilibili-notify-dynamic?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bilibili-notify-dynamic)

`koishi-plugin-bilibili-notify` 的动态推送插件，通过定时轮询获取 B 站 UP 主最新动态。

> [!NOTE]
> 需要先安装并配置 `koishi-plugin-bilibili-notify` 核心插件

## 功能

- 定时轮询 UP 主动态（cron 表达式可配置，默认每 2 分钟）
- 支持推送图文、视频、专栏、转发等各类动态
- 可配置动态屏蔽规则（关键词、正则、白名单）
- 可选生成动态卡片图片（需安装 `koishi-plugin-bilibili-notify-image`）
- 视频动态支持附带 BV 号链接

## 安装

在 Koishi 插件市场中搜索 `bilibili-notify-dynamic` 并安装。

## License

MIT
