# @bilibili-notify/storage

`bilibili-notify` monorepo 内部包，负责主密钥、加密与原子写盘这些本地持久化的底座。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- `MasterKeyStore` — 管理本地加密密钥（`master.key`）
