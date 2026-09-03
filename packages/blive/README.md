# @bilibili-notify/blive

自实现的 B 站直播信息流 WSS 客户端 —— 替代 `blive-message-listener` / `tiny-bilibili-ws`。private 包,不发 npm,仓内经 `workspace:*` 消费(内联进 server 单文件 bundle)。

## 设计边界:哑管道

`connectLiveRoom` 只做四件事:**连接 + 认证 + 心跳 + 编解码/解析进单回调漏斗**。

- **连接参数全注入**:token(getDanmuInfo)、host_list、uid、真 buvid3、Cookie、User-Agent 全部由调用方提供,包内**零 HTTP**。`userAgent` 必传(从 `api.getUserAgent()` 取,保证与同进程 HTTP 同指纹)。
- **无内部重连**:断线重连、退避、放弃全是上游(`packages/live` 的 RoomSession)的策略;host 轮换也在上游做(本包恒取 `hostList[0]`)。
- **`close()` 之后保证静默**:不再发包、不再上报任何事件(包括主动关闭的 close 回声),上层无需「有意关闭」记账。
- **坏包绝不抛**:解压失败 / JSON 坏掉 / 形状缺损的消息一律丢弃或降级 `raw`,一条坏消息不影响整条连接。

```ts
import { connectLiveRoom } from "@bilibili-notify/blive";

const client = connectLiveRoom({
	roomId, uid, token, buvid, hostList,
	cookieHeader: api.getCookiesHeader(),
	userAgent: api.getUserAgent(),
	onEvent: (ev) => { /* 单 switch 接完 */ },
	// connectTimeoutMs?: 15_000  建连→auth-ok 整段限时,超时 emit error + close
});
client.close();
```

## 事件清单(`LiveEvent` 可辨别联合)

### 连接生命周期(client 发出)

| kind | 载荷 | 说明 |
| --- | --- | --- |
| `open` | — | TCP/WSS 已连上,已发认证包 |
| `auth-ok` | — | 认证回执 code=0,心跳已启动 |
| `auth-failed` | `code`(缺 code 按 -1) | 一条连接只认首个认证回执 |
| `heartbeat` | `popularity` | 心跳回执带人气值(≈旧库 onAttentionChange) |
| `closed` | `code?` `reason?` | 服务器关闭;主动 close() 无回声 |
| `error` | `error` | socket 错误 / 连接认证超时 |

### 业务消息(parser 产出,MESSAGE 帧)

| kind | 来源命令 | 关键载荷 |
| --- | --- | --- |
| `danmu` | DANMU_MSG(含后缀变体) | `content` `user` `danmuType?` `timestamp?` `isLottery?` `emoticon?` |
| `superchat` | SUPER_CHAT_MESSAGE | `content` `price`(RMB) `id?` `durationSec?` `user` |
| `guard-buy` | GUARD_BUY | `guardLevel` `giftName` `giftId?` `price?` `num?` `startTime?` `endTime?` |
| `guard-toast` | USER_TOAST_MSG / **USER_TOAST_MSG_V2**(均 JSON,V2 结构重排) | `opType`(1开通/2续费/3自动续费) `guardLevel` `roleName?` `num?` `unit?` `price?`(实付折扣价,GUARD_BUY 是原价) `toastMsg?` |
| `gift` | SEND_GIFT / **SEND_GIFT_V2**(protobuf) | `giftId` `giftName` `coinType`(gold/silver) `price` `num` `combo?`;2026-08 实测大房间已全走 V2 |
| `watched` | WATCHED_CHANGE | `num` `textSmall` |
| `liked` | LIKE_INFO_V3_UPDATE | `count`(真实字段是 `click_count`) |
| `live-start` / `live-end` | LIVE / PREPARING | — |
| `user-action` | **仅 INTERACT_WORD_V2**(protobuf) | `action`(enter/follow/share) `user` |
| `room-change` | ROOM_CHANGE | `title` `areaName?` `parentAreaName?` |
| `rank-count` | ONLINE_RANK_COUNT | `count`(高能用户数) |
| `red-pocket-start` / `red-pocket-end` | POPULARITY_RED_POCKET_* | 口令/时长/奖品清单;中奖名单 |
| `anchor-lottery-start` / `anchor-lottery-end` | ANCHOR_LOT_* | 奖品/时长/参与要求;中奖名单 |
| `room-warn` | WARNING / CUT_OFF | `warnType`(warning/cut) `msg` |
| `room-silent` | ROOM_SILENT_ON/OFF | `silentType`(level/medal/member/off) `level` `second` |
| `room-admin` | room_admin_entrance / ROOM_ADMIN_REVOKE | `adminType`(set/revoke) `uid` |
| `entry-effect` | ENTRY_EFFECT | `user`(昵称提取自 copy_writing) |
| `like-click` | LIKE_INFO_V3_CLICK | `user`(带粉丝牌) |
| `raw` | 其余一切 | `cmd` `payload` 原样透传 |

`LiveUser` 的 `badge` / `guardLevel` / `isRoomAdmin` 是可选字段,仅在对应帧携带且有意义时出现(guardLevel=0、admin=假一律省略)。

### 铁律:user-action 由 INTERACT_WORD_V2 一帧独供

舰长进一次房,B 站会同时发 INTERACT_WORD_V2 **和** ENTRY_EFFECT;旧库把两帧都解成 `enter`,业务侧特别关注进房被推两次。所以 `entry-effect` / `like-click` 是**独立 kind**,永远不并入 `user-action` —— parser 测试钉死,改之前先想清楚这段历史。

同构铁律:`guard-toast` **绝不并入 `guard-buy`** —— 2026-08-28 蹲守实测(房 6154037,60 分钟 5 单,全是 opType=2 续费):**每单都是 GUARD_BUY + USER_TOAST_MSG + USER_TOAST_MSG_V2 三帧同秒齐发**,并流 = 一次上舰三连推。所以续费**不会**漏推(GUARD_BUY 照发,「续费只走 toast」的参考资料推断已被证伪);guard-toast 的价值是语义增量:opType 区分开通/续费、`price` 是实付折扣价(GUARD_BUY 报原价)、toastMsg 带陪伴天数。注意 opType 与文案不对齐(实测 opType=2 的文案有「续费了」也有「开通了」),判断只信 opType。opType=1(全新首购)与 3(自动续费)的帧组合尚无自录佐证。

### 协议漂移观测:raw 的 `degraded` 标志

已知命令(`PARSED_COMMANDS` 集合)解析失败时,降级的 raw 会带 `degraded: true` —— 这是「B 站可能改了字段形状」的漂移信号,上游(RoomSession)对它做限流 warn。不带 degraded 的 raw 只是刻意不解析的命令,属正常流量。背景:SEND_GIFT → SEND_GIFT_V2 迁移时旧库在大房间漏掉全部礼物且无报警,这个标志就是那次的教训。

### 刻意不解析(要用走 `raw`)

颜色族字段(牌子渐变/弹幕色,渲染细节)、文内小表情映射(`in_message_emoticon`)、礼物 `send_master`(连麦指向)、天选的送礼要求明细(`requireText` 已含人话描述)。

## 协议备忘

16 字节大端头(u32 包长 / u16 头长 / u16 版本 / u32 op / u32 seq);op:2 心跳、3 心跳回执(body=u32 人气)、5 MESSAGE、7 认证、8 认证回执;ver:0 JSON、1 数值、2 zlib、3 brotli(压缩容器内嵌套子包,解开后展平)。**op5 实测存在 ver=0 未压缩帧**;认证包 `{uid, roomid, protover:3, platform:"web", type:2, key, buvid}`,`buvid` 为空串时省略该键;30s 心跳。

## fixture 与脚本

- `src/__tests__/fixtures/frames.json` / `payloads.json`:自录真帧(capture 脚本,只读登录态)。
- `src/__tests__/fixtures/payloads-ref.json`:取自 blive-message-listener 0.5.4 `mock/`(MIT,© ddiu8081)的真实匿名化 payload,覆盖自录蹲不到的稀罕事件。
- `scripts/capture-frames.ts` 录帧、`scripts/smoke-live.ts` 真机 60s 冒烟、`scripts/probe-login.ts` 登录态探针;跑法 `node --experimental-transform-types`。**只读铁律:任何脚本 loadCookies 绝不传 refreshToken**(会触发 cookie 轮换,短命进程不落盘 = 弄丢登录态)。
- 录帧蹲守:`BLIVE_WATCH_CMDS=USER_TOAST_MSG,USER_TOAST_MSG_V2,GUARD_BUY` 逗号分隔 —— 录到匹配命令立刻终端播报完整 payload,长录蹲稀罕帧(上舰续费之类)不用盯文件;播报是旁路,不影响录制。
- `scripts/pb-walk.ts` protobuf wire 走查器:不依赖任何 schema 直接按 wire format 走查字段号/类型/值,手裁 proto(SEND_GIFT_V2 / INTERACT_WORD_V2)怀疑漂移时拿真帧对账用。
