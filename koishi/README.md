# koishi-plugin-bilibili-notify

[![npm](https://img.shields.io/npm/v/koishi-plugin-bilibili-notify?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bilibili-notify)

> [!WARNING]
> **本插件在 Koishi 4 上暂停更新,5.2.1 是最后一版;等 Koishi 升到 v5 再跟进更新。** 近期会推出一个薄的 Koishi 适配插件,把 bilibili-notify [独立端](https://github.com/Akokk0/bilibili-notify)(Docker / 桌面版)桥接进 Koishi,之后的新功能都在独立端上做。5.2.1 本身可以继续用,只是在 Koishi 4 上不会再有新功能与修复。

基于 [Koishi](https://github.com/koishijs/koishi) 框架的 B 站推送插件核心包。

---

## 功能

- 扫码登录 B 站，登录凭证本地加密存储
- 在插件配置中填写订阅列表，支持动态和直播订阅
- 动态推送、直播推送、图片渲染、AI 点评、高级订阅全部内置，装这一个包就够了

## 安装

在 Koishi 插件市场中搜索 `bilibili-notify` 并安装。**不再需要**额外安装 `koishi-plugin-bilibili-notify-dynamic` / `-live` / `-ai` / `-image` / `-advanced-subscription` —— 本包 5.0.0 起五合一，这五个子包已停止更新，功能全部并入本包。

> [!IMPORTANT]
> 从**多插件版本**（`koishi-plugin-bilibili-notify` 4.x 及更早）升级的用户：请先卸载上述五个子插件，只保留并升级本包，再按下方「配置结构」重新填写一遍配置。旧插件各自的配置字段不会自动迁移。

## 配置结构

控制台配置项按功能域分组：

| 域 | 对应功能 |
|---|---|
| `account` | B 站账号：User-Agent、日志级别、登录健康检查间隔、cookie 加密口令 |
| `push` | 推送目标：主人账号 / 平台、安静时段 |
| `subscriptions` | 基础订阅列表（UP 主 + 推送目标） |
| `advancedSub` | 高级订阅开关：按 UP 主粒度精细配置，替代 `subscriptions` 的扁平列表 |
| `render` | 图片渲染开关与卡片样式（需要 `koishi-plugin-puppeteer`，未安装时自动降级为纯文本） |
| `ai` | AI 点评/对话开关与模型配置 |
| `dynamic` | 动态推送的模板、过滤、图集等设置（恒开，核心能力） |
| `live` | 直播推送的词云、总结、卡片文案等设置（恒开，核心能力） |

## 使用方法

**登录 B 站**

在控制台左侧点击「扫码登录」，使用 B 站 App 扫码完成登录。

**订阅 UP 主**

在插件配置的 `subscriptions.list` 中填写 UP 主信息，保存后自动加载订阅。想按 UP 主粒度精细配置就改用 `advancedSub`。

**常用指令**

| 指令 | 说明 |
|------|------|
| `bili list` | 查看当前订阅列表 |
| `bili ll` | 查看订阅 UP 主的直播状态 |
| `bili dyn <uid> [index]` | 手动推送指定 UP 主的动态 |
| `bili ai [prompt]` | 向 AI 发一条测试消息（需开启 `ai.enabled`） |
| `bili chat [message]` | 与 AI 多轮对话，`-c` 清除会话历史（需开启 `ai.enabled`） |
| `status auth/dyn/live/sm` | 查看登录状态 / 动态监测 / 直播监测 / 订阅管理对象 |
| `bn start/stop/restart` | 插件启动 / 停止 / 重启 |

> [!IMPORTANT]
> 指令需要 `authority:3` 及以上权限才能使用，可参考 [权限管理](https://koishi.chat/zh-CN/manual/usage/customize.html)

## 静态加密（Cookie / apiKey）

登录后的 B 站 Cookie、AI apiKey 等敏感信息会加密保存在 Koishi 数据目录下的 `bilibili-notify/` 内。密钥来源由插件配置项 `cookieEncryptionKey` 决定：

- **填写**：密钥经 scrypt 从该口令派生，**本身不落盘** → 真正的 AES-256 静态加密。生成一串随机口令：

  ```bash
  openssl rand -base64 32
  # 没有 openssl 时可用 Node：
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

- **留空**：回退到与密文同目录的随机密钥文件 —— 仅混淆、不构成真正的加密，启动时会打告警。

> [!WARNING]
> 口令请妥善保管，**不要随意改动或清空**：换了口令后，之前用旧密钥加密的内容将无法解密，需要重新扫码登录。

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
