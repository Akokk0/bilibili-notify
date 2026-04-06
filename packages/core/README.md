# koishi-plugin-bilibili-notify

[![npm](https://img.shields.io/npm/v/koishi-plugin-bilibili-notify?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bilibili-notify)

基于 [Koishi](https://github.com/koishijs/koishi) 框架的 B 站推送插件核心包。

---

## 功能

- 扫码登录 B 站，登录凭证本地加密存储
- 在插件配置中填写订阅列表，支持动态和直播订阅
- 提供控制台 UI 管理登录状态

> [!NOTE]
> 动态推送需安装 `koishi-plugin-bilibili-notify-dynamic`
>
> 直播推送需安装 `koishi-plugin-bilibili-notify-live`
>
> 如需更灵活的订阅配置，请安装 `koishi-plugin-bilibili-notify-advanced-subscription`

## 安装

在 Koishi 插件市场中搜索 `bilibili-notify` 并安装。

## 使用方法

**登录 B 站**

在控制台左侧点击「扫码登录」，使用 B 站 App 扫码完成登录。

**订阅 UP 主**

在插件配置的 `subs` 中填写 UP 主信息，保存后自动加载订阅。

**常用指令**

| 指令 | 说明 |
|------|------|
| `bili list` | 查看当前订阅列表 |
| `bili ll` | 查看订阅 UP 主的直播状态 |
| `bili dyn <uid> [index]` | 手动推送指定 UP 主的动态 |
| `sys start/stop/restart` | 插件启动 / 停止 / 重启 |

> [!IMPORTANT]
> 指令需要 `authority:3` 及以上权限才能使用，可参考 [权限管理](https://koishi.chat/zh-CN/manual/usage/customize.html)

## 交流群

> [!TIP]
> 801338523 使用问题或 bug 欢迎在群里反馈

## 感谢

- [koishijs](https://github.com/koishijs/koishi) — 插件开发框架
- [blive-message-listener](https://github.com/ddiu8081/blive-message-listener) — B 站直播监听
- [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) — B 站 API 参考
- [bilibili-dynamic-mirai-plugin](https://github.com/Colter23/bilibili-dynamic-mirai-plugin) — 推送卡片灵感参考

## License

MIT
