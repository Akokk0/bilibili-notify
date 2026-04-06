# koishi-plugin-bilibili-notify-advanced-subscription

[![npm](https://img.shields.io/npm/v/koishi-plugin-bilibili-notify-advanced-subscription?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bilibili-notify-advanced-subscription)

`koishi-plugin-bilibili-notify` 的高级订阅配置插件，支持对每个 UP 主进行细粒度的推送配置。

> [!NOTE]
> 需要先安装并配置 `koishi-plugin-bilibili-notify` 核心插件
>
> 安装本插件后，核心插件中的 `subs` 配置将被本插件的订阅配置覆盖

## 功能

- 每个 UP 主独立配置推送平台和频道
- 每个频道可单独开关：动态、动态@全体、直播、开播@全体、SC、上舰、词云、直播总结、特别关注弹幕、特别关注进场
- 自定义直播消息模板（开播 / 直播中 / 下播）
- 自定义直播总结模板
- 自定义上舰消息模板及舰长图片
- 自定义推送卡片渐变颜色
- 特别关注弹幕用户列表及消息模板
- 特别关注进入直播间用户列表及消息模板

## 安装

在 Koishi 插件市场中搜索 `bilibili-notify-advanced-subscription` 并安装。

## License

MIT
