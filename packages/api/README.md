# @bilibili-notify/api

`bilibili-notify` monorepo 内部包，提供 B 站 HTTP API 客户端。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- WBI 签名（接口鉴权）
- Biliticket 生成与定时刷新
- Cookie 管理（tough-cookie）及自动刷新
- 二维码登录流程
- 动态列表、用户信息、直播间信息等接口封装
- 请求缓存与自动重试
