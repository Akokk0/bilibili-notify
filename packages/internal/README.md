# @bilibili-notify/internal

`bilibili-notify` monorepo 内部包，提供各包间共享的常量。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- `BILIBILI_NOTIFY_TOKEN` — Symbol 访问令牌，用于内部包安全调用核心服务的 `getInternals()`，防止外部插件越权访问
