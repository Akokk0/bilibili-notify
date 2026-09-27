# 1.0 数据代与迁移

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023。

数据目录怎么分代、代里放什么、开机怎么迁、回退与重迁、全新开始、旧代清理、图库与素材库、跨代共享的宿主件。文件里装的**形状**见 [data-model.md](./data-model.md)；这份只管文件**放在哪、怎么搬**。

## 一句话

**每次改数据格式的升级，在 `<dataDir>` 下开一个新的「代」，旧代原样留着就是备份。** 开机选「schema ≤ 我」的最新一代，回退不需要还原；「全新开始」就是开一个空代。崩溃恢复只有一套写法。

## 为什么是数据代

三条硬事实限制了能怎么改：

- **桌面壳和 `boot.mjs` 是冻住的**，不随应用内更新替换：载荷目录只能在 `<dataDir>/versions`；桌面壳 30 秒没就绪就杀进程，连续 3 次把这一版判死。
- **自愈会无条件退回镜像 / 安装包自带的版本**：1.0 起不来就跑回 0.12，0.12 必须还能读自己的数据。
- **用户会主动回退**。已发出去的 0.x 之间回退报错这类问题修不了，但 1.0 往后不能再犯。

「写新目录」「迁移前备份」「全新开始挪到一边」原本是三套各管一段的写法，收成一种机制。复用应用内更新现成的版本目录、比版本、保留规则（version-dirs / compareVersions / prune）。代码里把 dataDir 拆成「宿主根」与「数据根」两个名字，versions-root 的对拍测试跟着扩。

## 目录布局

```
<dataDir>/
├─ versions/            载荷版本 + boot-state.json + manifest-freshness.json；冻住的 boot.mjs 认这里，不分代
├─ logs/                日志跨代连续；冻住的桌面壳写死了这里，行格式冻结
├─ （0.x 旧文件）       第 0 代：原样不动，只作迁移输入
└─ <代>/
   ├─ generation.json   schema 版本、lastActiveAt
   ├─ config/           settings.json  subscriptions.json  connections.json  targets.json
   ├─ secrets/          master.key  kdf.salt  config-secrets.enc  bilibili/cookies.enc  extensions/<id>/
   ├─ runtime/          subscription-state.json  roast-drafts.json  card-bg-cursors.json
   │                    bilibili/state.json  extensions/<id>/state.json
   ├─ history/          <日>.jsonl  repush/<日>/
   ├─ images/           <sha256>.<ext>  统一图库
   ├─ stats/            posts/  live/  followers/  seen/  since
   ├─ ai/               conversations/  attachments/
   ├─ skins/            card/<id>/  panel/<id>/  panel/active.json
   ├─ library/          images/  fonts/  index.json
   ├─ maid-skills/      <name>/SKILL.md
   └─ extensions/       已装拓展包 + load-state.json
```

布局原则：

- **小状态按性质分**：`config/` 放主人填的；`secrets/` 放密钥；`runtime/` 放程序自己记的，丢了只退化。
- **第二层按归属**：内置 B 站就叫 `bilibili/`，拓展在 `extensions/<id>/`。不设 `sources/` 这一层——内置来源只会有 B 站一个；拓展 id 就算叫 `bilibili`，落在 `extensions/` 下也撞不上。
- **大块内容按领域分**：`history/`、`stats/`、`ai/`、`skins/`、`library/`、`images/`、`maid-skills/`、`extensions/`。已装的拓展包跟着代走，回退时拿回旧版拓展。
- **跨代共享的一律冻结格式**。
- 代目录的具体名字施工时定。

## 逐目录

备份是**逻辑导出**（从内存读配置各节，完整备份再把密钥装进 PIN 密钥袋），不是拷目录。「进备份」指内容有没有被导出。

| 位置 | 装什么 | 进备份 | 保留期 | 全新开始 | 迁移 |
| --- | --- | --- | --- | --- | --- |
| `config/` | 设置（core / bilibili / extensions 三类段）、订阅（一个文件）、连接、目标 | 是（各节） | 无 | 清 | 变换：globals 分段、订阅两文件合一 |
| `secrets/master.key` · `kdf.salt` | 主密钥 / 口令派生盐 | 否（本机专用） | 无 | 新生成 | 逐字节拷，两代必须相同，否则彼此密文解不开 |
| `secrets/config-secrets.enc` | AI 各家 apiKey | 仅完整备份 | 无 | 清 | 原样拷 |
| `secrets/bilibili/cookies.enc` | B 站登录态（经 B 站的 `ctx.secrets`） | 仅完整备份 | 无 | 清 | 由 `cookies.json` 转来；重迁时取两代较新的 |
| `secrets/extensions/<id>/` | 拓展的 `ctx.secrets` | 仅完整备份（普通备份抹掉） | 卸载清 | 清 | 原样拷 |
| `runtime/subscription-state.json` | 资料缓存 + 问题表（`problems` 按 code），按订阅 id；存储叫 `SubscriptionStateStore` | 否 | 删订阅即删 | 清 | 变换，见迁移表 |
| `runtime/roast-drafts.json` | 待主人审批的锐评稿 | 否 | 48 小时 | 清 | 变换（老 uid 草稿改订阅 id） |
| `runtime/card-bg-cursors.json` | 直播封面轮换游标 | 否 | 无 | 清 | 从根目录搬进来 |
| `runtime/bilibili/state.json` · `extensions/<id>/state.json` | 来源的 `ctx.state` | 否 | 卸载清 | 清 | B 站那份由 sub-runtime 的 `roomId` / `followed` / `followError` 拆出 |
| `history/` | 推送历史行、重推原件 | 否 | `core.history.retentionDays`（默认 30） | 清 | 行变换，图与头像快照换成图库引用 |
| `images/` | 作品图、直播封面、头像、历史快照 | 否 | 按引用清扫 | 清 | 原 `avatars/` 与 `history/img/` 按 sha256 改名并进来 |
| `stats/` | 作品、直播场次、粉丝时序、seen、水位线 | 否 | 无（删订阅才删） | 清 | 变换；追加写的文件一律复制 |
| `ai/` | 女仆对话、对话附件 | 否 | 对话上限与空会话回收 | 清 | 对话变换（剥皮肤引用），附件硬链接 |
| `skins/card/` | 卡片皮肤 | 否 | 无 | 清 | **不迁**，指针回默认 |
| `skins/panel/` · `library/` · `maid-skills/` | 界面皮肤、素材、女仆技能 | 否 | 无 | 清 | 拷 / 硬链接；技能 `allowedTools` 按新工具名变换 |
| `extensions/` | 已装拓展包、连败记账 | 否（设置随 config） | 无 | 清 | 拷；devtools 软链重建不拷；v2 拓展列进首访页 |

- 备份里订阅只有一节，备份 schema 抬版。
- **1.0 之前的备份拒收**：信封改成比自己新、比自己旧的都拒，提示「这是 1.0 之前的备份：先装 0.12 恢复，再升级到 1.0 走迁移」。

## 开机顺序

1. **先 listen**：起 HTTP，健康检查立刻返回，这次开机算成功——避开桌面壳 30 秒就绪超时与 3 次判死。
2. 选代：「schema ≤ 我」的最新一代；检查回退指纹（见「回退与重迁」）。
3. 需要迁移就**在同一进程全量迁移**。新代先写成 `<代>.partial`，完成后原子改名；中途被杀，下次开机删掉半截重来。
4. 迁完才起引擎。迁移期间面板显示「正在搬家」进度，**不推送**。

被否的备选：分两段迁（小文件先迁，大块内容 listen 之后接着跑）——同一个文件两头同时写、要写合并逻辑，还有一段「数据不全」的状态。

代价：1.0 第一次开机推送会停一会儿；图多、盘慢时可能几分钟。

## 迁移步骤

迁移模块只跑一次：旧格式的知识只住在这里，1.0 的新 schema 不留兼容分支，之后的版本可以整个删掉这个模块。除卡片皮肤外全部迁。

**第 0 步：收编 0.x 兼容代码**，原样跑现有的 0.x 升级链，所以输入可以是任意 0.x 版本。它们大多已是 raw → raw 的纯函数，老测试搬成迁移模块的夹具（约 59 个文件）：各 schema 的 preprocess、`migration.ts`（连接 / 目标 v1 → v2）、`migrateLegacyTargets` 与 `adapters.json`、apiKey 明文迁出、history 读时映射、锐评老 uid 草稿、统计读时翻译、`migrate-file-keys`。

**第 1 步：1.0 改名表。**

| 什么 | 怎么迁 |
| --- | --- |
| `state/globals.json` | 拆进 `config/settings.json`，按「`defaults` 只是按订阅覆盖的回退层」归位（见 [data-model.md](./data-model.md)「配置」）：`dynamicCron` / `userAgent` 进 `bilibili` 段，`healthCheckMinutes` → `bilibili.loginCheckIntervalMinutes`；`app` 拆成 `core.logging` / `core.history` / `core.timezone`；`fansCron` 原值 → `core.profileRefreshCron`；`defaults.ai` 的实例桶、搜索、聊天 → `core.ai`，订阅能覆盖的人格预设留 `defaults.ai.presetId`；`templateDefaultsSeen` → `core.templatesSeen`；全局 `roastSchedule` → `core.rankingReport`；`templates.wordcloudStopWords` → `defaults.wordcloud.stopWords`；`schedule` 解散（`quietHours` 进 defaults，`liveEndGrace` 进 `defaults.liveEnd.grace`）；`mutedUntil` → `muteEndsAt`（ISO，为 0 就缺键）；`master.targetId` 指向群目标的清空、首访页提示重选；`accounts.order` 按登记顺序填；拓展设置进 `extensions.<id>`。⚠️ 原先写的「`installedAt` 转 ISO」在 globals 里查无此字段，施工时查清指的是什么或删掉 |
| 特性键 `dynamic` / `atAllDynamic` / `liveGuardBuy`（订阅路由、全局开关、历史） | `post` / `atAllPost` / `membership` |
| 直播拆键 | `routing.live` 复制给 `liveStart` 与 `liveStreaming`；`liveStart` 开关沿用 `live`；`liveStreaming` = 原 `live` 开着且 `pushTime > 0`，间隔用原 `pushTime`；`pushTime` 为 0 的 `liveStreaming` 关、间隔填 1 小时；`restartPush` → `liveStart.catchUpOnBoot`；`atAllLive` → `atAllLiveStart`；`templates.liveOngoing` → `templates.liveStreaming`。每条订阅按合并后的值算，只有和全局不同的才写进 overrides |
| 以特性键 / 卡种 / 附加项 / 模块名做键的配置：`messageLayout.dynamic`（必填键）、`cardStyleByKind` 的 `dynamic` / `sc` / `guard`（裸 object，不迁会被悄悄剥掉）、逐目标 extras 的 `atAllDynamic` / `atAllLive`、`overrides.features.extras`、`app.logLevels` | 按改名对照改键；`cardStyleByKind` → `defaults.cards.byKind`；订阅顶层 `extras` → `extraTargets`；`logLevels` → `core.logging.levels`，`dynamic` / `live` 并成 `bilibili` |
| 文案 `templates.dynamic` / `dynamicVideo`（全局与逐订阅）、`templateDefaultsSeen` | `templates.post` / `postVideo`，值原样搬；账本随模板键换键，等于旧默认指纹的换成新默认指纹 |
| 直播 9 条文案里的 `-key`；人名变量 `{mname}` / `{mastername}` / `{uname}` | 按运行期同一套规则改写成 `{key}`；改成 `{name}` / `{name}` / `{viewer}` |
| `templates.guardBuy.{captain,commander,governor}`、`minGuardLevel` | `templates.membership.guard`：`enabled` 取旧 `enable`，`tiers` 取旧三档、key 不变，`default` 留空；`minGuardLevel` → `defaults.membership.minRank.guard`，换算反过来（1 ↔ 3，旧值 1 = 总督） |
| 过滤与阈值：`blockForward` / `blockArticle` / `blockDraw` / `blockAv`、`whitelistKeywords` / `whitelistRegex`、`minScPrice`、特别关注的 uid | `blockReposts` / `blockArticles` / `blockImages` / `blockVideos`、`allowKeywords` / `allowRegex`、`defaults.superchat.minAmount`；特别关注转成 `{ id, note? }` 进公共订阅形状 |
| `imageGroup`（全局与逐订阅） | 形状不变，子键 `forward` → `mergeForward`，`enable` → `enabled` |
| `cardStyle`（`enabled`、`liveCoverImages`、退役的 `font` / `fontAsset` / `glass*`） | `defaults.cards{ enabled, liveCoverImageIds }`，退役字段丢掉 |
| AI 配置 `dynamicPrompt`、`presets[].dynamicPrompt`、`search.engines`、`providers` / `activeProfile`、`activePreset` 与 `overrides.ai.preset`、`enableThinking` + `thinkingLevel`、`enableVision`、顶层 `persona` / 提示词 | `postPrompt`、`presets[].postPrompt`、`search.scenes`（子键 `dynamic` → `post`）、`profiles` / `activeProfileId`、`presetId`、`thinking{ enabled, level }`、`hasVision`；顶层人格与提示词收进 `presets`（必填 / 带默认值，漏迁就开不了机或悄悄关掉联网搜索） |
| 订阅两个文件 | 合成 `config/subscriptions.json`，行写成 `identity: { sourceKey, externalId }`（B 站的 uid 就是 externalId）；别名 `name` 丢弃；指向老卡片皮肤的指针回默认、失效 id 的旋钮删掉、指向内置皮肤的照留 |
| `state/sub-runtime.json` | 改名 `runtime/subscription-state.json`；`roomId` / `followed` / `followError` 搬进 `runtime/bilibili/state.json`；`followed === false` 另转成 `problems.follow_failed`；`fansBaseline` 丢弃；缓存资料的 `sign` → `bio`、`avatar` 换成图库引用、空串当缺键 |
| 密钥 | `master.key` / `kdf.salt` 逐字节拷；`cookies.json` → `secrets/bilibili/cookies.enc` |
| bootstrap（`bn.config.yaml`、环境变量、命令行） | 不迁：在用户自己的文件里。`cookieEncryptionKey` / `BN_COOKIE_KEY` / `--cookie-key` 改中立名（新名施工时定），`chromeIdleSeconds` 及其 env / CLI 改 `…Sec`，旧名都永远继续认；`cookieEncryptionKey` 新旧同时设且值不同就拒绝启动；`preset.pushTargets` 读到就忽略。冻住的桌面壳放行的 5 个环境变量、镜像写死的 5 个永不改名 |
| 连接与目标 | `testStatus` → `probeStatus`；OneBot 的 `transport` 丢弃（由 connector 推出）；endpoint 目标的 `scope` 丢弃；`retryTimes` → `maxRetries`、`forwardMinTimeoutMs` → `mergeForwardMinTimeoutMs` |
| 历史行与重推原件 | 行带 `identity`；`unameSnapshot` / `uavatarSnapshot` → `nameSnapshot` / `avatarSnapshot`；`ts` → `createdAt`；推送种类那格 `kind` → `feature`，值 `dynamic` → `post`、`live` → `liveStart`、`live-ongoing` → `liveStreaming`、`live-end` → `liveEnd`、`guard` → `membership`、`sc` → `superchat`、`special-danmaku` → `specialDanmaku`、`special-enter` → `specialUserEnter`；`retryOf` → `repushOf`；原件（`Draft` → `RepushOriginal`，`v` → `version`、`own` → `isOwnCopy`）里的 `forward` 布尔、miniapp 的 `desc`、自存图换新名与摘要引用 |
| 图：`history/img/` 与 `avatars/` | 都进代内 `images/`，按 sha256 改名后硬链接到旧文件；历史行、重推原件、资料缓存里的引用同步换成摘要 |
| 统计与粉丝 | `stats/dyn` → `stats/posts`（`video` → `post` + `hasVideo`，老的 `type: DYNAMIC_TYPE_*` 行同样改写，开播公告行不搬）；根目录 `fans/` → `stats/followers`；`<uid>.jsonl` → `<订阅 id>.jsonl`；直播帧 `{ k, ts, peak }` → `{ type, occurredAt, peakTotalViewers }`，peak 的「1.2万」转精确数；场次 `peakViewers` → `peakTotalViewers`；粉丝样本 `value` → `followers`；`ts` → `publishedAt` / `sampledAt`；从 B 站老粉丝样本每天补一条 seen，老热力图显示不变 |
| AI 对话 | `ai/chat` → `ai/conversations`，`assets/chat` → `ai/attachments`；消息上的卡片皮肤引用去掉、对话文字全部保留；皮肤账本清空 |
| 皮肤、素材、技能、拓展 | 卡片皮肤不迁；`skins/` → `skins/panel/` 原样拷；`assets/card-bg`、`assets/font` → `library/images`、`library/fonts`；`maid-skills` 拷、`allowedTools` 变换；`extensions/` 拷、devtools 软链重建、v2 拓展列进首访页 |
| 遗留物：`state/adapters.json`、`*.json.bak`、`*.restore.bak`、`*.tmp.*`、`.staging-*`、`*.migrating`、storage 默认路径 `bilibili-notify/` | 只作输入读一次或丢弃，不进新代 |

**链接与复制**：迁移时任何链接失败都回落复制（不只是跨分区）。追加写的 jsonl 一律复制、不做硬链接——否则新版往里追加会改到旧代的文件。

**守卫**：以 FeatureKey / CardKind / ExtraKey 做键的记录全部钉进迁移清单；全仓对数据根的 `join(dataDir, …)` 前缀都必须在上面的目录表里。漏一个就红。另有一条迁移耗时测试，用 365 天合成数据跑。

### 首访询问页

主人迁移后第一次打开面板时弹一页：

- 说明旧数据已经迁好、老卡片皮肤要重新生成、旧数据留着当备份；
- 列出「因契约版本不收」的拓展，给一键更新；
- 问要不要「全新开始」。

## 回退与重迁

**谁最后在用，就以谁为准。**

- 每代在 `generation.json` 记 `lastActiveAt`。
- 0.x 的根目录没法改代码：迁移时记下关键文件的修改时间与大小，当作**指纹**。
- 开机发现旧代在新代之后又被用过（`lastActiveAt` 更新，或第 0 代指纹变了）→ 从旧代重迁、开新代；被替下的那一代挪到一边，不删。
- 新版在回退之前产生的那段数据不带过来，面板说清；cookie 与订阅跟回来。

被否的备选：两代合并。订阅、历史、统计要各写一套合并规则，还有两边都改过同一份数据的冲突。

**0.x → 1.0 这一次**：旧文件一个都不改、不删，它本身就是第 0 代。1.0 连续起不来时自愈会无条件退回自带的那版，主人点回退也会回到 0.x；两种情况下 0.x 读到的都是自己原来的文件。已知限制：「0.12 退回 0.11 报错」这类问题，已发出的 0.x 修不了。

## 全新开始

- 开一个空代：B 站重扫、token 与 AI key 重填、回新手引导；来源的 `ctx.state` 与 `ctx.secrets` 一并清空。
- **不碰 `bn.config.yaml` 与环境变量**，面板账号保留。理由：面板账号只在 bootstrap 配置或环境变量里；清掉的话监听 0.0.0.0 的 Docker 会拒绝启动，环境变量里的账号也根本清不掉。
- 被否的备选：用环境变量控制迁移——自动更新的 Docker 不会有人去设。

## 旧代清理

**不自动删**，旧代就是备份，删备份得主人点头。

| 代 | 规矩 |
| --- | --- |
| 当前代 | 永远留 |
| 上一代 | 默认留，迁移满 30 天才许清 |
| 更早的 | 列为「可清理」 |
| 第 0 代 | 按写死的白名单删；`versions/`、`logs/` 永不碰 |

系统页「旧版本数据」显示每代的版本、最后使用时间、大小与清理按钮；确认框写明清后回退不到那个版本。代价：磁盘会涨，直到主人手动清。

## 图库

- 所有图按内容摘要存成 `images/<sha256>.<ext>`：作品图、直播封面、头像、历史快照都引用它。取消 `runtime/avatars/` 与 `history/img/`。
- 入口只有两个：`ctx.fetchImage`（拦内网地址、单张 8MB、嗅探格式、超时）与 `ctx.storeImage`（手里已是字节的，同一套嗅探与 8MB）；上报一律只收 `ImageRef`。
- 清扫：保留期清理那一趟按引用全局清扫，引用方含历史行、重推原件、资料缓存。
- 出图器只内联引用、不联网；面板一律走同源地址。

## 素材库与皮肤

- **素材库 `library/`** 只收主人主动上传、反复挑选的图与字体（卡片旋钮、直播封面）。接口 `/api/library` + 通用素材选择器，**删前查引用**。
- 对话附件留 `ai/`、皮肤包自带的资产留在包内——它们随对话或皮肤包一起生死，进库只会塞满一次性的东西。三者共用一份资产存储实现 `createAssetStore`（参数：目录、id 取法随机或 sha256、允许的格式、大小上限）。
- **皮肤**：卡片与界面皮肤合目录（`skins/card/`、`skins/panel/`）、合存储代码（`createSkinStore<清单>`），不合概念——清单、「用哪套」的指针、渲染各走各的。

## 持久化底层与关停

所有存储都收到三件东西上，挂在已有的件上、不另开一套：

1. **原子写**（`packages/storage`，正本是 `atomicWriteJson`）：临时文件统一命名，写完 fsync 文件与目录，失败删临时文件，可选文件权限；读到坏文件先改名成 `.corrupt-<时刻>` 隔离（配置文件仍开机报错）；开机清掉上个进程留下的临时文件。
2. **写道** = internal 的 `createSerialQueue` 加 `flush` 与关门：按键串行，支持单一全局键（历史的全局串行是刻意的）；关门后的写入直接拒绝、不碰盘。
3. **后台任务登记** = ServiceContext 加 `track(promise)` 与分阶段的 onDispose：「发出去不管」的写入改成登记在案、能被取消。

关停顺序（服务端预算 8 秒，给桌面壳与 Docker 默认的 10 秒留余量；compose 样例写上 `stop_grace_period`）：

```
停生产者（来源 · 拓展 · 定时）→ HTTP 排空（2–3 秒）→ 等后台任务 → 统计补下播帧 → 各写道 flush 并关门 → 其余收尾
```

顺带修掉：cookie、会话、card-bg-cursors、字体清单不是原子写；审批草稿「先删后发」在关停时会丢；日志关停时刷不干净；对话附件孤儿泄漏；恢复备份的事务不完整（cookie 在回滚范围外、崩溃后不回收 `.restore.bak`、overwrite 会不可逆地级联删掉统计 / 粉丝 / 头像）。

守卫：服务端除了持久化底层不许直接写文件；服务关停返回以后数据目录不再变化。

**正常关停的通知路**：外壳起服务端时把 stdin 接成管道、退出时关掉它，服务端听到 stdin 关闭走和 SIGTERM 同一套收尾，超时硬杀不变。只在外壳设了开关变量（如 `BN_STDIN_SHUTDOWN=1`）时才听，和 `BN_PARENT_PID` 同一个做法，两者并进「宿主看护」模块。这套托管规矩写进托管文档，桌面版和以后的插件照同一份。注意：桌面壳不随应用内更新替换，只对重装了新安装包的用户生效。

## 宿主件与冻结格式

| 件 | 位置 | 为什么不分代 | 冻结什么 |
| --- | --- | --- | --- |
| 载荷版本 | `versions/<semver>/` | 冻住的 `boot.mjs` 从 dataDir 推算这里 | 目录布局 |
| 选版状态 | `versions/boot-state.json`、`versions/manifest-freshness.json` | 同上 | 文件格式 |
| 日志 | `logs/<日>.jsonl` | 冻住的桌面壳写死了这里；日志要跨代连续 | 行格式（`msg`、`ts`…）不改名，否则回退后显示错乱 |

- 日志落盘前按当前全部密钥的实际值脱敏（`ctx.secrets`、`secret: true` 字段、各来源用 `ctx.redact` 登记的临时凭据）；写死的 cookie 名正则删掉；来源名（`bilibili` 或拓展 id）在已有的 `name` 字段里。
- `docs/agents/self-update.md` 在收尾期补写数据代、开机顺序、回退后再升级，以及 0.x → 1.0 这一次旧文件保持原样。
