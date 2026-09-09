# ADR-0011:推送数据模型 —— 平台是名词,连接器是动词

- **状态**:**分期 ①②③ 已落地,未 push、未发版**(2026-09-08 经 `/grill-me` 多轮拷问定案;dev 上 49 个提交,四道门禁全绿)
- **记录方式**:⚠️ **事后追认** —— 据定案记录与已落地的实现整理,**非当时拷问的原文**。
- **影响面**:`packages/internal/src/schema/targets.ts`、`packages/internal/src/constants.ts`、`apps/server/src/platforms/`、`apps/server/src/sink/multiplex.ts`、`apps/web/src/pages/Targets.tsx` 及其表单一族
- **取代**:ADR-0009 原稿里的数据模型一节(`platform` → `{driver, platform?}`)
- **🔗 后续**:拓展契约整个建在这套模型上,见 ADR-0012

## 背景

`PushAdapter.platform` 一个字段兼着**三个身份**:协议名(`onebot`)、传输方式(`webhook`)、真平台(`qq-official`)。后果是加一个平台要动 **29 处**,而且每一处都要判「这里问的是哪个身份」——判错属于**门禁全绿、只有真机露馅**那一类。

桥接(ADR-0009)把这个问题逼到了台面上:一条桥连接**没有单一平台**,它后面挂着 telegram 还是 discord 是握手时才报的运行时知识。旧模型装不下它。

## 决策

**总纲:平台是名词,连接器是动词。**

### 数据形状

1. **连接与目标各长出一根 `kind` 轴**,判别子从 `platform` 换成 `kind`:
   - `Connection`:`{kind:"direct", platform, connector, config}` | `{kind:"bridge", connector:"bridge", config:{token, bridgeKind}}`
   - `PushTarget`:`{kind:"session", platform, botId?, scope, address, parentAddress?}` | `{kind:"endpoint", platform, managedBy:"connection"}`
2. 🔴 **桥那一支没有 `platform`**。不给它塞一个可选的 —— 那只会让全仓读点静默变 `undefined`;少那一格,读它的地方就会**编译不过**,而那份编译错清单正是「哪些地方假定了连接就是一个平台」。
3. **两侧的词表开放度相反**:`connection.platform` 闭集(每一档都要配齐 config schema + adapter + 面板控件),**`target.platform` 开放**(桥驮来的枚举不了)。因此 `PushTargetPlatform` **必须拆成两个类型** —— 继续共用等于用一个类型把开、闭两套词表糊在一起。
4. **每平台一套的 session 字段收成一格 `address`**(+ 可选 `parentAddress`),且**必填**(旧模型是 optional,那是个洞)。
5. 出站 webhook 的 `provider` **升格成 platform**:`feishu` / `dingtalk` / `wecom` / `generic`(generic 是承认的疤,面板显示「未指明的 HTTP 端点」)。
6. **qq 不拆频道**:一个 `qq` 平台覆盖群 / C2C / 频道。

### 分发

7. **分发键从平台名里剥出来**:`connectionDispatchKey(connection)` —— 直连是它的平台名,桥是常量 `"bridge"`。**计算出来的,从不落盘。** adapter 矩阵按它索引,于是那张表的键集合是「平台词表 + 桥那一个」。
8. 它住零依赖的 `constants.ts`,因为**前端要在运行时用它**。

### 身份

9. 🔴 **主人身份改三坐标 `(platform, address, botId?)`。** 旧模型塌成一个裸字符串,比对就是字符串相等 —— 而 OneBot 的 QQ 号与官机的 C2C openid 是**两个命名空间**,撞上就等于认错人。这句话在注释里写了很久,**从来没有东西校验过它**:真正兜着它的是「一条连接只驮一个平台」这个正在被拆掉的前提。
10. `botId` **只在两边都有时参与比对** —— 直连这一格永远是空的,要求它相等等于谁都不认。

### 命名

11. **`PushAdapter` → `Connection` 要改,`PushTarget` 不改。** 判据是**一词二义**,不是跟对方对称:`adapter` 这个词在这一行里普遍指「实现」,而仓里同时有 `PlatformAdapter` 也指实现 —— 一个词兼两个身份;「推送目标」则没有第二个意思。
12. **改成 `Target` 方向相反,是往里引入二义**:DOM 的 `event.target` / `EventTarget` 全仓 75 处,CDP 里浏览器页签也叫 Target。代价也不对称(343 处 vs 189 处,跨 4 个包)。
13. ⛔ **`platform` → `driver` 那套改名已被撤回**(2026-09-08,主人未说理由)。**别再提议改名到 driver。** 新模型不改名 —— `platform` 留着,`kind` 这根正交轴做判别子,那个别扭点已经绕开了。

### 接口分家

14. `PlatformAdapter` 拆成 `Connector`(建连 / 重连退避 / 心跳 / 状态机,通用)+ `PlatformDialect`(握手 / 鉴权 / 编解码 / 地址语义 / 能力)。让 `ws` 真通用的钥匙是 `dialect.resolveEndpoint()` —— QQ 在这里拿 gateway 地址,所以「用户不填 url」也能塞进通用 ws。
15. **文件刻意不拆**(`onebot.ts` 1385 行、`qq-official.ts` 1338 行)—— 抽象只有一个长连接用例验证过,容易抽错。

### 迁移

16. 一次性纯函数 `migrate(raw, fromVersion)`,**启动路径与备份恢复路径都调**(含 full 备份加密袋里那份 config)。迁移前落 `.bak`,加载器**以数据形状判定**而非版本号。
17. ⚠️ `qq-official → qq` **不是免费改名**:`platformSupportsAtAll` 与 `platformCanReceiveReply` 都会翻转,迁移必须**显式**给 qq 写上 `atAll: unsupported` + `inboundReply: supported`。
18. **连接文件改名 `adapters.json` → `connections.json`**,老文件原地不动 —— 这让「降格之后回退」大大缓和:旧构建回来找的正是它、且还是迁移前的形状,能正常开机。

## 明确不做(拷问中被否决的)

- **`PushTarget` 改名**:见决策 11、12。
- **`platform` → `driver`**:见决策 13,已撤回。
- **在分期 ①② 拆那两个千行文件**:见决策 15。
- **写版本文件保证回退安全**:旧构建根本不读它(同 ADR-0005)。
- **`linkScopeKey` 补 `botId`**:压测时提过,已撤销。

## 后果

- 🔴 **降格之后回退会静默丢连接**:旧构建读到新平台时,连接侧的闭集判据会先把它**静默丢弃**,连同它名下的目标一起,而且**下一次任何编辑都会把这个丢弃写实到盘上**。`adapters.json` 改名把它缓和了(回退等于退回升级那一刻),但目标那侧仍只有 `.bak` 兜着。**发版时这两句必须写进 CHANGELOG 的升级导读。**
- 🔴 **`isRetiredConnection()` 跑在 parse 之前**、拿原始 JSON、用闭集判定 —— 认不出就开机静默丢弃。目标那侧已经把判据换成「parse 得过」,**连接这侧还没改**;拓展化落地前必须改(见 ADR-0012)。
- **schema 驱动表单**只覆盖了「连接参数」那一节,分发靠三个硬编码 if,**认不出的平台拿到空字段表**。
- 能力那张表仍是 per-connection × platform,**粒度不够**(见 ADR-0009 的后果)。
- `INBOUND_CAPABLE_PLATFORMS` / `platformCanReceiveReply` **留着闭集是对的** —— 它问的是「**直连**的这个平台收不收得到回复」。入站那条路已经不经过它了。代价:桥后面的群进不了「逐群例外」那张选择器。

## 仍未决 / 未验

- 分期 ④(重连 / 退避 / 心跳从两个千行文件合并成一份)**没做**。
- B2 词汇收口(注释、测试名、`docs/agents/*`、README 与 docker-hub 两份人工同步的副本)**没做** —— 已并进 ADR-0012 的命名走查。
- 49 个提交**未 push、未发版**,CHANGELOG 未写。
