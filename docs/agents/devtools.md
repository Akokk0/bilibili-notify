# 开发者工具(devtools)

很多功能的触发条件很苛刻(UP 得真开播、动态得真发、更新得真发版),没法坐等。devtools
把这些**造出来**:一半是造状态(换掉面板看到的那份),一半是造事件(整条链路真跑)。

## 门

- **服务端**:载荷版本号是开发版(`0.0.0-dev` / `dev`,`update/version-order.ts` 的
  `isDevBuild`)才组装(`devtools/index.ts` 的 `createDevtools` 回 null 就什么都不挂),
  `/api/dev` 不挂载、404。**alpha 也不给** —— 那是发出去给人用的构建。
- **面板**:`App.tsx` 里 `import.meta.env.DEV ? lazy(() => import("./devtools/dock")) : null`,
  生产 bundle 连这个 chunk 都没有;`apps/web/src/__tests__/devtools-isolation.test.ts` 钉着
  「`src/devtools/` 只有那一处引」。面板探 `GET /api/dev`,404 就整个不出现(面板跑 dev、
  后端连着正式镜像时就是这样)。
- **不用环境变量**:环境变量能在生产镜像里被设上,版本号不能。

## 形态

左下角玻璃药丸(`DockPill`,与右下 AI 胶囊同基线)+ 底边升起的整宽面板(`DockPanel`,
拖顶边改高、记在 localStorage、ESC 收)。两件都在 `packages/ui`,走 `z-bn-dock`(45)。
左栏五组:事件 / 状态 / 定时 / 截流 / 前端;顶部「当前生效」条一键收摊。药丸上的快捷位只给
最常按的五个(更新 / 截流 / 开播 / 下播 / 发动态),按默认值跑。

## 注册表:两半合一份

声明类型在 `apps/contract/src/devtools.ts`(`DevScenario`:id / group / title / desc /
params / quick / icon)。参数 **schema 驱动**,六种字段:`sub` / `target` / `adapter`(面板画
选择器,值是 id,留空 = 服务端默认)、`number` / `enum` / `text`(自带默认值)。

- 服务端那半:`apps/server/src/devtools/scenarios/*.ts`,经 `createDevRegistry` 汇总,
  `/api/dev` 列举 / 跑 / 收摊(`routes/dev.ts`)。注册表补默认值、拦越界、汇总各场景的
  `active()`;场景做什么归各自的 `run`。
- 前端那半:`apps/web/src/devtools/web-scenarios.ts`,同形状,`run` 在浏览器里跑(涌 toast、
  不可达壳、灵动岛、新手指引步)。面板把两张表并成一张(`mergeScenarios`),撞 id 直接炸。

加一个场景 = 写一个 `DevScenarioDef` 塞进 `createDevtools` 那张表,面板一行不改。

## 注入高度:既有边界上套装饰器,引擎一行不动

| 要造什么 | 装饰在哪 | 文件 |
| --- | --- | --- |
| 更新 9 相 8 归因 | 包 `UpdateService`,只换 `getStatus()` 的 `state`;**真动作不清注入**(面板每次打开都自动 check,清了刷新一下就没了),只在面板收摊 | `update-injection.ts` |
| 推送截流 | 包每个 `PlatformAdapter.send`:开着就不真发、记摘要、回 ok;历史照记 delivered 不打标,面板列表是对照,`purge-history` 按截流时间窗删行(`HistoryStore.deleteRange`) | `capture.ts` |
| 开播 / 下播 / 弹幕 / SC / 上舰 / 礼物 / 进场 | blive 的 `observeLiveConnections` 观察钩子拿到房间的 `emit`,与真帧同一条回调;假直播期间 `getLiveRoomInfo` 对那个房间打补丁(live_status=1、live_time=现在) | `live-rooms.ts`、`scenarios/live*.ts` |
| 四类动态 | 传给引擎的 `api` 套 Proxy(`api-overrides.ts`,按方法名盖、`this` 绑回真对象),`getAllDynamic` 结果最前并进假动态,`DynamicEngine.detectNow()` 立刻跑一轮,跑完撤 | `scenarios/dynamic.ts` |
| 私聊指令 / 群链接 | 直接调接线层的两个入站口(与 adapter 收到真帧后调的是同一个函数) | `scenarios/inbound.ts` |
| 引擎错误 / 登录失效 / 恢复 | 直接 `bus.emit`(发射不是转发,不碰 MessageBus 铁律);auth-lost 会**真的**停引擎,看完记得 restored | `scenarios/bus-events.ts` |
| 扫码登录六态 | 盖 `authSystem.status()` + 总线发同一份 `login-status-report`;假二维码是手拼的 PNG | `scenarios/login-state.ts`、`fake-qr.ts` |
| 适配器能力三态 | 包 `capabilities` / `probeCapabilities`(只对有能力概念的平台) | `capability-injection.ts` |
| 免扰 / 静音 | 免扰:`BilibiliPush.quietHoursNow` 单点时钟(**不是假时钟**);静音:真调 `muteFor` | `clock.ts`、`scenarios/timers.ts` |
| 「现在就跑」 | 各引擎 / 运行时自己暴露的一个口:`closeIdleNow` / `repushNow` / `detectNow` / `pollNow` / `healthCheckNow` | 同上 |

副作用规矩:**默认真发,可截流**。造事件之前先开截流,推送就只进列表不出网。

## 面板那半的两个坑

- react-query 的 `refetchInterval` 窗口失焦就停;人盯着终端 / 聊天软件时面板恰好在后台,
  所以 devtools 的查询都开了 `refetchIntervalInBackground`。
- 跑完一个场景把**所有**查询作废(连 `/api/dev` 自己),造出来的状态经各页自己的查询才看得见,
  逐个列 key 的话新场景必漏。

## 真机验过 / 没验过(2026-09-06)

验过:更新状态(系统页 / 概览卡 / 刷新后「有新版」通知卡)、截流 + 清历史行、假开播 → 开播卡 →
60 条弹幕 → 下播卡 + 词云 + AI 总结、假图文动态 → 卡片 + 点评 + 图集、`/help` 回复、群链接
回卡、假二维码弹窗、engine-error 进主人私聊、能力 supported、四个「现在就跑」、涌 toast、
灵动岛保存中。没验过:免扰时钟(主人配置里 quietHours 为空,单测覆盖)、Chrome 空闲关
(当时浏览器没起)、新手指引步(导览关着)、Windows。
