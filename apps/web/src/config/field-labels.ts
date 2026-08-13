/**
 * 字段字典 — 灵动岛草稿机制的 source of truth。
 *
 * 历史上 dashboard 的每个 `<Field>` 在 JSX 里硬编码 label/hint 字面量,导致灵动岛
 * 草稿机制(Phase B 起)的字段级 diff 无法拿到稳定的「中文 label」/「字段说明」/
 * 「值格式化器」。本字典把所有 `code` 当 source of truth:Field 组件不再接 label
 * /hint props(可选 override 给 Targets 的动态 label 上下文),内部直接 lookup。
 *
 * 维护约束:
 * - 新增 `<Field code="X">` 用法时必须在此字典补 X 的 entry
 * - 改 code 字符串时此字典与所有使用处一起改
 * - `field-labels-conformance.test.ts` 会扫 src/pages 全 tsx 静态校验
 *
 * Phase B 起会用到 `formatter` / `secret` 做 diff 行格式化(密钥渲染 ••• 已改、
 * boolean → 开启/关闭、color → 色块);Phase A 先把字段结构留好,formatter 留空
 * 由各调用处兜底。
 */

import {
	AI_PROVIDER_IDS,
	type AIProviderId,
	providerMeta,
} from "@bilibili-notify/internal/constants";

/** 字段分组,灵动岛 expand panel 按 section 分组渲染。 */
export type FieldSection =
	| "general"
	| "master"
	| "ai"
	| "persona"
	| "cardStyle"
	| "cardPreview"
	| "filter"
	| "templates"
	| "schedule"
	| "interaction"
	| "specialUsers"
	| "imageGroup"
	| "target"
	| "adapter"
	| "transport"
	| "session"
	| "logging"
	| "commands";

export interface FieldLabel {
	/** UI 显示标签(中文)。 */
	label: string;
	/** 字段说明,渲染在 label 下方;为空则不显示。 */
	hint?: string;
	/** 灵动岛 expand panel 分组归属。 */
	section: FieldSection;
	/** 值格式化器(灵动岛 diff 行用,Phase E 实现)。 */
	formatter?: (value: unknown) => string;
	/** 密钥/凭证字段。灵动岛 diff 行渲染为 `••• 已改`,不暴露明文。 */
	secret?: boolean;
}

/**
 * 所有 `<Field code="...">` 的元信息表。
 *
 * 部分 code 在不同上下文有不同语义:
 * - `app.healthCheckMinutes` — 此处沿用 schema 真实语义(LoginFlow 登录健康检查
 *   间隔),replace sections.tsx 历史上写错的 master 节流文案。
 * - `enable` / `forward` — 取 sections.tsx 的「全局段」详细 hint;per-UP 覆盖
 *   场景如需短版,Field prop 可 hint override。
 *
 * 个别字段语义:
 * - Targets.tsx 里 `config.url` / `config.timeoutMs` / `config.headers` /
 *   `config.accessToken` 在不同 transport 类型下 label/hint 是动态的,字典只存
 *   一个「默认 label/hint」,实际渲染由调用处 prop 覆盖。
 */
export const FIELD_LABELS = {
	// ── 通用 / 全局(app.*) ────────────────────────────────────────────────
	"app.dynamicCron": {
		label: "动态检查频率",
		hint: "cron 表达式 · 默认 30 */2 * * * * (每 2 分钟的第 30 秒,错开整分高峰)",
		section: "general",
	},
	"app.logLevel": {
		label: "日志等级（全局）",
		hint: "未在下方按模块覆盖时的兜底",
		section: "logging",
	},
	"app.logLevels": {
		label: "按模块覆盖",
		hint: "留「跟随全局」即用 app.logLevel；保存后会立即推到对应模块的 pino 实例,无需重启",
		section: "logging",
	},
	"app.logLevels.ai": {
		label: "日志等级",
		hint: "只影响 ai 模块;选「跟随全局」时与 app.logLevel 同步。保存后立即生效,无需重启。",
		section: "logging",
	},
	"app.logLevels.image": {
		label: "日志等级",
		hint: "只影响 image 模块;选「跟随全局」时与 app.logLevel 同步。保存后立即生效,无需重启。",
		section: "logging",
	},
	// 以下 3 条仅作 diff-path entry 用(System 页 SYSTEM_MODULES 改 core/dynamic/live
	// 时 walkTreeDiff 会输出对应 dot-path,跳转锚点回到包裹整组的 <Field code="app.logLevels">)。
	"app.logLevels.core": {
		label: "日志等级",
		hint: "只影响 core 模块",
		section: "logging",
	},
	"app.logLevels.dynamic": {
		label: "日志等级",
		hint: "只影响 dynamic 模块",
		section: "logging",
	},
	"app.logLevels.live": {
		label: "日志等级",
		hint: "只影响 live 模块",
		section: "logging",
	},
	"app.userAgent": {
		label: "User-Agent",
		hint: "留空使用默认;遇 -352 风控可换",
		section: "general",
	},
	"app.healthCheckMinutes": {
		label: "登录心跳间隔",
		hint: "每 N 分钟向 B 站 getMyselfInfo 探活;失效会触发 auth-lost + master 通知",
		section: "general",
	},
	"app.historyRetentionDays": {
		label: "历史保留天数",
		hint: "到期的 jsonl 日志会被清理",
		section: "logging",
	},

	// ── Master ────────────────────────────────────────────────────────────
	"master.targetId": {
		label: "Master 推送目标",
		section: "master",
	},

	// ── 私聊指令 ──────────────────────────────────────────────────────────
	"commands.enabled": {
		label: "私聊指令",
		hint: "关掉之后只剩审批的 y/n —— 否则手里那份等审批的周报就再也批不掉了",
		section: "commands",
	},
	"commands.prefix": {
		label: "指令前缀",
		hint: "可以留空;留空后认不出的话一律当没看见(否则会对你每句聊天都回一句)",
		section: "commands",
	},
	"commands.aliases": {
		label: "指令别名",
		hint: "主名永远有效;别名撞了会在保存时拦下",
		section: "commands",
	},

	// ── AI 连接 ───────────────────────────────────────────────────────────
	"ai.apiKey": { label: "API Key", section: "ai", secret: true },
	"ai.baseUrl": { label: "Base URL", section: "ai" },
	// 指向当前在用实例的**指针**(与人格的 activePreset 同一套语义)。
	"ai.activeProfile": {
		label: "使用的服务商",
		hint: "女仆平时用哪一份实例。只拨指针不改配置，换来换去各份的密钥与模型都不会丢",
		section: "ai",
	},
	// 实例桶里的方言归属字段(经 `ai.providers.<实例>.provider` 前缀规则继承到这条)。
	"ai.provider": {
		label: "所属服务商",
		hint: "「开思考」这件事各家写法完全不一样，女仆得知道是哪家才翻译得对。「自定义」则不发任何服务商专属参数，需要什么请写到额外请求参数里",
		section: "ai",
	},
	"ai.label": {
		label: "实例名称",
		hint: "同一家添加多份时全靠它区分。留空则显示那家的名字",
		section: "ai",
	},
	// 实例桶的接口风味(经 `ai.providers.<实例>.apiFlavor` 前缀规则继承到这条)。
	"ai.apiFlavor": {
		label: "接口风味",
		hint: "chat completions 是现状；responses 是 OpenAI 一系的新协议，思考是标准字段、思考 + 工具连用更稳。只有确认支持的家才摆这一格，失败不会悄悄换回旧协议",
		section: "ai",
	},
	// 聊天页自己的思考等级(ai.chat.thinkingLevel)**不在**这张表里:它的编辑口
	// 在聊天侧栏的「设置」弹层,点档位直接 PATCH,不经过灵动岛的 diff,也没有
	// `Field code` —— 表里挂一条永远显示不出来的死条目只会误导。
	// 联网搜索(ai.search)—— web_search 工具的执行后端,与选哪家 AI 服务商正交。
	"ai.search.backend": {
		label: "搜索后端",
		hint: "女仆的 web_search 工具由这家真正执行。博查中文质量好;Tavily 有免费额度",
		section: "ai",
	},
	"ai.search.keys.bocha": {
		label: "博查 API Key",
		hint: "在 open.bochaai.com 申请。留空 = 未配置,女仆不会挂搜索工具",
		section: "ai",
		secret: true,
	},
	"ai.search.keys.tavily": {
		label: "Tavily API Key",
		hint: "在 app.tavily.com 申请。留空 = 未配置,女仆不会挂搜索工具",
		section: "ai",
		secret: true,
	},
	"ai.search.engines.dynamic": {
		label: "动态点评联网搜索",
		hint: "开了之后每条动态点评都可能多几次搜索调用(按次计费)和几秒延迟",
		section: "ai",
	},
	"ai.search.engines.live": {
		label: "直播总结联网搜索",
		hint: "开了之后每次下播总结都可能多几次搜索调用(按次计费)和几秒延迟",
		section: "ai",
	},
	"ai.search.engines.roast": {
		label: "锐评联网搜索",
		hint: "开了之后每次锐评都可能多几次搜索调用(按次计费)",
		section: "ai",
	},
	// 合成字段,不是 schema 里的东西 —— 灵动岛只认得「摊平后的那几只桶」,
	// 添加/删除实例在它眼里毫无变化,于是保存条不亮、主人一走就丢。这一行把
	// 「已添加哪几份」显式喂给它。见 Ai.tsx#packIsland。
	"ai.providerList": {
		label: "已添加的服务商",
		hint: "左栏列着的那几份实例。删掉一份会连同它存着的密钥一起抹掉",
		section: "ai",
	},
	"ai.enableThinking": {
		label: "深度思考",
		hint: "让模型先想一轮再回答。更慢、更贵，但复杂内容的点评质量会好一截。要是那家网关不认，女仆会自动摘掉参数重试一次，不会报错",
		section: "ai",
	},
	"ai.thinkingLevel": {
		label: "思考深度",
		hint: "统一三档，女仆按服务商换算：OpenRouter 是 low/medium/high，DeepSeek 只有 high/max，火山与硅基是 token 预算。换服务商时这个设置不作废",
		section: "ai",
	},
	"ai.extraParams": {
		label: "额外请求参数",
		hint: '一段 JSON，原样摊进请求体。适配之外的服务商、或联网搜索这类各家写法不同的能力都写这里，比如 OpenRouter 的 {"plugins":[{"id":"web"}]}。跟女仆自己发的参数撞了以你为准；写错了那一次就当没填。model / messages / tools 是请求骨架，会被挡掉',
		section: "ai",
	},
	"ai.model": { label: "模型 ID", section: "ai" },
	"ai.temperature": {
		label: "temperature",
		hint: "0–2,越高越发散",
		section: "ai",
	},

	// ── 图片理解 ──────────────────────────────────────────────────────────
	// 这个开关是在**声明主模型的能力**，不是在选「把图发给谁」。写成后者的话
	// （旧文案「主模型直接看图」）会让人以为打开就等于图归主模型看 —— 而下面
	// 配了视觉模型时它其实完全不生效。
	"ai.enableVision": {
		label: "主模型支持看图",
		hint: "你的主模型自己看得见图吗（gpt-4o、qwen-vl 这类）？看得见就打开，图直接交给它，省一次往返也不掉细节；看不见就别开，改填下面的视觉模型。注意：一旦填了视觉模型，就一律以视觉模型为准，这个开关不再起作用",
		section: "ai",
	},
	"ai.vision.model": {
		label: "视觉模型 ID",
		hint: "主模型看不见图时（比如 DeepSeek）填这里，图会先由它转成文字描述再交给主模型。填了它就优先于上面那个开关。留空则不启用",
		section: "ai",
	},
	"ai.vision.baseUrl": {
		label: "视觉 Base URL",
		hint: "留空则跟随主模型。只有视觉模型在另一家服务商时才需要单独填",
		section: "ai",
	},
	"ai.vision.apiKey": {
		label: "视觉 API Key",
		hint: "留空则跟随主模型",
		section: "ai",
		secret: true,
	},
	"ai.test.target": {
		label: "推到哪里",
		hint: "从已配置的推送目标里挑一个",
		section: "ai",
	},
	"ai.test.message": {
		label: "想问点什么",
		hint: "一句话或一个问题 · 最多 500 字",
		section: "ai",
	},
	"ai.preset": {
		label: "人格",
		hint: "从「智能女仆」页备着的那几份里挑一份给这个 UP。想改内容或另起一份都到那边去",
		section: "ai",
	},
	"ai.activePreset": {
		label: "全局人格",
		hint: "女仆平时用哪一份性格。它只是个指向，换来换去都不会动到「默认」那份的内容",
		section: "ai",
	},
	// AI / Cards hero strip 的「启用」总开关 Toggle 没包 <Field>(Picker 直挂在
	// GlassBox right 槽),walkTreeDiff 输出 `enabled` 顶层路径。label 取通用
	// 「启用」,灵动岛上下文已经标 pageLabel("智能女仆" / "卡片样式"),用户
	// 看上下文就知道是哪页的启用。
	enabled: { label: "启用", section: "general" },
	"ai.dynamicPrompt": { label: "动态点评 prompt", section: "ai" },
	"ai.liveSummaryPrompt": { label: "直播总结 prompt", section: "ai" },
	presets: {
		label: "基础预设",
		// Ai.tsx 在 presets 非空时显式传 hint={undefined} 回落到此默认值;为空时传
		// "未配置 ai.presets，可在「完全自定义」下手动填写人格" 覆盖。删除此 hint
		// 会让 presets 非空时 hint 行消失。
		hint: "选择预设可快速套用人格 / prompts",
		section: "ai",
	},

	// ── AI 人格(全局视角:persona.*) ──────────────────────────────────────
	"persona.name": {
		label: "名字",
		hint: "留空跟随预设",
		section: "persona",
	},
	"persona.addressUser": { label: "称呼用户", section: "persona" },
	"persona.addressSelf": { label: "自称", section: "persona" },
	"persona.catchphrase": { label: "口头禅", section: "persona" },
	"persona.traits": {
		label: "性格特点",
		hint: "逗号分隔",
		section: "persona",
	},
	"persona.baseRole": {
		label: "基础角色描述",
		hint: "system prompt 起手段,定义 AI 身份",
		section: "persona",
	},
	"persona.extraSystemPrompt": {
		label: "追加 system prompt",
		hint: "附加到 system prompt 末尾,用于安全约束、避讳词、语气微调",
		section: "persona",
	},

	// ── AI 人格(per-UP 视角:ai.persona.*) ───────────────────────────────
	"ai.persona.name": { label: "名字", section: "persona" },
	"ai.persona.addressUser": { label: "称呼用户", section: "persona" },
	"ai.persona.addressSelf": { label: "自称", section: "persona" },
	"ai.persona.catchphrase": { label: "口头禅", section: "persona" },
	"ai.persona.traits": {
		label: "性格特点",
		hint: "逗号分隔",
		section: "persona",
	},
	"ai.persona.baseRole": {
		label: "基础角色描述",
		hint: "system prompt 起手段,定义 AI 的身份",
		section: "persona",
	},
	"ai.persona.extraSystemPrompt": {
		label: "追加 system prompt",
		hint: "附加到 system prompt 末尾,用于安全约束、避讳词、语气微调",
		section: "persona",
	},

	// ── 卡片样式 ──────────────────────────────────────────────────────────
	cardColorStart: { label: "渐变起始", section: "cardStyle" },
	cardColorEnd: { label: "渐变结束", section: "cardStyle" },
	font: {
		label: "字体",
		hint: "字体家族名。渲染那台机器没装这个字体时自动回退到内置兜底链(Microsoft YaHei / Noto Sans CJK / sans-serif)。想用别的字体就把文件传上来。",
		section: "cardStyle",
	},
	fontAsset: {
		label: "自带字体",
		hint: "主人上传的字体文件。设了就优先于字体家族名;文件被删掉时静静回退,不会让出图崩。",
		section: "cardStyle",
	},
	showPopularity: { label: "人气 / 点赞", section: "cardStyle" },
	showArea: { label: "直播分区", section: "cardStyle" },
	showFans: { label: "粉丝数据", section: "cardStyle" },
	glassOpacity: { label: "玻璃片透明度", section: "cardStyle" },
	glassClear: { label: "完全透明", section: "cardStyle" },
	backgroundImages: { label: "自定义背景图", section: "cardStyle" },
	liveCoverImages: { label: "直播封面替换", section: "cardStyle" },
	// 卡片版式(灵动岛 diff 码 —— walkTreeDiff 把每张卡的块数组当叶子整体比较)。
	"cardLayout.live": { label: "直播卡版式", section: "cardStyle" },
	"cardLayout.dynamic": { label: "动态卡版式", section: "cardStyle" },
	"cardLayout.sc": { label: "SC 卡版式", section: "cardStyle" },
	"cardLayout.guard.badgeSide": { label: "上舰卡徽章位置", section: "cardStyle" },
	"cardLayout.guard.blocks": { label: "上舰卡版式", section: "cardStyle" },

	// ── 卡片预览(Cards 页样本数据,不真正写回 globals) ───────────────────
	roomId: {
		label: "直播间号",
		hint: "纯数字，例如 5440",
		section: "cardPreview",
	},
	uid: {
		label: "UP 主 UID",
		hint: "目标 UP 主的 UID",
		section: "cardPreview",
	},
	offset: {
		label: "第几条动态",
		hint: "按 B 站列表顺序取第 N 条(可能含置顶)",
		section: "cardPreview",
	},
	text: {
		label: "SC 文案",
		hint: "留言内容",
		section: "cardPreview",
	},
	price: {
		label: "SC 价格",
		hint: "决定背景色与时长 (30/50/100/500/1000)",
		section: "cardPreview",
	},
	level: {
		label: "舰长等级",
		hint: "决定徽章图与背景色",
		section: "cardPreview",
	},

	// ── 过滤 ──────────────────────────────────────────────────────────────
	blockKeywords: {
		label: "屏蔽关键词",
		hint: "任一命中即屏蔽",
		section: "filter",
	},
	blockRegex: {
		label: "屏蔽正则",
		hint: "正则表达式 · 命中的动态被屏蔽",
		section: "filter",
	},
	whitelistKeywords: {
		label: "白名单关键词",
		hint: "非空时仅命中条目会被推送",
		section: "filter",
	},
	whitelistRegex: { label: "白名单正则", section: "filter" },
	blockForward: { label: "屏蔽转发动态", section: "filter" },
	blockArticle: { label: "屏蔽专栏动态", section: "filter" },
	blockDraw: { label: "屏蔽图文动态", section: "filter" },
	blockAv: { label: "屏蔽视频动态", section: "filter" },

	// ── 互动门槛 ──────────────────────────────────────────────────────────
	minScPrice: {
		label: "SC 最低金额",
		hint: "低于此金额不推送 · 0 = 全推",
		section: "interaction",
	},
	minGuardLevel: {
		label: "上舰最低等级",
		hint: "3 = 全部 · 1 = 仅总督",
		section: "interaction",
	},

	// ── 调度 ──────────────────────────────────────────────────────────────
	"schedule.pushTime": {
		label: "状态推送间隔",
		hint: "0 = 不推送",
		section: "schedule",
	},
	"schedule.restartPush": {
		label: "启动后立即推送",
		hint: "重启时若 UP 在播则立即推送一次",
		section: "schedule",
	},
	"schedule.liveEndGrace": {
		label: "断流接续",
		hint: "下播先延迟判定,期间重开即接续为同一场",
		section: "schedule",
	},
	"schedule.liveEndGraceMinutes": {
		label: "接续等待时长",
		hint: "下播到重开超过此时长才判定真下播",
		section: "schedule",
	},
	"schedule.quietHours": {
		label: "免扰时段",
		hint: "落在区间内的推送直接丢弃,不补推;粒度按「时」,半开区间 [start, end)",
		section: "schedule",
	},
	restartPush: {
		label: "启动后立即推送",
		hint: "重启时若 UP 在播则立即推送一次",
		section: "schedule",
	},

	// ── 消息模板 ──────────────────────────────────────────────────────────
	"templates.liveSummary": { label: "总结正文", section: "templates" },
	"templates.wordcloudStopWords": { label: "词云停用词", section: "templates" },
	"templates.liveStart": { label: "开播", section: "templates" },
	// 消息版式(发送侧结构):分隔符经 Field 编辑;blocks 数组由版式编辑器整体管理,
	// 灵动岛 diff 时按叶子 code 命中下列条目。
	"messageLayout.dynamic.separator": {
		label: "动态消息分隔符",
		hint: "同条消息内相邻文本类部件的连接符;\\n 表示换行",
		section: "templates",
	},
	"messageLayout.live.separator": {
		label: "直播消息分隔符",
		hint: "同条消息内相邻文本类部件的连接符;\\n 表示换行",
		section: "templates",
	},
	"messageLayout.dynamic.blocks": { label: "动态消息部件排列", section: "templates" },
	"messageLayout.live.blocks": { label: "直播消息部件排列", section: "templates" },
	"templates.liveOngoing": { label: "直播中", section: "templates" },
	"templates.liveEnd": { label: "下播", section: "templates" },
	"templates.dynamic": { label: "动态文案", section: "templates" },
	"templates.dynamicVideo": { label: "视频文案", section: "templates" },
	"templates.specialDanmaku": { label: "弹幕模板", section: "templates" },
	"templates.specialUserEnter": { label: "进房模板", section: "templates" },
	// 以下几条仅 diff-path entry 用(GuardSection 的 Toggle 直接挂在 GlassBox.right
	// 槽,Guard 模板嵌在小卡 JSX 里没单独 <Field> 包裹,diff 会输出整段嵌套 path)。
	"templates.guardBuy.enable": {
		label: "启用自定义上舰提示",
		hint: "总开关 · 关 = 默认走 B 站官方上舰图",
		section: "templates",
	},
	"templates.guardBuy.captain.template": { label: "舰长文案", section: "templates" },
	"templates.guardBuy.captain.imageUrl": { label: "舰长图片", section: "templates" },
	"templates.guardBuy.commander.template": { label: "提督文案", section: "templates" },
	"templates.guardBuy.commander.imageUrl": { label: "提督图片", section: "templates" },
	"templates.guardBuy.governor.template": { label: "总督文案", section: "templates" },
	"templates.guardBuy.governor.imageUrl": { label: "总督图片", section: "templates" },

	// ── 特别关注 / Special UID ────────────────────────────────────────────
	specialUsers: { label: "UID 列表", section: "specialUsers" },

	// ── 动态图集 ──────────────────────────────────────────────────────────
	enable: {
		label: "推送动态图集",
		hint: "图集类动态在文本后再发一组图 · 关 = 只发卡片",
		section: "imageGroup",
	},
	forward: {
		label: "图集走合并转发",
		hint: "开 = 聊天记录卡片 · 关 = 多图普通消息;单图不走合并转发",
		section: "imageGroup",
	},

	// ── 卡片自定义模板 special user 子表(PerUpEditor SpecialUserBox) ─────
	template: { label: "文案", section: "templates" },
	imageUrl: { label: "图片 URL", section: "templates" },
	targetId: {
		label: "推送目标",
		hint: "仅列启用的外部投递目标",
		section: "target",
	},

	// ── Targets(推送目标 / 适配器 / 传输 / 会话) ────────────────────────
	"adapter.platform": { label: "平台", section: "adapter" },
	"adapter.name": { label: "显示名称", section: "adapter" },
	"adapter.enabled": { label: "启用", section: "adapter" },
	"config.provider": {
		label: "Webhook 协议",
		hint: "Generic 保持旧 JSON envelope；钉钉/飞书按平台机器人协议发送文本消息",
		section: "transport",
	},
	"config.transport": { label: "连接方式", section: "transport" },
	"config.baseUrl": { label: "HTTP baseUrl", section: "transport" },
	"config.url": { label: "URL", section: "transport" },
	"config.port": {
		label: "反向 WS 监听端口",
		hint: "bot 主动连入此端口;端口即身份,与主端口 8787 独立",
		section: "transport",
	},
	"config.accessToken": {
		label: "accessToken",
		section: "transport",
		secret: true,
	},
	"config.timeoutMs": { label: "超时", section: "transport" },
	"config.imageMinTimeoutMs": {
		label: "带图超时下限",
		hint: "带图消息实际等 max(超时, 此值);0 = 不放宽",
		section: "transport",
	},
	"config.forwardMinTimeoutMs": {
		label: "合并转发超时下限",
		hint: "合并转发要逐张下载再上传,比单图更慢;0 = 不放宽",
		section: "transport",
	},
	"config.retryTimes": {
		label: "重试次数",
		hint: "不含首次,失败后再尝试",
		section: "transport",
	},
	"config.retryIntervalMs": { label: "重试间隔", section: "transport" },
	"config.headers": {
		label: "自定义请求头",
		hint: "例如反向代理鉴权头",
		section: "transport",
	},
	"config.secret": {
		label: "Secret",
		hint: "加在 x-bilibili-notify-secret 头",
		section: "transport",
		secret: true,
	},
	// QQ 官方机器人(q.qq.com)适配器凭据
	"config.appId": {
		label: "AppID",
		hint: "QQ 开放平台机器人的 AppID(明文存储)",
		section: "transport",
	},
	"config.appSecret": {
		label: "AppSecret",
		hint: "机器人密钥;用于换取 App Access Token",
		section: "transport",
		secret: true,
	},
	"config.botType": {
		label: "机器人域",
		hint: "私域可发原生 markdown(图集合并);公域不支持原生 markdown(需报备模板)",
		section: "transport",
	},
	"config.sandbox": {
		label: "沙箱模式",
		hint: "开启后走 QQ 沙箱环境,仅对沙箱内成员可见",
		section: "transport",
	},
	"config.logReconnects": {
		label: "记录重连日志",
		hint: "QQ 官方网关约每 30 分钟主动要求重连一次,属正常协议行为;默认关闭避免刷屏,排障时可开启",
		section: "transport",
	},
	"target.name": { label: "显示名称", section: "target" },
	"target.scope": { label: "作用域", section: "target" },
	"target.enabled": { label: "启用", section: "target" },
	"session.userId": { label: "QQ 号 (userId)", section: "session" },
	"session.groupId": { label: "群号 (groupId)", section: "session" },
	// QQ 官方机器人会话寻址(按 scope)
	"session.guildId": { label: "频道服务器 ID (guildId)", section: "session" },
	"session.channelId": { label: "子频道 ID (channelId)", section: "session" },
	"session.groupOpenid": { label: "群 openid (groupOpenid)", section: "session" },
	"session.userOpenid": { label: "用户 openid (C2C)", section: "session" },

	// ── 定时周报(roastSchedule.*) ─────────────────────────────────────────
	// 周期与统计范围是**解耦**的两个字段:cron 定何时发,days 定统计多少天。
	// 不预设「周报 / 月报」这类组合 —— 用户自己搭。
	"roastSchedule.enabled": {
		label: "定时锐评",
		hint: "到点自动生成并发送 · 关掉就只剩手动那颗按钮",
		section: "schedule",
	},
	"roastSchedule.approval": {
		label: "发送前先给主人过目",
		hint: "私聊发预览 · 回复 y 才进群,48 小时没回复就作废",
		section: "schedule",
	},
	"roastSchedule.notifyOnError": {
		label: "没发出去时通知我",
		hint: "生成失败 / 没配目标 / 群发失败都会私聊说明原因",
		section: "schedule",
	},
	"roastSchedule.cron": {
		label: "发送时间",
		hint: "cron 表达式 · 如 0 9 * * 1(每周一早九点)",
		section: "schedule",
	},
	"roastSchedule.days": {
		label: "统计范围",
		hint: "周报往前统计多少天(近 7 / 30 / 90 日)· 与发送周期无关,想每天发一份近 7 天的榜也可以",
		section: "schedule",
	},
	"roastSchedule.targets": {
		label: "发送到",
		hint: "可多选 · 一个群发失败不影响其他群",
		section: "schedule",
	},
} satisfies Record<string, FieldLabel>;

/** 所有已知 code 的联合类型。 */

/**
 * 在字典里 lookup;命中则返回 entry,否则返回 `null` 并在开发环境 warn。Field
 * 组件需要 lookup 失败时回退到 prop label,确保 schema 漂移不直接白屏。
 */
/**
 * 「默认文案有更新」的账本前缀。
 *
 * 它的 code 是**动态**的 —— `templateDefaultsSeen.<任意模板路径>`,模板加一条这里
 * 就多一条,逐个登记进 FIELD_LABELS 等于把同一份清单抄两遍(而且必然有人忘)。
 * 所以走前缀 fallback,label 直接**借对应模板字段自己的名字**:模板哪天改名,
 * 账本这条跟着改,不会两边对不上。
 */
const SEEN_PREFIX = "templateDefaultsSeen.";

/**
 * 逐实例的桶前缀 —— `ai.providers.<实例>.<字段>`。
 *
 * 连接与生成参数一份实例存一套,code 因此是**份数 × 十来个字段**的笛卡尔积,逐条
 * 登记就是把 `ai.*` 那批 entry 抄几遍。所以走前缀 fallback:hint / section /
 * **secret** 全部继承 `ai.<字段>` 那条,label 前面缀上是哪一份。
 *
 * 继承 `secret` 尤其要紧:漏了这一步,灵动岛的 diff 面板查不到密钥位,会把主人刚
 * 敲进去的 **API Key 明文**摊在面板上。
 */
const PROVIDER_PREFIX = "ai.providers.";
const PROVIDER_IDS: ReadonlySet<string> = new Set(AI_PROVIDER_IDS);

/**
 * 实例 id → 显示名。id 由 `addProfile` 生成,只有两种形状:`<家>`(头一份)与
 * `<家>-<序号>`(后续)。字典这儿拿不到配置,解析不了主人起的名字,只能按 id
 * 还原个能认的(「DeepSeek 2 · API Key」)。两种形状都不是的(手改配置)返回
 * null,调用方照旧「老实说不认识」。
 */
function profileDisplayName(id: string): string | null {
	if (PROVIDER_IDS.has(id)) return providerMeta(id as AIProviderId).label;
	const m = /^(.+)-(\d+)$/.exec(id);
	if (m?.[1] !== undefined && PROVIDER_IDS.has(m[1])) {
		return `${providerMeta(m[1] as AIProviderId).label} ${m[2]}`;
	}
	return null;
}

export function getFieldLabel(code: string): FieldLabel | null {
	const hit = (FIELD_LABELS as Record<string, FieldLabel | undefined>)[code];
	if (hit) return hit;
	if (code.startsWith(SEEN_PREFIX)) {
		const path = code.slice(SEEN_PREFIX.length);
		const owner = (FIELD_LABELS as Record<string, FieldLabel | undefined>)[`templates.${path}`];
		return {
			label: `${owner?.label ?? path} · 默认更新提示`,
			hint: "主人对「默认文案有更新」那条提示的处理结果;记下来是为了不再重复问。",
			section: "templates",
		};
	}
	if (code.startsWith(PROVIDER_PREFIX)) {
		const rest = code.slice(PROVIDER_PREFIX.length);
		const cut = rest.indexOf(".");
		const id = cut < 0 ? "" : rest.slice(0, cut);
		// 认不出的**字段**才「老实说不认识」;认不出形状的**桶 id** 不行 ——
		// providers 是 z.record,手改配置/备份恢复出的任意 id(「my-deepseek」)
		// 合法可加载,返回 null 会把继承的 secret 标志一起丢掉,diff 面板就把
		// 刚输入的 API Key 按明文摊开了。桶 id 本来就是主人写的,原样当显示名。
		const display = profileDisplayName(id) ?? (id !== "" ? id : null);
		if (display !== null) {
			const base = (FIELD_LABELS as Record<string, FieldLabel | undefined>)[
				`ai.${rest.slice(cut + 1)}`
			];
			if (base) {
				return { ...base, label: `${display} · ${base.label}` };
			}
		}
	}
	if (import.meta.env.DEV) {
		console.warn(`[field-labels] missing entry for code="${code}"`);
	}
	return null;
}
