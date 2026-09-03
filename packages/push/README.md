# @bilibili-notify/push

`bilibili-notify` monorepo 内部包:平台中立的推送路由器(`BilibiliPush`)。独立端 runtime
注入 sink(按 target 投递到 OneBot / webhook / QQ 官方机器人等平台)、订阅仓、globals
provider 与静音闸,它负责把「某个 UP 的某类推送」翻成对每个目标的投递。

> [!NOTE]
> 此包为 monorepo 内部依赖(`private: true`),不发布到 npm。

## 功能

- 按 uid + feature 从订阅的 routing 解析推送目标,并按当前 globals 过 `features` 总开关与免扰时段
- 消息版式分条:一次推送可以是多条 payload 的序列(同 target 顺序发、失败即中止后续条、@全体只跟首条)
- 失败重试与退避(sleep 走宿主 ServiceContext,dispose / stop 时立即收敛)
- 全局静音闸
- master 私聊通知与可达性边沿日志
