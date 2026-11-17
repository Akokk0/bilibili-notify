# ADR-0055：逐项能力发送与接收验证

状态：已接受（2026-11-17，主人要求能力逐项可测试，并确认本机夹具测试范围）。

## 决策

1. 目标测试默认普通文本，另可选择艾特全体、原生分享、图片、多图、合并转发、语音、Markdown 和接收消息。一次只测试一项，展示实际样例、目标、三态与结果。艾特全体先确认通知群成员及可能消耗平台额度；不自动批量测试或重试。
2. 适配器可选实现 `createTestPayload(connection, destination, kind, samples)`，提供其真实格式的测试载荷；不在该方法发送。宿主经 `TargetDispatcher` 的统一出口发送，保留启停、设置校验、截流和归属检查。旧适配器仍可测普通文本；不能构造对应样例的返回不支持，不能降级文本冒充成功。未知能力允许尝试；连接整体能力不由一次成功或失败随意改写。
3. QQ 群聊和 C2C 接入 SILK 语音的上传与富媒体发送；频道拒绝。OneBot 使用 `record` 段。桥与 webhook 没有相应协议实现，仍明确不支持。语音素材为自行合成的一秒提示音，离线编码，不加入运行时编码器。
4. 明确的 Markdown 载荷与普通文本分开。QQ 私域群聊和 C2C 使用原生 Markdown，仍由平台权限决定；桥仅在对端报告支持时按既有文本 wire 发送 Markdown。不能支持的适配器拒绝。修订 [0054](0054-connection-capabilities-and-destination-status.md) 决策 2 的初始状态：语音已实现，QQ Markdown 不再仅限图集。
5. 接收测试由宿主生成短时、唯一回传码，在发送提示前登记。只认同一连接和群／私聊的准确回复；发送成功不等于接收成功。跨会话、过期、旧测试不匹配，正常指令及链接解析不受影响。测试不保存回复内容与发言人。取消、关弹窗、目标／连接改变或停用、适配器退出及宿主退出均使旧测试失效；会话有数量和期限限制。
6. 既有目标测试请求保留兼容；新增能力请求单次发送，不走长时间重试。成功只说明平台接收，客户端呈现需用户在目标会话确认；结果不明、平台审核与失败保留服务端结果，不擅自再发。
7. 新载荷经现有捕获与历史摘要处理，重推原件保留语音字节和 Markdown 格式。内置图片与语音不依赖公网访问 BN；原生分享仍使用平台自身的签卡协议。

## 验证与边界

沿适配器发送、目标测试 HTTP 与 Targets 页面验证真实格式、失败、未知、不支持、默认文本、确认及接收测试生命周期。自动测试与浏览器验收只用本机夹具，不向真实 QQ 发消息；真实客户端播放及平台权限由使用者在新测试弹窗亲自确认。

## 依据

- [QQ 官方富媒体文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/rich-media.md)：语音类型 3，文档保守列出 SILK。
- [QQ 官方 Markdown](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/type/markdown.md)。
- [OneBot 11 语音消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md#语音)。
