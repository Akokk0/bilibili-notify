# 1.0 施工计划

> 施工参考，未定稿。施工中可能推翻或修改，以代码为准；1.0 完工后定稿并入 docs/agents/。决策与理由见 ADR-0021 / 0022 / 0023，以及 ADR-0024 ～ 0031。

分几期、每期做什么、期间守什么规矩、中立性守卫哪一期开哪一期清零、第 1 期怎么切片、分支怎么走、alpha 怎么发，以及还没进表的零碎施工项、施工中顺手修的现存毛病和以后再说的事。要做成什么样见 [architecture.md](./architecture.md)、[data-model.md](./data-model.md)、[data-and-migration.md](./data-and-migration.md)、[subscription-sources.md](./subscription-sources.md)、[extension-contract.md](./extension-contract.md)、[push.md](./push.md)。

## 一句话

**在 `dev-next` 上一期一期做，每期全量门禁全绿才进下一期；先发 1.0 alpha，稳定后升到 1.0.0。**

## 纪律

- **不整体重写，以改造为主**（ADR-0021 决策 58）：某个模块的核心逻辑从头到尾是 B 站的形状、改造要动每一行时，才对着中立接口局部重写，旧测试当规格书；其余一律改造。分期表「方式」一列就是按这条判的；施工中逐模块按同一判据定，不另起整体重写。
- 每一片跑完整门禁再提交。
- 每期（3a、3b 分开算）全量门禁全绿才进下一期。
- 3a 完成即检查点：B 站全经中立接口运行、行为不变；守卫 21b「进程内中立性对拍」绿。
- 中立性守卫分三层（咽喉、静态扫描、对拍，ADR-0021 决策 59；判据与范围见 architecture「守卫」），每一道哪一期开、哪一期清零见下面「中立性守卫的归期」。棘轮守卫的规矩：开启那一刻记下命中数当上限，只许少不许多，多一处就红，上限随清理调低，到它清零的那一期结束必须是 0（不能「一开就红」：每期都得全绿才出期）。
- 哪一期改了盘上形状，就在同一期往迁移模块加条目、钉进守卫 13 的清单；不留到最后统一补。第 1 期只建迁移地基。
- 新写或重写的代码直接用新名，第 5 期只清扫没被动到的旧名。
- 新写或重写的接口方法与路由，失败直接按 ADR-0026 的结果形状与标准码写。

## 分期

规模以「④′ 轮」计（④′：约 5 小时、26 个提交、116 个文件）。原估 12–14 轮，第二轮拷问加了数据代、接口拆分与命名批，第三轮又加了推送侧中立化、集成与三层守卫，总量施工时重估，不含真机验收。

| 期 | 做什么 | 方式 | 出期条件 | 规模（④′ 轮） |
| --- | --- | --- | --- | --- |
| 0 ✅ | 测试拦外网（守卫 2，`scripts/network-guard.mjs`） | 改造 | 已落 | 0.2 |
| 1 | 地基：身份、持久化底层与关停、资产与皮肤存储合一；**迁移地基**（数据代、先 listen 再迁、回退指纹、首访页、全新开始、订阅合一、设置分段）；迁移耗时测试。切片 ①–⑨ 见下 | 持久化局部重写，其余改造 | 迁移耗时测试绿 | 施工时重估 |
| 2 | 数据模型：作品卡与直播卡、**抽 `packages/http`**（请求客户端、cookie 罐、浏览器身份，从 B 站的实现里抽出，抽出去的直接按 naming.md 起名），抓图核心服务建在它上面（安全防护逐跳查重定向 + 图库）与图库引用、皮肤字段、特性键；新类型直接用新名。并入：`LiveCardInput` 人数只收精确数；`formatCount` 带符号变体、`formatAgo`、`formatDuration`（连删 `{time}` 兜底与 `getTimeDifference` 钩子）；卡种中文名收一份；出图字节门按「批准的像素差清单」裁决（ADR-0028 决策 2） | 出卡前半段局部重写 | 守卫 10 扩到五种卡、清单外的差异为零；出图器零联网绿 | 约 4（估于 `packages/http` 并入之前） |
| 3a | 接口先行：`SubscriptionSource` 与横切接口、登记表、`SourceContext`（建在 `IntegrationContext` 上：state / secrets / settings / http / report / fetchImage 挂上 ctx；`reportProblem` 进全在内存的问题表，ADR-0025 决策 11）；B 站四个包搬进 `bilibili/`（先纯搬、只改 import 路径；紧接着单独一个提交按 naming.md 改名，含词表、外部接口回应的起名、原字段名只留在回应上；再做中立化） 并实现，中立部分同时拆进 `posts/` 与 `live/`；`accounts/` 与 `bilibili/auth/`；设置坏了只停那一处（集成段只停那个集成，`core` 段逐格退默认）。推送侧：`PlatformAdapter` 接口与登记表（登记即 `start`）、OneBot / QQ 官方机器人 / webhook 作为内置适配器登记并带模板候选、`/api/adapters`、连接与目标的新形状（连接 `adapterKey` / `settings` / `platformSnapshot`，目标删 `platform`）与迁移条目、只有 `TargetDispatcher` 能发送（链接回复与指令回复改走 `sendToAddress`，`notifyMaster` 返回结果形状；咽喉 e2e 在本期就要驱动这几条路）。schema 标 `secret: true`、服务端按 `MaskedSecret` 下发。本期开的守卫见「中立性守卫的归期」 | 改造 | 检查点：B 站全经中立接口运行、行为不变；守卫 21b 绿 | 施工时重估 |
| 3b | 各块中立化：先 e2e 钉直播四种行为，把醒目留言 / 会员 / 特别弹幕 / 特别进场的装配从 `room-session.ts` 抽进 `live/`，再合场次引擎；直播监听的唯一判定；B 站改存 `WATCHED_CHANGE` 的 `num`；资料刷新；链接预览（ADR-0029）、指令（`CommandDef` 与通用的 `login [来源]`，ADR-0031）、AI 工具与女仆技能（ADR-0030）；DevtoolsProvider（场景 `DevScenarioDef`）与假桥搬家；拓展契约 v3（含推送侧加宽）、`pickPerId` 与索引规则；桥迁 v3 | 链接预览与指令重写，其余改造 | 守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫② 清零；守卫 21a、推送守卫③、模板变量可满足性、AI 工具与技能约束绿 | 施工时重估 |
| 4 | 面板按描述画：来源按 descriptor 渲染（面板只从描述符拿来源信息，ADR-0027 决策 5–7）、连接 / 目标表单、候选 / 扫码 / 地址控件、B 站设置 tab（含「换一个身份」按钮）、功能页指向拓展设置的入口、两种「设置不合法」态（连接的、集成的）、健康卡（**先出设计稿，主人认了再照稿写**）；账号排序、预览、问题框、日志筛选、密钥打码（统一密钥输入框）、素材库界面、旧版本数据清理界面；首页改用直播监听的唯一判定 | — | B 站替身清零 | 施工时重估 |
| 5 | 收尾：清扫剩余旧名、目录与文件名、测试归位、死代码、守卫补齐、托管文档与 docs/agents 同步；全仓包版本统一 `0.0.0-dev` | 机械活，一次做完 | 中文叫法棘轮清零 | 约 2 |
| 6 | alpha 配套：抖音拓展（`ctx.http` 的第一个拓展用户）；重议 Q76：`linkResolver` / `aiTools` 对拓展开不开，`commands` 只在抖音拓展真要自带指令时才议（`CommandProvider` 1.0 不造，见「以后再说」）；定桥的版本号；在 dev 上打 `v1.0.0-alpha.1` | — | — | 施工时重估 |

- 「方式」沿用最初分期表的施工指引：原第 3 期拆成 3a / 3b，链接预览与指令都在 3b；第 4、6 期没有对应的记录。
- 这些归期是 09-27 复核时补的，主人可调：第 2 期并入的格式函数与直播人数；3a 的中立部分同步拆分与密钥下发；3b 的装配抽出、监听判定与 `num`；第 4 期的首页判定与密钥输入框；第 5 期的包版本；以及下面「零碎施工项」整张表。
- 09-28 拍板的归期（ADR-0021 决策 60）已并进表：第 2 期的 `packages/http`；3a 的推送侧、`SourceContext` 的 `settings` 与 `http`、设置坏了只停那一处；3b 的契约 v3 推送侧加宽、桥迁 v3；第 4 期的按描述画与健康卡设计稿；第 6 期的 `ctx.http`。三层守卫的期次同日拍板，见下节。

## 中立性守卫的归期

判据与范围见 [architecture.md](./architecture.md)「守卫」；这里只写哪一期开、哪一期清零或必须绿。棘轮按「纪律」里那条规矩走。

| 期 | 开启 | 清零 / 必须绿 |
| --- | --- | --- |
| 1 | 切片 ④：事件载荷（总线事件载荷里不许有 `uid` 键、`Bili*` 类型、平台原始值的裸 string）、错误体的 `code` 只装 snake 字符串；切片 ⑥：守卫 12（连同解构与下标的读法）、B 站替身（棘轮） | — |
| 2 | 出图器零联网；守卫 10 扩到五种卡（直播、醒目留言、会员、词云、榜单），差异按「批准的像素差清单」裁决 | 两条都绿 |
| 3a | 咽喉三道：入口咽喉、出口咽喉、咽喉 e2e（逐条驱动全部发送路径，每条恰好一条截流记录、零外连）；守卫 1、17；守卫 11 修订版（边界匹配、词表自动生成、扫 contract；3a 开头以棘轮开）；uid 棘轮；`.platform` 决定棘轮（推送侧）；推送守卫①；推送守卫②（棘轮，词表同期加宽并扫 contract）；守卫 18 的保留 id 加上三个内置适配器的键 | 守卫 21b（进程内对拍）绿，即 3a 检查点 |
| 3b | 守卫 21a（契约层对拍）、推送守卫③（假适配器对拍）、模板变量可满足性、AI 工具与技能约束 | 守卫 11、uid 棘轮、`.platform` 决定棘轮、推送守卫② 清零 |
| 4 | 中文叫法棘轮 | B 站替身清零 |
| 5 | 守卫补齐 | 中文叫法棘轮清零 |
| 随各项 | 守卫 4 点名表补项（监听判定、身份索引、`displayNameOf`、`formatViewers`、作品文字的取段函数、叫法函数；禁面板自带路由键表）；守卫 19 在 PATCH 与发送时复检；守卫 13 补上重推原件的 `kind` | 随所在那一项 |
| 施工时定 | 类型名后缀（ADR-0023 决策 15，扫我们写的全部类型名） | 施工时定 |

## 第 1 期：地基与迁移地基

| 片 | 做什么 | 状态 |
| --- | --- | --- |
| ① | storage / internal 的持久化原语（见 data-and-migration「持久化底层与关停」） | ✅ 已落 |
| ② | 守卫 3 先红；29 个直接写盘的文件迁上原语；`createAssetStore` / `createSkinStore` 合一 | |
| ③ | ServiceContext `track()` + 分阶段 dispose + 8 秒关停 + 守卫 8 | |
| ④ | 契约骨架：统一错误体 `{ code, message }` / `{ ok: false, code, message }`（ADR-0026；`code` 取 internal 里唯一那张标准码表，可选的 `upstreamCode` 装平台数字码，现 `routes/subs.ts` 两处改掉）+ WS 事件表（载荷一律具名对象、类型从总线事件表推导）+ 事件载荷守卫；面板 `errorMessage` 收成只认一种；契约做实的其余部分随它走 | |
| ⑤ | 宿主根 / 数据根拆分 + 目录表（守卫 13 后半） | |
| ⑥ | 数据代、`.partial`、先 listen 再迁、第 0 步收编 0.x 升级链、订阅合一 + `Identity`、设置分段、身份唯一闸 + 守卫 9、守卫 12、B 站替身棘轮开 | |
| ⑦ | 回退指纹与重迁 | |
| ⑧ | 全新开始 + 首访页 API + 拒收 1.0 之前的备份 | |
| ⑨ | 迁移耗时测试（365 天合成数据） | |

- 契约骨架归第 1 期切片 ④（主人 09-27 拍板）；错误体的防撞规矩见 [architecture.md](./architecture.md)。
- 契约做实的其余部分随契约骨架走（moduleVersions 删 api / dynamic / live 要等这几个包在 3a 删掉，那一小项留到 3a）：`/api/health` 补进契约、moduleVersions 删掉 api / dynamic / live、面板把 contract 移进 `dependencies`。`/api/health` 按 ADR-0025 决策 12 拆成短版（只留 `status`、`version`、`startedAt`、`uptime`）与 `/api/health/details` 放在哪一期、moduleVersions 拆完以后去哪，施工时定。

### 切片 ② / ③ 的验收清单

第 1 期盘点出来的现状，不是主人逐条拍的；做完逐条确认修掉。另见 data-and-migration「持久化底层与关停」的「顺带修掉」。

② 写盘：

- 29 个非测试文件、151 处直接写盘，全部迁上原语。
- 不是原子写的重要文件：cookie、AI 会话、card-bg 游标、字体清单（另有读改写不加锁）、资产字节、repush 草稿、stats since、两个皮肤库直写在用目录的资产。
- 固定名 `.tmp` 并发互踩：key-manager、两个皮肤库、maid-skills。
- `update/durable-json.ts` 并进原语时注意：`boot.ts` 直接 import `select-version-for-boot`（它用 durable-json），所以这次改动会打进新载荷与新镜像里的选版代码；`boot-state.json` / `manifest-freshness.json` 在宿主根、格式冻结，改的只能是写法，不许动文件格式与位置。
- `bn.config.yaml` 两处写（`config/loader.ts` 的 `writeFileAtomic`，写首启动的种文件与迁移后的用户文件；`config/persist.ts`）也走原子写底层。守卫 3 的白名单只放 `config/persist.ts`，它可以改用 storage 的 `atomicWriteFile`（原子写字节，不碰 YAML 注释）；`loader.ts` 那处写进 ② 的迁移名单。

③ 关停：

- HTTP 排空排在第 9 步；顺序改成 data-and-migration「持久化底层与关停」那一条。
- 一个 try 包住全程，任一步抛错后面全跳（含 stats 收尾）。
- 没有总时限。
- 第二次 Ctrl-C 直接杀。
- 关停期日志 hook 被还原成 `undefined`。
- `api.stop` 不加 `refreshGeneration`。

## 分支与发 alpha

1. v0.12.0 之后的开发在 `dev-next`，1.0 在这上面做；`ci.yml` 已加上 dev-next。
2. dev 与 main 同步，只收小修。
3. dev 每有小修就合进 dev-next，保证 dev 始终是 dev-next 的祖先。
4. 发 alpha 时把 dev 快进到 dev-next，在 dev 上打 `v1.0.0-alpha.1`（发版流水线要求 tag 在 dev 上），全程不用 force。

代价：dev 上的每个小修都要往 dev-next 合一次；换来的是改造期间随时能从 dev 发 0.12.x 急修，不会连带发出 1.0 的活。

CLAUDE.md 与 `docs/agents/build-release.md` 的「分支」都还没提 dev-next，随第 5 期同步。

## alpha 之后、1.0.0 之前

| 项 | 怎么做 |
| --- | --- |
| 桥帧改名（09-27 拍板；alpha 不动）：`forward` → `mergeForward`、`desc` → `description`、`picUrl` → `imageUrl`、能力名 `forward` 同改、能力名 `miniapp-card` → 原生分享，一趟改完。09-28 加一格：群入站消息的 `miniAppCardLinks` 改成入站链接的来源标记（正文 / 普通卡 / 原生分享卡，ADR-0029 决策 2） | 按方向走两步，合起来三拍：① BN 先同时认入站 `miniAppCardLinks` 的新旧两种写法（入站字段两步反过来走：BN 先认、插件再改发，ADR-0029 决策 2）；② Koishi、AstrBot 薄插件发新版：认 BN 发的新旧两种名字，入站改发新写法；③ 等用户都升上去，BN 再改发新名字，桥的适配器里的新旧映射整个删掉。都要在 1.0.0 之前做完；插件只发一次版。`listAddressCandidates`、`connectionAuth` 对拓展开不开放同时看（见「以后再说」） |
| devtools 换 devframe（09-27 从「1.0 之后」提前） | 先做小试验：查清许可证与维护者，重新验证 devtools 不进生产产物（守卫 14 与构建后自检照旧）；试验过了再换 |
| 新手引导换 driver.js（09-27 从「1.0 之后」提前） | 先做小试验：验证引导锁（聚光灯外不能操作，⛔ 不许放开）、跨页面的步骤与晚挂上的锚点、能不能跟随界面皮肤；试验过了再换 |

## 零碎施工项

| 项 | 归期 |
| --- | --- |
| 拓展契约 v3：min 抬到 3，删 v1、v2 的退路（`legacy-v1.ts` 连同过时注释）；ctx 改成 `IntegrationContext` 加各自特有的一层，新增 `http`、`settings`，上报改 `void`、被拒记进 `reportRejections`；推送侧加宽到 `PlatformAdapterDef`（ADR-0024 决策 3，这一版不开的见决策 11）；`pickPerId` 改成「在当前 BN 装得了的版本里取最高」；索引规则放宽成「每个契约版本各留最新一条」；桥迁 v3，1.0 alpha 期间 v3 的桥只进预发布档 | 3b |
| 桥迁 v3 时必须抬 `extensions/bridge/extension.json` 的 `version`（现在 `0.0.1`，同号发出去市场永远不提示更新）；具体号发 alpha 时定 | 3b 抬号，6 定号 |
| 渲染器运行时从 `s1.hdslb.com` 拉舰长图标（`packages/image/src/image-renderer.ts` 的 `GUARD_LEVEL_IMG`），改成本地资产：B 站在 `bilibili/` 声明 `guard` 体系时用 `ctx.storeImage` 把三档图标存成 `tier.icon`，出图器只内联引用。守卫 11 的 `hdslb` 会在这里变红 | 3b |
| 补关注「-101 整批跳过、不降级」（已定未做，见 subscription-sources「B 站怎么实现」），随关注同步搬进 `bilibili/` | 3b |
| 直播监听的唯一判定（internal）：「开着」只看开关、不看有没有目标（ADR-0027 决策 1）；首页的「不会被监听」与直播就绪判断都改用它。已知 bug 就落在这条上（见「施工中顺手修」），别拖到最后 | 3b；首页在 4 |
| 密钥打码：schema 标 `secret: true`、服务端按 `MaskedSecret` 下发；面板那一半（统一密钥输入框） | 3a；面板在 4 |
| 原生分享：解析器交中立描述，由 OneBot 适配器去签。施工先查签名接口收不收通用参数，不收就在适配器内部放一张 appId → 预设的对照表（ADR-0029 决策 2） | 3b |
| 测试助手重复：scripts 6 处各算 repoRoot、internal 三份 BASE AI 夹具、面板 UpDialog 三份 renderDialog 与造目标、`extSub` 与 `makeExtSub` 重复、backup 两份 pickFile | 各区重写那期合并，没重写到的归 5 |
| knip 报的 3 个老的未使用文件（`devtools/stub.ts`、两个 shape-pin；knip 不在 CI） | 5 |
| `constants-imports.test.ts` 按行判，多行 `export {…} from "zod"` 会漏；`UpDialog.test.tsx` 没有 JSX，应是 `.ts`；network-guard 夹具路径写了两处 | 5（守卫补齐） |
| 全仓包版本统一 `0.0.0-dev`：剩 push、subscription、internal、image、ai、storage、extension 7 个包（api / blive / dynamic / live 在 3a 随包删掉；第 2 期新建的 `packages/http` 建时就用 `0.0.0-dev`）。⛔ 不做：extension 包版本对齐契约档位 + 守卫（兼容看清单 apiVersion 与 EXTENSION_API_RANGE，不看包版本） | 5 |
| 进程托管文档：孤儿自检、stdin 关停、数据目录与端口、载荷选版；桌面版和以后的插件照同一份 | 5 |
| `docs/agents/self-update.md`：数据代、开机顺序、回退后再升级，以及 0.x → 1.0 这一次旧文件保持原样 | 5 |
| 文档同步：CLAUDE.md 与 `docs/agents/` 的 push、architecture、commands、events、devtools、self-update、extension-marketplace；补上 `subscriptions.md`（整篇讲 B 站 / 拓展两支、两个文件、两种键，1.0 后全错）、`build-release.md`（没有 dev-next 与 alpha 的打法）与 CLAUDE.md 的「分支」一节；CLAUDE.md「项目」一节里「`CONNECTION_PLATFORMS` 不加档、拓展连接走 `kind: "extension"`」那条（闭集与 `kind` 都已删掉，ADR-0024）；示例 yaml 写清每个键对应的环境变量（ADR-0022 决策 14） | 5 |

### 还没归期的（施工时定）

ADR-0024 ～ 0031 里定了做什么、没定哪一期做的项。

| 项 | 备注 |
| --- | --- |
| 连接设置的校验：保存时适配器在场就按 `settingsSchema` 校验、不过回 400；读盘逐条校验，不过的只隔离那一条，只有外壳坏了才挡开机（ADR-0024 决策 10） | 最迟在第 4 期之前：面板的「设置不合法」态在第 4 期 |
| 投递失败归核心：按目标逐个投递、只重试失败的那个（`rate_limited` / `unavailable` / `timeout` 退避，`indeterminate` 与其他码不重试）；出卡或 AI 失败降级、不整条重来；每个目标一行历史，失败带 code（ADR-0024 决策 15） | |
| 删掉自定义 UA 设置，身份一律由 `packages/http` 生成；老配置里这一格由迁移丢掉、新 schema 不留（ADR-0025 决策 7） | 「换一个身份」按钮随第 4 期的 B 站设置 tab |
| 健康的服务端那半：`SourceHealth = { summary }`、`/api/health/details`、短版 `/api/health` 只留四格，应用内更新靠 `version` 与 `startedAt` 认新进程（ADR-0025 决策 12） | 健康卡界面在第 4 期，先出设计稿 |
| 历史里存的旧失败转成 `{ code: "unknown", message: 原话 }`；应用内更新的 `reason` 从 kebab 改 snake（ADR-0026 决策 3、5） | 迁移条目随改盘上形状的那一期 |
| ADR-0027 的服务端那半（唯一判定除外，它在 3b）：「在记」按特性分；开播公告不再记；统计多收现成字段、「最近作品小缓存」并进统计仓；历史接口删 `?uid=`；统计 CSV 的「UID」与「外部 ID」合成一列 | 面板那半在第 4 期 |
| 作品文字只有一种拼法：`posts/` 里唯一的取段函数（ADR-0028 决策 1） | 进守卫 4 的点名表 |
| 模板变量 `{guard}` → `{tier}`、`{mdn}` → `{fanclub}`，资料加 `fanClubName?`，迁移改写主人的文案（ADR-0028 决策 3） | 最迟 3b：模板变量可满足性守卫那期要绿 |
| 醒目留言加可选 `tier`、金额按币种排版；会员档加可选 `announcement`，皮肤字段 `membership.text` → `membership.announcement`（ADR-0028 决策 4） | |
| 类型名后缀守卫的开启期（ADR-0023 决策 15） | 见「中立性守卫的归期」 |

## 施工中顺手修

已查出的现存毛病，各归一期，随那一期的改动修掉。

| 毛病 | 期 | 怎么修掉 |
| --- | --- | --- |
| 面板的错误提示只认 `err` / `message` / `errors`，`{ error, scope, issues }`、`{ error, id }` 这些形状的原因全被吞掉（读代码得出，未真机验） | 1（切片 ④） | 错误体统一以后，`errorMessage` 只认 `code` + `message` 一种 |
| 搜人时风控与未登录都报成 404：`/api/subs/lookup` 把任何非 0 码都回成 `not_found`，还把 B 站的码塞在 `code` 里 | 1（切片 ④）挪码；3a 修分类 | 切片 ④ 先把 B 站的码挪进 `upstreamCode`；3a `searchCreators` 返回结果形状、路由合成 `GET /api/sources/:sourceKey/creators?q=`，风控回 `rate_limited`、未登录回 `unauthorized` |
| 拿登录二维码失败却回 `ok: true`：网络异常只打 warn 就返回、状态不变；其余抛错回 500 与一句固定英文，原因被吞 | 3a | 登录搬进 `bilibili/auth/`、走 `SourceAuth` 状态机时，`beginLogin` 按结果形状回失败 |
| 晚登记的适配器收不到对账：拓展的推送适配器在开机对账之后才登记，对账（今天的 `reconcile`）就调不到它 | 3a | 登记即 `start`（ADR-0024 决策 3） |
| AI 工具失败在面板上显示成功：工具失败时返回一段字符串，只有抛错才记失败 | 3b | AI 工具随 ADR-0030 改写时按结果形状返回 |
| 指令出错不回话：处理函数抛错只打 warn | 3b | `CommandDef.run` 返回结果形状；失败回「『{指令名}』没办成：{message}」，抛错回「出错了，详情在日志里」并记错误日志（ADR-0031 决策 1） |
| 开机关注同步改了 `followed` 却不发事件，面板不跟着变 | 3b | 关注同步搬进 `bilibili/`、`followed` 进 B 站的 `ctx.state`；补关注失败按 `follow_failed` 报进问题表，问题表变了发 `problems-changed` |
| 首页「不会被监听」只看有没有配直播推送目标，和服务端的判定对不上 | 3b 判定；首页在 4 | 见「零碎施工项」的直播监听唯一判定 |
| 没实现列 bot 方法的推送拓展建不了连接：列 bot 的接口回 404，面板说拓展没跑起来 | 4 | `listConnectionCandidates` 在 3a 改成必备；面板新建连接只走「挑一个候选 → 填字段」一条路 |
| 会员文案自定义开着、图片是空串时 `??` 不兜底官方图，推出 href 为空的图 | 2 | `templates.membership` 重做时修（`default` 的回退正好在这条路上） |

## 以后再说

1.0 不做、已知要回头的事。ADR-0021「以后再说」里的其余几条照那边。

| 项 | 什么时候再看 |
| --- | --- |
| 存盘的待发队列：补上「推送进行到一半进程崩了，这一条可能漏掉（最多一次）」（ADR-0024 决策 15 认下的代价） | 没定 |
| `listAddressCandidates`、`connectionAuth` 对拓展开放（ADR-0024 决策 11） | alpha 之后桥帧改名时一起看 |
| 来源自带指令与指令重名的规矩；`CommandProvider` 登记表到那时连同设计（1.0 不造，ADR-0031 决策 1） | 第一个真要自带指令的拓展 |
