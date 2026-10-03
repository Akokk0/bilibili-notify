# @bilibili-notify/api

`bilibili-notify` monorepo 内部包，提供 B 站 HTTP API 客户端。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- WBI 签名（接口鉴权）
- Biliticket 生成与定时刷新
- Cookie 管理及自动刷新（请求客户端、cookie 罐、浏览器身份来自 `@bilibili-notify/http`，这里只在它上面包一层保住 B 站的语义：非 2xx 抛错、JSON 自动解析、-101 探测）
- 二维码登录流程
- 动态列表、用户信息、直播间信息等接口封装
- 请求缓存与自动重试
