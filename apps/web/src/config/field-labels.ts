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
	| "logging";

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
		hint: "cron 表达式 · 默认 */2 * * * * (每 2 分钟)",
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

	// ── AI 连接 ───────────────────────────────────────────────────────────
	"ai.apiKey": { label: "API Key", section: "ai", secret: true },
	"ai.baseUrl": { label: "Base URL", section: "ai" },
	"ai.model": { label: "模型 ID", section: "ai" },
	"ai.temperature": {
		label: "temperature",
		hint: "0–2,越高越发散",
		section: "ai",
	},
	"ai.preset": { label: "预设", section: "ai" },
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
		hint: "CSS font-family。容器/浏览器没装时自动回退到内置兜底链(Microsoft YaHei / Noto Sans CJK / sans-serif)。",
		section: "cardStyle",
	},
	hideDesc: { label: "隐藏直播简介", section: "cardStyle" },
	hideFollower: { label: "隐藏粉丝数据", section: "cardStyle" },

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
} satisfies Record<string, FieldLabel>;

/** 所有已知 code 的联合类型。 */
export type FieldCode = keyof typeof FIELD_LABELS;

/**
 * 在字典里 lookup;命中则返回 entry,否则返回 `null` 并在开发环境 warn。Field
 * 组件需要 lookup 失败时回退到 prop label,确保 schema 漂移不直接白屏。
 */
export function getFieldLabel(code: string): FieldLabel | null {
	const hit = (FIELD_LABELS as Record<string, FieldLabel | undefined>)[code];
	if (hit) return hit;
	if (import.meta.env.DEV) {
		console.warn(`[field-labels] missing entry for code="${code}"`);
	}
	return null;
}
