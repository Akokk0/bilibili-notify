# @bilibili-notify/subscription

`bilibili-notify` monorepo 内部包，管理订阅列表的加载与更新。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- `SubscriptionManager` — 加载/重载订阅，构建 `PushArrMap` 并同步给 `BilibiliPush`
- `FlatSubConfigItem` — 核心插件扁平化订阅配置的类型定义
- `fromFlatConfig` — 将扁平配置转换为 `Subscriptions` 格式
- 新增订阅时自动查询直播间号、关注 UP 主
