import { z } from "zod";
import { DEFAULT_ROAST_SCHEDULE } from "../ai";
import { DEFAULT_FEATURE_FLAGS } from "../features";
import { DEFAULT_HISTORY_RETENTION_DAYS, HISTORY_RETENTION_DAY_OPTIONS } from "../history";
import { LOCALES, VOICES } from "../i18n";
import { DEFAULT_TIMEZONE, isTimezone } from "../timezone";
import { MIRROR_PREFIX_RE } from "../update";
import { CardSkinIdSchema, CardSkinKnobOverridesSchema, DEFAULT_CARD_SKIN_ID } from "./card-skin";
import { CommandConfigSchema, DEFAULT_COMMAND_CONFIG } from "./commands";
import {
	type AISettings,
	AISettingsSchema,
	type CardsSettings,
	CardsSettingsSchema,
	ContentFiltersSchema,
	DEFAULT_CONTENT_FILTERS,
	DEFAULT_IMAGE_GROUP,
	DEFAULT_LIVE_START,
	DEFAULT_LIVE_STREAMING,
	DEFAULT_MEMBERSHIP_SETTINGS,
	DEFAULT_SCHEDULE,
	DEFAULT_SUPERCHAT_SETTINGS,
	FeatureFlagsSchema,
	ImageGroupSettingsSchema,
	LiveStartSettingsSchema,
	LiveStreamingSettingsSchema,
	MembershipSettingsSchema,
	ScheduleConfigSchema,
	SuperchatSettingsSchema,
	TemplateBundleSchema,
} from "./common";
import { isPrototypeName, prototypeNameMessage } from "./extension-manifest";
import { DEFAULT_LINK_PREVIEW, LinkPreviewSettingsSchema } from "./link-preview";
import { DEFAULT_MESSAGE_LAYOUT, MessageLayoutSchema } from "./message-layout";
import { RoastScheduleSchema } from "./roast-schedule";
import { markBackupOnly, markSecret } from "./secret";

/** 启动时注入、运行时只读的引导配置。 */
export const BootstrapConfigSchema = z.object({
	server: z.object({
		host: z.string().default("0.0.0.0"),
		port: z.number().int().min(1).max(65535).default(8787),
	}),
	dataDir: z.string(),
	cookieEncryptionKey: z.string().min(16, "cookieEncryptionKey must be at least 16 chars"),
	dashboardAuth: z
		.object({
			username: z.string(),
			password: markSecret(z.string()),
		})
		.optional(),
});
export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;

export const LogLevelSchema = z.enum(["error", "warn", "info", "debug"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * 日志等级的按键覆盖:键是核心的三格(`core` / `image` / `ai`)或集成键(B 站的 `bilibili`、三个内置适配器的键、
 * 拓展 id);没写的键跟 `logging.level`。一行日志是谁的代码打的就跟谁那一格(核心的作品队列与替拓展跑的直播场次跟 `core`)。
 *
 * 键是**开放**的字符串 —— 集成的集合不写死在 schema 里;键是 PATCH 能写进来的任意文本,所以过原型名那道检查
 * (与 `extensions` 表、来源键同一条规矩)。写了没有对应集成的键(拓展卸了、还没装、拼错了)会留在盘上、不起作用,
 * 等那个集成出现才生效。
 */
export const ModuleLogLevelsSchema = z.record(
	z
		.string()
		.min(1)
		.max(64)
		.refine((key) => !isPrototypeName(key), prototypeNameMessage("日志模块的键 ")),
	LogLevelSchema,
);
export type ModuleLogLevels = z.infer<typeof ModuleLogLevelsSchema>;

/**
 * dynamic 轮询 cron 默认值。B 站设置的 `dynamicCron`(`apps/server/src/bilibili/settings.ts`)用它;引擎 3a-24 已搬进
 * `apps/server/src/bilibili/dynamic`,这个常量还留在这里,3a 里跟过去。
 *
 * **六字段**(秒 分 时 日 月 周),秒位是 `30` —— 每 2 分钟的第 30 秒拉,而不是整分。
 * 整分是全网默认节拍:一堆客户端(以及本项目此前的所有实例)都卡在 `:00` 同时打
 * B 站接口,人为堆出一个流量尖峰。错开半分钟不改变频率、不多花一个请求,只是把
 * 自己从那个尖峰里挪出来,降低撞上限流(-509)的面。
 *
 * 秒字段是 `cron` 包的可选首字段(3.x 起支持,已实测),标准五字段表达式仍然合法 ——
 * 用户在 dashboard 里填五字段照常工作,这里只是默认值换了形态。
 */
export const DEFAULT_DYNAMIC_CRON = "30 */2 * * * *";

/**
 * 资料刷新(粉丝数轮询,独立端 FansPoller)cron 默认值。粉丝曲线要不了动态那样的 2min
 * 精度,独立成一档更慢的节奏 —— 每 UP 一个请求,拉长间隔直接降低风控面。
 * 对应顶层 `profileRefreshCron`。
 */
export const DEFAULT_PROFILE_REFRESH_CRON = "*/10 * * * *";

/** 登录健康检查间隔(分钟)默认值。B 站设置的 `healthCheckMinutes` 用它(同 {@link DEFAULT_DYNAMIC_CRON})。 */
export const DEFAULT_HEALTH_CHECK_MINUTES = 30;

/**
 * 推送历史的设置。只有一格:**图片与重推原件**留几天,只许七档({@link HISTORY_RETENTION_DAY_OPTIONS})。
 * 推送记录的文字不在其内 —— 文字不设上限、也没有设置项(ADR-0022 决策 9)。
 */
export const HistorySettingsSchema = z.object({
	retentionDays: z
		.literal([...HISTORY_RETENTION_DAY_OPTIONS])
		.default(DEFAULT_HISTORY_RETENTION_DAYS),
});
export type HistorySettings = z.infer<typeof HistorySettingsSchema>;
export const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
	retentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
};

/**
 * 数据统计的设置(ADR-0027 决策 9、16)。只有一格总开关:开着才记作品、直播场次、粉丝样本与「在记」的账,
 * 关了就不记、已攒的数据留着。资料刷新、当前粉丝数照常。
 *
 * 顶层一节而不是挂在 `defaults` 下:订阅覆盖不了它。缺这一节的老设置 / 老备份靠默认值补成开着,不走迁移。
 */
export const StatsSettingsSchema = z.object({
	enabled: z.boolean().default(true),
});
export type StatsSettings = z.infer<typeof StatsSettingsSchema>;
export const DEFAULT_STATS_SETTINGS: StatsSettings = { enabled: true };

/**
 * 日志设置:全局等级、按模块覆盖、归档保留天数、内存自检开关。
 *
 * 顶层 `logging` 必填、不带 default —— 与拆掉之前的 `app` 同一个松紧(缺了它整份设置开不了机,而不是悄悄补默认)。
 * B 站那两格(`dynamicCron` / `healthCheckMinutes`)在 B 站自己的设置文件里
 * (`apps/server/src/bilibili/settings.ts`,ADR-0021 决策 42 下 10-01 的 🔗)。
 */
export const LoggingSettingsSchema = z.object({
	level: LogLevelSchema.default("info"),
	/** 按键覆盖,没写的键跟 `level`。默认空表,读者不用再多写一层 `?.`。 */
	levels: ModuleLogLevelsSchema.default({}),
	/**
	 * 日志归档保留天数。`startLogRetention` 每轮按此删除更旧的 day 文件。
	 * 默认比图片保留天数短(日志量远高于推送历史、长期价值低)。
	 */
	retentionDays: z.number().int().min(1).max(365).default(7),
	/**
	 * 内存自检打印:开着就每 10 分钟往日志写一行 `[mem]`(堆用量 / 上限 / 占比 / RSS /
	 * 弹幕收集器规模)。默认关 —— 概览页的「系统资源」卡已经实时在看,这行只给要留一条
	 * 长曲线排泄漏的人。堆逼近上限的 warn 不归它管,始终在。
	 */
	memoryLog: z.object({ enabled: z.boolean().default(false) }).default(() => ({ enabled: false })),
});
export type LoggingSettings = z.infer<typeof LoggingSettingsSchema>;

export const MasterConfigSchema = z.object({
	/** 用于错误私聊的 PushTarget.id,只许指向私聊目标(`isPrivateTarget`);undefined 时不发私聊。 */
	targetId: z.uuid().optional(),
});
export type MasterConfig = z.infer<typeof MasterConfigSchema>;

/**
 * 全局默认值；resolve(sub, globals) 在 per-UP overrides 缺字段时回退到这里。
 * AI 设置已上提到顶层 `ai`(3a-38 提交 ④);人格预设 `defaults.ai.presetId` 这一格随 AI 子键改名那一片造。
 */
export const GlobalDefaultsSchema = z.object({
	features: FeatureFlagsSchema,
	filters: ContentFiltersSchema,
	schedule: ScheduleConfigSchema,
	// 直播拆键(⑬d):启动补报与周期间隔各一段,开关在 `features`(`liveStart` / `liveStreaming`)。
	liveStart: LiveStartSettingsSchema,
	liveStreaming: LiveStreamingSettingsSchema,
	// 醒目留言与会员的门槛(㉓d,原先是 `filters.minScPrice` / `minGuardLevel`):没配 = 不设门槛,缺这两段的老配置补成空段。
	superchat: SuperchatSettingsSchema.default(() => structuredClone(DEFAULT_SUPERCHAT_SETTINGS)),
	membership: MembershipSettingsSchema.default(() => structuredClone(DEFAULT_MEMBERSHIP_SETTINGS)),
	// 文字模板只存主人改过的(缺 = 跟随当前语言的默认);`.prefault` 让内层的非文字格(停用词)照常补默认。
	templates: TemplateBundleSchema.prefault({}),
	// 卡片设置(㉔e):出图总开关与直播封面,不再按卡种分层。缺这一段的老配置补出厂值。
	cards: CardsSettingsSchema.default(() => structuredClone(DEFAULT_CARDS)),
	// 全局用哪套卡片皮肤(ADR-0014)。缺字段的老 globals.json 补成内置默认皮肤;版式
	// 本身住皮肤包里,不再住配置。存量的 `cardLayout` 键**直接丢**(决策 17 的
	// 2026-09-18 🔗:迁移退役,升级上来的一律用出厂默认皮肤)—— 这几个配置 schema 都是
	// 裸 `z.object`,zod 对未知键是 strip,老存档照样装得进来,那个键下次写盘时消失。
	cardSkin: CardSkinIdSchema.default(DEFAULT_CARD_SKIN_ID),
	/**
	 * 用户拧过的**皮肤旋钮**,按皮肤 id 分开存(ADR-0014 决策 16 的 🔗,2026-09-14)。
	 *
	 * 按 id 存是为了「换回来还在」:一套皮肤调好的配色,换去别的皮肤再换回来不该清零。
	 * **存覆盖不存值** —— 没拧过的键根本不在表里,渲染时让皮肤 CSS 自己的兜底生效
	 * (默认皮肤的玻璃白纱三档基线就靠这个活着)。不分卡种:皮肤想让两种卡不同色,
	 * 自己声明两枚旋钮。
	 */
	cardSkinKnobs: z.record(CardSkinIdSchema, CardSkinKnobOverridesSchema).default({}),
	// 消息版式(发送侧结构):与 cardLayout 同款迁移友好策略,缺字段的老 globals.json
	// load 时自动补默认(= 复刻现状:卡片+文本+链接合并一条)。
	messageLayout: MessageLayoutSchema.default(() => structuredClone(DEFAULT_MESSAGE_LAYOUT)),
	// `.default(...)` 让缺 imageGroup 字段的老 globals.json(在加 imageGroup 子段
	// 之前持久化的)load 时被 zod 自动补全 —— 否则 ConfigValidationError 让独立端
	// 启动直接挂。新字段加 GlobalDefaults 时都该带 default,保留迁移友好性。
	imageGroup: ImageGroupSettingsSchema.default(DEFAULT_IMAGE_GROUP),
});
export type GlobalDefaults = z.infer<typeof GlobalDefaultsSchema>;

/**
 * 新手指引的三态持久标记(2026-08-30 主人定案改版)。
 *
 * - **缺失 = 还没问过**:打开面板时屏幕中间弹询问框(新用户开始指引 / 老用户跳过),
 *   升级上来的存量实例与全新安装都落在这档 —— 所以 `skipped` **刻意不带 default**,
 *   补成 false 等于永远不问、对老用户直接开导览(上一版正是这么被主人打回的);
 * - `false` = 要指引:导览(左缘标签 ⇄ 小卡)出现;
 * - `true` = 不要:整个导览不渲染。写入的三条路 —— 询问框选「老用户」、小卡上的
 *   「跳过指引」、走完五步毕业;系统页的「重新开启」写回 false。
 *
 * 落在配置而非 localStorage:「这台实例问过了没」是实例级事实,换台机器、换个
 * 浏览器开面板不该再被问一遍。
 */
export const OnboardingConfigSchema = z.object({
	skipped: z.boolean().optional(),
});
export type OnboardingConfig = z.infer<typeof OnboardingConfigSchema>;

/** 全新安装 = 还没问过:第一次开面板弹询问框,由用户自己选。 */
export const DEFAULT_ONBOARDING: OnboardingConfig = {};

/**
 * 应用内自主升级的用户可调项。
 *
 * 三条默认值都是产品定案,别顺手改:
 *
 * - **`channel` 默认正式版**。预发布按定义就是没验够的版本;自主升级已经把「发了个
 *   坏版本」的爆炸半径放大到全体,默认把人放进预发布渠道等于再乘一次。
 * - **`autoDownload` 默认开,但从不自动应用**。下载是无副作用的 —— 装进一个新的
 *   版本目录,不碰正在跑的那份;应用要重启服务,那一刻推送会断、直播监听会掉,
 *   必须是用户按下去的。
 * - **`mirrors` 默认空**。硬编码一个第三方加速站当默认值,等于让每一个安装都去和
 *   它说话,它哪天挂了或者易主,我们只能靠发新版本来收回这个默认值。签名保证了
 *   代理站最多只能拒绝服务(改一个字节就验不过),但「默认和谁说话」仍然该是用户
 *   的决定。列表**顺序即优先级**,直连永远排在用户填的这些之后。
 */
export const UpdateSettingsSchema = z.object({
	channel: z.enum(["stable", "prerelease"]).default("stable"),
	autoDownload: z.boolean().default(true),
	/**
	 * 只收 `https://` 前缀、封顶 10 条 —— 这是要去真连的地址,和 `POST /api/system/update/mirrors/probe`
	 * 那道门一样严:不封顶的话一次检查的总耗时没有上限(N × 超时),期间检查一直挂着;不限
	 * scheme 的话这里就成了一个让服务端去连任意主机的入口。面板只会写进合法的 —— 判定用的
	 * 是与面板、路由同一条正则(`MIRROR_PREFIX_RE`),三处不会各判各的。
	 */
	mirrors: z
		.array(z.string().regex(MIRROR_PREFIX_RE, "加速前缀必须是 https:// 开头的地址"))
		.max(10)
		.default([]),
});
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
	channel: "stable",
	autoDownload: true,
	mirrors: [],
};

/**
 * 拓展市场的源(ADR-0013)。官方源是内置的、不能删,**不在这里**;这里只有主人自己加的
 * 第三方源 —— 一个 https 地址指向一份 `marketplace.json`。
 */
export const MarketplaceSourceSchema = z.object({
	/** 本地身份(uuid);已装拓展记「从哪个源装的」靠它。 */
	id: z.string().min(1).max(64),
	/**
	 * 可选:索引自己带 `name`,拿到之后以它为准;这里只在索引还没拿到 / 拿不到时顶一下。
	 * 用户加源时**只填地址**,不用起名。
	 */
	name: z.string().min(1).max(40).optional(),
	url: markBackupOnly(z.string().url().regex(MIRROR_PREFIX_RE, "源地址必须是 https:// 开头"), {
		url: true,
	}),
});
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;

export const MarketplaceSettingsSchema = z.object({
	/** 封顶 20 条 —— 打开市场那一页会去真连每一个。 */
	sources: z.array(MarketplaceSourceSchema).max(20).default([]),
});
export type MarketplaceSettings = z.infer<typeof MarketplaceSettingsSchema>;

export const DEFAULT_MARKETPLACE_SETTINGS: MarketplaceSettings = { sources: [] };

/**
 * 宿主记的一个拓展的持久状态:主人按的开关。拓展自己的那份设置不在这儿,在它自己的文件
 * `config/settings/extensions/<id>.json`(ADR-0021 决策 42 下 10-01 的 🔗):开关归宿主,放进拓展的文件的话,
 * 那个文件一坏,关掉它的开关也读不出来。盘上残留的 `settings` 这一格读的时候被剥掉(不是 strict),
 * 迁移器早把它搬进了拓展自己的文件。
 */
export const ExtensionStateSchema = z.object({
	enabled: z.boolean().default(false),
});
export type ExtensionState = z.infer<typeof ExtensionStateSchema>;

export const GlobalConfigSchema = z.object({
	logging: LoggingSettingsSchema,
	/**
	 * 资料刷新(粉丝数轮询)的 cron。从动态轮询的 cron 解耦,默认更慢降风控。
	 * 不在 schema 里校验 cron 语法:`roast-schedule.ts` 里说的那条理由(用户编辑途中改一个字就存不了盘)同样适用。
	 */
	profileRefreshCron: z.string().default(DEFAULT_PROFILE_REFRESH_CRON),
	/**
	 * 全局时区(ADR-0021 决策 43):卡上的时间与服务端的按天切都读它,IANA 名(如 `Asia/Shanghai`)。
	 * 出厂值是 `DEFAULT_TIMEZONE`(ADR 定死,`Asia/Shanghai`)。
	 *
	 * **必填、带 `.default`**:默认值由 ADR 定死,没有「新装要猜」的余地,所以不照 `locale` / `voice`
	 * 写成可选、由读点按规则补 —— 老配置缺这一格由 `parse` 补上并与别处共用一份默认值。
	 */
	timezone: z
		.string()
		.refine(isTimezone, "不是认得的时区名，要写 IANA 名，比如 Asia/Shanghai")
		.default(DEFAULT_TIMEZONE),
	/** 推送历史:图片与重推原件的保留天数。缺这一节的老设置补默认。 */
	history: HistorySettingsSchema.default(() => structuredClone(DEFAULT_HISTORY_SETTINGS)),
	stats: StatsSettingsSchema.default(() => structuredClone(DEFAULT_STATS_SETTINGS)),
	master: MasterConfigSchema,
	defaults: GlobalDefaultsSchema,
	/**
	 * 「这条我改的时候,简体默认长这样」的账本:点路径 → 那一刻**简体**出厂原文的指纹。
	 *
	 * 文字模板只存主人改过的(ADR-0037 决策 10),没存的跟当前语言的出厂走,不会"过期";只有存着的那几条,
	 * 后来简体出厂文案变了才值得提示他。面板在主人第一次改某条时记下指纹(「保持我的」记新指纹,
	 * 「恢复默认」「用新默认」删这一条);账本里没有的条目不亮灯。判定见 `../template-defaults.ts`。
	 *
	 * 放顶层而非 `defaults`(3a-38):它是面板的簿记、不是「per-UP overrides 缺字段时回退到这里」的值。
	 *
	 * 全新安装是空的(一条文字都没存);`.default({})` 同时是老配置的兜底(同 imageGroup)。
	 */
	templatesSeen: z.record(z.string(), z.string()).default({}),
	/**
	 * AI 设置(服务商、人格、聊天、联网搜索……整段)。放顶层而非 `defaults`(3a-38 提交 ④):
	 * 它不是「per-UP overrides 缺字段时回退到这里」的值 —— 订阅只能从 `ai.presets` 里挑一份人格。
	 * 里面的键一个没动;人格指针 `activePreset` 随整段在这里(`defaults.ai.presetId` 随 AI 子键改名那一片造)。
	 *
	 * 必填、不带 default:与原来的 `defaults.ai` 同一个松紧。
	 */
	ai: AISettingsSchema,
	/**
	 * 榜单周报的定时推送 —— 全局唯一一条。
	 *
	 * 放顶层而非 `defaults`:`defaults` 的语义是「per-UP overrides 缺字段时回退到
	 * 这里」,而榜单周报压根不是 per-UP 的东西,单人锐评那条(挂在 Subscription
	 * 顶层)也不该继承它 —— 两者内容根本不同。
	 *
	 * `.default(...)` 同 imageGroup / cardLayout:缺这个字段的老 globals.json 在
	 * 独立端启动时被 `parse` 自动补全,否则直接 ConfigValidationError 开不了机。
	 */
	roastSchedule: RoastScheduleSchema.default(() => structuredClone(DEFAULT_ROAST_SCHEDULE)),
	/**
	 * 全局静音到哪一刻(epoch ms)。`0` = 没在静音。
	 *
	 * 放顶层的理由同 `roastSchedule`:`defaults` 的语义是「per-UP overrides 缺字段时
	 * 回退到这里」,而静音压根不是 per-UP 的东西 —— 它是「现在别推给我」这一个开关。
	 *
	 * 存**到期时刻**而不是「剩余多久」,判定就永远是 `now < mutedUntil` 一个比较:
	 * 重启、时钟跳变、进程睡过去都不影响它,不需要任何定时器或恢复逻辑。落在 globals
	 * 里则顺带拿到两件事 —— 重启不解除静音,以及网页上看得见(指令能做的事,面板上
	 * 都得有一份)。
	 */
	mutedUntil: z.number().int().min(0).default(0),
	/**
	 * 私聊指令的可配置项(前缀 / 别名 / 总开关)。
	 *
	 * 放顶层同 `roastSchedule`:它不是「per-UP overrides 缺字段时的回退」。
	 */
	commands: CommandConfigSchema.default(() => structuredClone(DEFAULT_COMMAND_CONFIG)),
	/**
	 * 链接预览(群里贴视频链接自动出卡片),五格:总开关、默认回不回、回复形式、逐目标例外、冷却。
	 * 独立端专有,放顶层同 `commands`。
	 * `.default(...)` 是老配置兜底:少了它,存量实例升上来第一件事就是开不了机。
	 */
	linkPreview: LinkPreviewSettingsSchema.default(() => structuredClone(DEFAULT_LINK_PREVIEW)),
	/**
	 * 新手指引的持久状态。
	 *
	 * 放顶层同 `commands`:它不是「per-UP overrides 缺字段时的回退」。
	 * `.default(...)` 是老配置兜底 —— 独立端启动时 `parse` 会补上,理由见
	 * `./__tests__/onboarding-skipped.test.ts`。
	 */
	onboarding: OnboardingConfigSchema.default(DEFAULT_ONBOARDING),
	/**
	 * 自主升级的用户可调项。放顶层同 `commands` —— 它不是「per-UP overrides 缺字段
	 * 时的回退」。`.default(...)` 是老配置兜底:独立端启动时 `parse` 会补上,
	 * 少了它,存量实例升上来第一件事就是开不了机。
	 */
	update: UpdateSettingsSchema.default(() => structuredClone(DEFAULT_UPDATE_SETTINGS)),
	/**
	 * 界面语言(ADR-0037 决策 2、7、17)。放顶层同 `commands`:订阅覆盖不了。
	 *
	 * **刻意可选、不带 `.default`**:缺 = 按 `textSettingsOf` 那一条规则取默认,默认不落盘 ——
	 * 补成 `zh-CN` 写进盘,就分不出「新装还没选过」与「选了简中」。读它一律走 `textSettingsOf`,
	 * 不在读点各写 `?? "zh-CN"`。老配置缺这一格照常开机;「改回跟默认走」是 PATCH 发 `null` 删键。
	 */
	locale: z.enum(LOCALES).optional(),
	/**
	 * 文案口吻(ADR-0037 决策 3):女仆版或平实版。可选、不带 `.default` 的理由同 `locale`:
	 * 默认第 4 期才定,现在写进盘,改默认时没动过的人就跟不上了。
	 */
	voice: z.enum(VOICES).optional(),
	/**
	 * 拓展的开关,键是拓展 id(= 装载目录名 = 挂载点那一段)。
	 *
	 * **开放词表**,不是 `z.enum`:模块是编进产物的,而配置活得比某一版产物久 —— 一次
	 * 回退、一次撤下,配置里就会多出一个当下没人认领的 id。闭集会把它判成非法(整份
	 * globals 开不了机)或者被抹掉(用户再升回来时开关被人悄悄关了)。
	 *
	 * 读它用 {@link isExtensionEnabled} —— **缺失 = 关着**,别在读点各写各的 `?? false`。
	 */
	extensions: z.record(z.string(), ExtensionStateSchema).default({}),
	/** 拓展市场的第三方源。老配置没有这一段 → 空表。 */
	marketplace: MarketplaceSettingsSchema.default(() =>
		structuredClone(DEFAULT_MARKETPLACE_SETTINGS),
	),
	bootstrap: BootstrapConfigSchema.optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * 这个拓展模块开了没有。**缺失 = 关着**:开关是用户按的,桥接模块一开就是在对外收长
 * 连接,不该因为升了一版就自己开起来。
 */
export function isExtensionEnabled(
	config: { extensions?: Record<string, { enabled?: boolean } | undefined> },
	id: string,
): boolean {
	return config.extensions?.[id]?.enabled === true;
}

export const DEFAULT_AI = {
	enabled: false,
	// 全新安装一份实例都没添加 —— 设置页左栏是空的,引擎按「还没配齐」停用。
	// activeProfile 指针先悬空,主人添加第一份时会跟着落过去。
	activeProfile: "",
	providers: {},
	// 内置人格不落盘(只记删了哪几份,缺 = 一份没删);`presets` 只装主人自己建的。
	presets: [] as AISettings["presets"],
	// 全新安装的人格指针直接指着首份内置人格。
	activePreset: "gentle-maid",
} as const;

/** 出厂的卡片设置:出图开着、没有自定义直播封面。 */
export const DEFAULT_CARDS: CardsSettings = { enabled: true, liveCoverImageIds: [] };

/** 工厂:创建一份完整的默认 GlobalConfig(不含 bootstrap)—— server 的出厂值与测试夹具共用。 */
export function makeDefaultGlobalConfig(): GlobalConfig {
	return GlobalConfigSchema.parse({
		logging: {},
		master: {},
		defaults: {
			features: DEFAULT_FEATURE_FLAGS,
			filters: DEFAULT_CONTENT_FILTERS,
			schedule: DEFAULT_SCHEDULE,
			liveStart: DEFAULT_LIVE_START,
			liveStreaming: DEFAULT_LIVE_STREAMING,
			superchat: DEFAULT_SUPERCHAT_SETTINGS,
			membership: DEFAULT_MEMBERSHIP_SETTINGS,
			// 新装不存任何文字格:没改过 = 跟随当前语言的默认(ADR-0037 决策 10)。
			templates: {},
			cards: DEFAULT_CARDS,
			imageGroup: DEFAULT_IMAGE_GROUP,
		},
		ai: DEFAULT_AI,
	});
}
