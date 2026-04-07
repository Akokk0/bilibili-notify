# @bilibili-notify/storage

`bilibili-notify` monorepo 内部包，负责 Cookie 和密钥的本地持久化。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- `KeyManager` — 管理本地加密密钥（`master.key`）
- `CookieStore` — 使用密钥加密/解密 Cookie，持久化至 `cookies.json`
- `StorageManager` — 统一初始化入口
