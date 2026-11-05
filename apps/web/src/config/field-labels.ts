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

import { AI_PROVIDER_IDS, type AIProviderId, providerMeta } from "@bilibili-notify/internal/ai";
import { LINK_LIMITS } from "@bilibili-notify/internal/link-preview";
import { i18n } from "../i18n/index";

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
	| "specialViewers"
	| "imageGroup"
	| "target"
	| "connection"
	| "transport"
	| "logging"
	| "commands"
	| "linkPreview";

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
 * - `bilibili.healthCheckMinutes` — 此处沿用 schema 真实语义(LoginFlow 登录健康检查
 *   间隔),replace sections.tsx 历史上写错的 master 节流文案。
 * - `imageGroup.enabled` / `imageGroup.mergeForward` — 取 sections.tsx 的「全局段」详细 hint;per-UP 覆盖
 *   场景如需短版,Field prop 可 hint override。
 *
 * 个别字段语义:
 * - Targets.tsx 里 `settings.url` / `settings.timeoutMs` / `settings.headers` /
 *   `settings.accessToken` 在不同 transport 类型下 label/hint 是动态的,字典只存
 *   一个「默认 label/hint」,实际渲染由调用处 prop 覆盖。
 */
/**
 * 上舰文案里「每一档」的字典条目:`templates.membership.guard.tiers.<档 key>`(整档)与它下面的 `.template` / `.imageUrl`。
 * 档的名字取会员体系里档的名字,体系加一档这里自动跟着有,不再逐档抄。
 */
export const FIELD_LABELS = {
	"core.accounts.order": {
		get label() {
			return i18n.t("accounts.orderLabel");
		},
		get hint() {
			return i18n.t("accounts.orderHint");
		},
		section: "general",
	},
	"core.locale": {
		get label() {
			return i18n.t("preferences.locale.label");
		},
		get hint() {
			return i18n.t("preferences.locale.hint");
		},
		section: "general",
	},
	"core.voice": {
		get label() {
			return i18n.t("preferences.voice.label");
		},
		get hint() {
			return i18n.t("preferences.voice.hint");
		},
		section: "general",
	},
	"core.timezone": {
		get label() {
			return i18n.t("preferences.timezone.label");
		},
		get hint() {
			return i18n.t("preferences.timezone.hint");
		},
		section: "general",
	},
	"core.stats.enabled": {
		get label() {
			return i18n.t("statsSwitch.label");
		},
		get hint() {
			return i18n.t("statsSwitch.hint");
		},
		section: "general",
	},
	program: {
		get label() {
			return i18n.t("cards.content.program");
		},
		section: "cardPreview",
	},
	// ── 通用 / 全局(系统页:草稿是整份设置,核心那几格带 `core.`、B 站的带 `bilibili.`) ──────────
	"bilibili.dynamicCron": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.1");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.2");
		},
		section: "general",
	},
	"core.logging.level": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.3");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.4");
		},
		section: "logging",
	},
	"core.logging.levels": {
		get label() {
			return i18n.t("sourceUi.pages.Dashboard.title.21");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.5");
		},
		section: "logging",
	},
	// 以下四条保留既有日志说明；其他归属键由下方动态元数据覆盖。
	// walkTreeDiff 输出完整点路径，日志行以同一 data-code 提供跳转锚点。
	"core.logging.levels.core": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.6");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.7");
		},
		section: "logging",
	},
	"core.logging.levels.bilibili": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.6");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.8");
		},
		section: "logging",
	},
	"core.logging.levels.image": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.6");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.9");
		},
		section: "logging",
	},
	"core.logging.levels.ai": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.6");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.10");
		},
		section: "logging",
	},
	"bilibili.healthCheckMinutes": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.11");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.12");
		},
		section: "general",
	},
	"core.history.retentionDays": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.13");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.14");
		},
		section: "logging",
	},
	"core.logging.memoryLog.enabled": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.15");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.16");
		},
		section: "logging",
	},

	// ── Master ────────────────────────────────────────────────────────────
	"core.master.targetId": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.17");
		},
		section: "master",
	},

	// ── 私聊指令 ──────────────────────────────────────────────────────────
	"core.commands.enabled": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.18");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.19");
		},
		section: "commands",
	},
	"core.commands.prefix": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.20");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.21");
		},
		section: "commands",
	},
	// ── 链接解析 ──────────────────────────────────────────────────────────
	"core.linkPreview.enabled": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.22");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.23");
		},
		section: "linkPreview",
	},
	"core.linkPreview.cooldownSec": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.24");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.25", {
				value1: LINK_LIMITS.groupPerMinute,
				value2: LINK_LIMITS.maxInflight,
			});
		},
		section: "linkPreview",
	},
	"core.linkPreview.isOnByDefault": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.26");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.27");
		},
		section: "linkPreview",
	},
	// 默认行里「回什么」那一格:和「解析」同在一行控件里,字典里分开记,保存时才不落进「其他」。
	"core.linkPreview.replyForm": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.28");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.29");
		},
		section: "linkPreview",
	},
	"core.linkPreview.byTarget": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.30");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.31");
		},
		section: "linkPreview",
	},
	"core.commands.aliases": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.32");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.33");
		},
		section: "commands",
	},

	"ai.writing.post.isOnByDefault": {
		get label() {
			return i18n.t("aiWriting.postDefault");
		},
		section: "ai",
		formatter: (value) => (value ? i18n.t("aiWriting.ai") : i18n.t("aiWriting.template")),
	},
	"ai.writing.post.byTarget": {
		get label() {
			return i18n.t("aiWriting.postExceptions");
		},
		section: "ai",
	},
	"ai.writing.liveSummary.isOnByDefault": {
		get label() {
			return i18n.t("aiWriting.liveDefault");
		},
		section: "ai",
		formatter: (value) => (value ? i18n.t("aiWriting.ai") : i18n.t("aiWriting.template")),
	},
	"ai.writing.liveSummary.byTarget": {
		get label() {
			return i18n.t("aiWriting.liveExceptions");
		},
		section: "ai",
	},

	// ── AI 连接 ───────────────────────────────────────────────────────────
	"ai.apiKey": { label: "API Key", section: "ai", secret: true },
	"ai.baseUrl": { label: "Base URL", section: "ai" },
	// 指向当前在用实例的**指针**(与人格的 activePreset 同一套语义)。
	"ai.activeProfile": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.34");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.35");
		},
		section: "ai",
	},
	// 实例桶里的方言归属字段(经 `ai.providers.<实例>.provider` 前缀规则继承到这条)。
	"ai.provider": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.36");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.37");
		},
		section: "ai",
	},
	"ai.label": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.38");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.39");
		},
		section: "ai",
	},
	// 实例桶的接口风味(经 `ai.providers.<实例>.apiFlavor` 前缀规则继承到这条)。
	"ai.apiFlavor": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.40");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.41");
		},
		section: "ai",
	},
	// 聊天页自己的思考等级(ai.chat.thinkingLevel)**不在**这张表里:它的编辑口
	// 在聊天侧栏的「设置」弹层,点档位直接 PATCH,不经过灵动岛的 diff,也没有
	// `Field code` —— 表里挂一条永远显示不出来的死条目只会误导。
	// 联网搜索(ai.search)—— web_search 工具的执行后端,与选哪家 AI 服务商正交。
	"ai.search.backend": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.42");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.43");
		},
		section: "ai",
	},
	"ai.search.keys.bocha": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.44");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.45");
		},
		section: "ai",
		secret: true,
	},
	"ai.search.keys.tavily": {
		label: "Tavily API Key",
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.46");
		},
		section: "ai",
		secret: true,
	},
	get "ai.search.scenes.post"() {
		return {
			label: i18n.t("aiSettings.search.post.label"),
			hint: i18n.t("aiSettings.search.post.hint"),
			section: "ai" as const,
		};
	},
	get "ai.search.scenes.live"() {
		return {
			label: i18n.t("aiSettings.search.live.label"),
			hint: i18n.t("aiSettings.search.live.hint"),
			section: "ai" as const,
		};
	},
	get "ai.search.scenes.roast"() {
		return {
			label: i18n.t("aiSettings.search.roast.label"),
			hint: i18n.t("aiSettings.search.roast.hint"),
			section: "ai" as const,
		};
	},
	// 合成字段,不是 schema 里的东西 —— 灵动岛只认得「摊平后的那几只桶」,
	// 添加/删除实例在它眼里毫无变化,于是保存条不亮、主人一走就丢。这一行把
	// 「已添加哪几份」显式喂给它。见 Ai.tsx#packIsland。
	"ai.providerList": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.47");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.48");
		},
		section: "ai",
	},
	"ai.enableThinking": {
		get label() {
			return i18n.t("aiSettings.page.generation.thinkingAria");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.49");
		},
		section: "ai",
	},
	"ai.thinkingLevel": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.50");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.51");
		},
		section: "ai",
	},
	"ai.extraParams": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.52");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.53");
		},
		section: "ai",
	},
	"ai.model": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.54");
		},
		section: "ai",
	},

	// ── 图片理解 ──────────────────────────────────────────────────────────
	// 这个开关是在**声明主模型的能力**，不是在选「把图发给谁」。写成后者的话
	// （旧文案「主模型直接看图」）会让人以为打开就等于图归主模型看 —— 而下面
	// 配了视觉模型时它其实完全不生效。
	"ai.enableVision": {
		get label() {
			return i18n.t("aiSettings.page.vision.directAria");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.55");
		},
		section: "ai",
	},
	"ai.vision.model": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.56");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.57");
		},
		section: "ai",
	},
	"ai.vision.baseUrl": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.58");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.59");
		},
		section: "ai",
	},
	"ai.vision.apiKey": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.60");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.61");
		},
		section: "ai",
		secret: true,
	},
	"ai.test.target": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.62");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.63");
		},
		section: "ai",
	},
	"ai.test.message": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.64");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.65");
		},
		section: "ai",
	},
	"ai.preset": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.66");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.67");
		},
		section: "ai",
	},
	"ai.activePreset": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.68");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.69");
		},
		section: "ai",
	},
	// AI / Cards hero strip 的「启用」总开关 Toggle 没包 <Field>(Picker 直挂在
	// GlassBox right 槽),walkTreeDiff 输出 `enabled` 顶层路径。label 取通用
	// 「启用」,灵动岛上下文已经标 pageLabel("智能女仆" / "卡片样式"),用户
	// 看上下文就知道是哪页的启用。
	enabled: {
		get label() {
			return i18n.t("aiSettings.page.hero.enable");
		},
		section: "general",
	},
	"ai.dynamicPrompt": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.70");
		},
		section: "ai",
	},
	"ai.liveSummaryPrompt": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.71");
		},
		section: "ai",
	},
	"ai.removedBuiltinPresets": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.72");
		},
		section: "persona",
	},
	presets: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.73");
		},
		// Ai.tsx 在 presets 非空时显式传 hint={undefined} 回落到此默认值;为空时传
		// "未配置 ai.presets，可在「完全自定义」下手动填写人格" 覆盖。删除此 hint
		// 会让 presets 非空时 hint 行消失。
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.74");
		},
		section: "ai",
	},

	// ── AI 人格(全局视角:persona.*) ──────────────────────────────────────
	"persona.name": {
		get label() {
			return i18n.t("subs.new.accepts.name");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.75");
		},
		section: "persona",
	},
	"persona.addressUser": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.76");
		},
		section: "persona",
	},
	"persona.addressSelf": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.77");
		},
		section: "persona",
	},
	"persona.catchphrase": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.78");
		},
		section: "persona",
	},
	"persona.traits": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.79");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.80");
		},
		section: "persona",
	},
	"persona.baseRole": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.81");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.82");
		},
		section: "persona",
	},
	"persona.extraSystemPrompt": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.83");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.84");
		},
		section: "persona",
	},

	// ── 卡片样式 ──────────────────────────────────────────────────────────
	liveCoverImageIds: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.85");
		},
		section: "cardStyle",
	},
	// 卡片皮肤(ADR-0014):整套外观住皮肤包里,旧的一维版式编辑器已退役。全局那一档
	// 由皮肤库当场启用(PUT /api/cards/skins/active),不走草稿;这个 code 只给 per-UP
	// 的「这个 UP 用哪套」——「跟随全局」= 把 overrides.cardSkin 整个键清掉。
	cardSkin: {
		get label() {
			return i18n.t("cards.skin.perSubTitle");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.86");
		},
		section: "cardStyle",
	},

	// ── 卡片预览(Cards 页样本数据,不真正写回 globals) ───────────────────
	// 4-14:真数据改问订阅的来源要(`Source.fetchPreview`),房间号 / uid / 第几条三格退役。这张表的字随 4-53b 收。
	subscriptionId: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.87");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.88");
		},
		section: "cardPreview",
	},
	nth: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.89");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.90");
		},
		section: "cardPreview",
	},
	text: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.91");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.92");
		},
		section: "cardPreview",
	},
	amount: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.93");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.94");
		},
		section: "cardPreview",
	},
	rank: {
		get label() {
			return i18n.t("cards.content.superchatRank");
		},
		section: "cardPreview",
	},
	durationSec: {
		get label() {
			return i18n.t("cards.content.superchatDuration");
		},
		section: "cardPreview",
	},
	tierKey: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.95");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.96");
		},
		section: "cardPreview",
	},

	// ── 过滤 ──────────────────────────────────────────────────────────────
	blockKeywords: {
		get label() {
			return i18n.t("sourceUi.pages.History.blockedkeyword.12");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.97");
		},
		section: "filter",
	},
	blockRegex: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.98");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.99");
		},
		section: "filter",
	},
	allowKeywords: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.100");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.101");
		},
		section: "filter",
	},
	allowRegex: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.102");
		},
		section: "filter",
	},
	blockReposts: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.103");
		},
		section: "filter",
	},
	blockArticles: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.104");
		},
		section: "filter",
	},
	blockImages: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.105");
		},
		section: "filter",
	},
	blockVideos: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.106");
		},
		section: "filter",
	},

	// ── 互动门槛 ──────────────────────────────────────────────────────────
	// 两个直播门槛(㉓d)从 filters 搬成 superchat / membership 两段,code 带段名(灵动岛 diff 保 nested)。
	"superchat.minAmount": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.107");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.108");
		},
		section: "interaction",
	},
	// 一段(或 minRank 这一层)整个从无到有 / 整个拿掉时,灵动岛的 diff 按整段报(code 是段本身,不是里面的格):也要有名字,
	// 不掉进「其他」—— 第一次选档位时 `membership.minRank` 就是从无到有,开启逐订阅覆盖时 `superchat` / `membership` 也是。
	superchat: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.107");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.108");
		},
		section: "interaction",
	},
	membership: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.109");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.110");
		},
		section: "interaction",
	},
	"membership.minRank": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.109");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.110");
		},
		section: "interaction",
	},

	// ── 调度 ──────────────────────────────────────────────────────────────
	// 直播拆键(⑬d):周期「正在直播」有自己的开关(全局默认 + 每个订阅可覆盖)与间隔;旧的「间隔 0 = 关」里「关」
	// 的意思归开关,所以间隔的说明里没有「填 0」那句。启动补报是 `liveStart.catchUpOnBoot`。
	"features.liveStreaming": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.111");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.112");
		},
		section: "schedule",
	},
	"liveStreaming.streamingIntervalHours": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.113");
		},
		section: "schedule",
	},
	"liveStart.catchUpOnBoot": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.114");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.115");
		},
		section: "schedule",
	},
	"schedule.liveEndGrace": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.116");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.117");
		},
		section: "schedule",
	},
	"schedule.liveEndGraceMinutes": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.118");
		},
		get hint() {
			return i18n.t("sourceUi.pages.rules.sections.hint.38");
		},
		section: "schedule",
	},
	"schedule.quietHours": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.119");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.120");
		},
		section: "schedule",
	},

	// ── 消息模板 ──────────────────────────────────────────────────────────
	"templates.liveSummary": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.121");
		},
		section: "templates",
	},
	"templates.wordcloudStopWords": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.122");
		},
		section: "templates",
	},
	"templates.liveStart": {
		get label() {
			return i18n.t("sourceUi.pages.Stats.label.31");
		},
		section: "templates",
	},
	// 消息版式(发送侧结构):分隔符经 Field 编辑;blocks 数组由版式编辑器整体管理,
	// 灵动岛 diff 时按叶子 code 命中下列条目。
	"messageLayout.post.separator": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.123");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.124");
		},
		section: "templates",
	},
	"messageLayout.live.separator": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.125");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.124");
		},
		section: "templates",
	},
	"messageLayout.post.blocks": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.126");
		},
		section: "templates",
	},
	"messageLayout.live.blocks": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.127");
		},
		section: "templates",
	},
	"templates.liveStreaming": {
		get label() {
			return i18n.t("sourceUi.pages.rules.sections.label.68");
		},
		section: "templates",
	},
	"templates.liveEnd": {
		get label() {
			return i18n.t("sourceUi.pages.rules.sections.label.69");
		},
		section: "templates",
	},
	"templates.post": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.128");
		},
		section: "templates",
	},
	"templates.postVideo": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.129");
		},
		section: "templates",
	},
	"templates.viewerChat": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.130");
		},
		section: "templates",
	},
	"templates.viewerEnter": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.131");
		},
		section: "templates",
	},
	// Membership fields are resolved dynamically from their program/tier path below.

	// ── 特别关注 / Special UID ────────────────────────────────────────────
	specialViewers: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.136");
		},
		section: "specialViewers",
	},

	// ── 动态图集 ──────────────────────────────────────────────────────────
	"imageGroup.enabled": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.137");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.138");
		},
		section: "imageGroup",
	},
	"imageGroup.mergeForward": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.139");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.140");
		},
		section: "imageGroup",
	},

	// ── 卡片自定义模板 special user 子表(PerUpEditor SpecialUserBox) ─────
	template: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.141");
		},
		section: "templates",
	},
	imageUrl: {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.142");
		},
		section: "templates",
	},
	targetId: {
		get label() {
			return i18n.t("stats.push.target");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.143");
		},
		section: "target",
	},

	// ── Targets(推送目标 / 连接 / 传输 / 会话) ────────────────────────
	"connection.platform": {
		get label() {
			return i18n.t("sourceUi.pages.stats.csv.header.1");
		},
		section: "connection",
	},
	"connection.name": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.144");
		},
		section: "connection",
	},
	"connection.enabled": {
		get label() {
			return i18n.t("aiSettings.page.hero.enable");
		},
		section: "connection",
	},
	"settings.transport": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.145");
		},
		section: "transport",
	},
	"settings.baseUrl": { label: "HTTP baseUrl", section: "transport" },
	"settings.url": { label: "URL", section: "transport" },
	"settings.port": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.146");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.147");
		},
		section: "transport",
	},
	"settings.accessToken": {
		label: "accessToken",
		section: "transport",
		secret: true,
	},
	"settings.timeoutMs": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.148");
		},
		section: "transport",
	},
	"settings.imageMinTimeoutMs": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.149");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.150");
		},
		section: "transport",
	},
	"settings.mergeForwardMinTimeoutMs": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.151");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.152");
		},
		section: "transport",
	},
	"settings.maxRetries": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.153");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.154");
		},
		section: "transport",
	},
	"settings.retryIntervalMs": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.155");
		},
		section: "transport",
	},
	"settings.headers": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.156");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.157");
		},
		section: "transport",
	},
	"settings.secret": {
		label: "Secret",
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.158");
		},
		section: "transport",
		secret: true,
	},
	// QQ 官方机器人(q.qq.com)连接凭据
	"settings.appId": {
		label: "AppID",
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.159");
		},
		section: "transport",
	},
	"settings.appSecret": {
		label: "AppSecret",
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.160");
		},
		section: "transport",
		secret: true,
	},
	"settings.botType": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.161");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.162");
		},
		section: "transport",
	},
	"settings.sandbox": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.163");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.164");
		},
		section: "transport",
	},
	"settings.logReconnects": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.165");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.166");
		},
		section: "transport",
	},
	"target.name": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.144");
		},
		section: "target",
	},
	"target.scope": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.167");
		},
		section: "target",
	},
	"target.enabled": {
		get label() {
			return i18n.t("aiSettings.page.hero.enable");
		},
		section: "target",
	},
	// 地址这一格原先是每平台一套 session 字段(session.groupId / session.groupOpenid / …),
	// 六个词条对着六个字段名。收成一格之后只剩这两条 —— 界面上叫什么由 scope 决定,
	// 但差异摘要里不该逐 scope 换名字(同一格改了就是改了)。
	"target.address": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.168");
		},
		section: "target",
	},
	"target.parentAddress": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.169");
		},
		section: "target",
	},

	// ── 定时周报(roastSchedule.*) ─────────────────────────────────────────
	// 周期与统计范围是**解耦**的两个字段:cron 定何时发,days 定统计多少天。
	// 不预设「周报 / 月报」这类组合 —— 用户自己搭。
	"roastSchedule.enabled": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.170");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.171");
		},
		section: "schedule",
	},
	"roastSchedule.approval": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.172");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.173");
		},
		section: "schedule",
	},
	"roastSchedule.notifyOnError": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.174");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.175");
		},
		section: "schedule",
	},
	"roastSchedule.cron": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.176");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.177");
		},
		section: "schedule",
	},
	"roastSchedule.days": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.178");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.179");
		},
		section: "schedule",
	},
	"roastSchedule.targets": {
		get label() {
			return i18n.t("sourceUi.config.field.labels.label.180");
		},
		get hint() {
			return i18n.t("sourceUi.config.field.labels.hint.181");
		},
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
 * 它的 code 是**动态**的 —— `templatesSeen.<任意模板路径>`,模板加一条这里
 * 就多一条,逐个登记进 FIELD_LABELS 等于把同一份清单抄两遍(而且必然有人忘)。
 * 所以走前缀 fallback,label 直接**借对应模板字段自己的名字**:模板哪天改名,
 * 账本这条跟着改,不会两边对不上。`formatDiffValue.ts` 也引这一份。
 */
export const SEEN_PREFIX = "templatesSeen.";

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
	const writingTarget = /^(ai\.writing\.(?:post|liveSummary)\.byTarget)\.([^.]+)$/.exec(code);
	if (writingTarget) {
		const owner = getFieldLabel(writingTarget[1] ?? "");
		if (owner)
			return {
				...owner,
				label: `${owner.label} · ${writingTarget[2]}`,
				formatter: (value) => (value ? i18n.t("aiWriting.ai") : i18n.t("aiWriting.template")),
			};
	}
	const logPrefix = "core.logging.levels.";
	if (code.startsWith(logPrefix) && code.length > logPrefix.length) {
		const key = code.slice(logPrefix.length);
		return {
			get label() {
				return `${key} · ${i18n.t("logging.levelLabel")}`;
			},
			section: "logging",
		};
	}
	const minimum = /^membership\.minRank\.([^.]+)$/.exec(code);
	if (minimum)
		return {
			get label() {
				return `${minimum[1]} · ${i18n.t("sourceUi.config.field.labels.label.182")}`;
			},
			section: "interaction",
		};
	const membership =
		/^templates\.membership\.([^.]+)(?:\.(enabled|default(?:\.(template|imageUrl))?|tiers(?:\.[^.]+(?:\.(template|imageUrl))?)?))?$/.exec(
			code,
		);
	if (membership) {
		const field = membership[3] ?? membership[4];
		const label =
			field === "template"
				? membership[2]?.startsWith("default")
					? i18n.t("sourceUi.config.field.labels.label.134")
					: i18n.t("sourceUi.config.field.labels.getFieldLabel.183")
				: field === "imageUrl"
					? membership[2]?.startsWith("default")
						? i18n.t("sourceUi.config.field.labels.label.135")
						: i18n.t("sourceUi.config.field.labels.getFieldLabel.184")
					: membership[2] === "enabled"
						? i18n.t("sourceUi.config.field.labels.getFieldLabel.185")
						: i18n.t("sourceUi.config.field.labels.getFieldLabel.186");
		const tier = /\.tiers\.([^.]+)/.exec(code)?.[1];
		return {
			label: [membership[1], tier, label].filter(Boolean).join(" · "),
			section: "templates",
		};
	}
	if (code.startsWith(SEEN_PREFIX)) {
		const path = code.slice(SEEN_PREFIX.length);
		const owner = getFieldLabel(`templates.${path}`);
		return {
			get label() {
				return i18n.t("sourceUi.config.field.labels.label.187", { value1: owner?.label ?? path });
			},
			get hint() {
				return i18n.t("sourceUi.config.field.labels.hint.188");
			},
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
