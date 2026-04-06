# @bilibili-notify/push

`bilibili-notify` monorepo 内部包，负责将消息推送到 Koishi 机器人频道。

> [!NOTE]
> 此包为 monorepo 内部依赖（`private: true`），不发布到 npm。

## 功能

- 维护 UID → 推送目标（`PushArrMap`）的映射关系
- 按推送类型（直播、动态、SC、上舰、词云等）路由消息到对应频道
- 多 Bot 故障转移与自动重试
- 推送限流（消息间隔 500ms）
- 管理员私信错误通知
