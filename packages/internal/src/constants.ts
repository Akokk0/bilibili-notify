/**
 * 零依赖的核心词表 —— 常量,加上**只碰几个字段就能答**的纯形状判断(见文件末尾那组连接
 * 谓词)。
 *
 * 🔴 **只许有 `import type`,值级 import 一条都不许**:它经
 * `@bilibili-notify/internal/constants` 子路径**直供浏览器端(apps/web)运行时消费**,
 * 一条值级 import 就能把 zod 与它拽着的整张 schema 图拉进前端 bundle —— 而症状不是报错,
 * 是产物悄悄胖一圈。`import type` 编译后整条擦掉,所以类型随便引。
 * 这条不是靠这段话拦着的,是靠 `constants-imports.test.ts`。
 *
 * schema/common.ts 反向引用这里(`z.enum(FEATURE_KEYS)`)并从根入口重导出,后端消费者
 * (server)照旧从根入口拿 —— 两条路径同一份值。
 */
import type {
	Connection,
	DirectConnection,
	ExtensionConnection,
	WebhookConnection,
} from "./schema/targets.js";

/**
 * 全部可订阅的特性键 —— 每一把都是一类**能单独开关、能配路由**的推送。新增或删除会扩散到
 * FeatureFlags、SubscriptionRouting、Subscription.overrides。
 *
 * 附加项(@全体 / 词云 / AI 总结)不在这里:它们各自挂在某把主特性下面(见
 * {@link PUSH_EXTRAS}),跟着那把特性的开关与目标走,自己没有路由。
 */
export const FEATURE_KEYS = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"specialDanmaku",
	"specialUserEnter",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * 附加项的键。加一个附加项 = 这里加一行 + {@link PUSH_EXTRAS} 里加一行(ADR-0016 决策 1)。
 */
export const EXTRA_KEYS = ["atAllDynamic", "atAllLive", "wordcloud", "liveSummary"] as const;

export type ExtraKey = (typeof EXTRA_KEYS)[number];

/**
 * 按 {@link EXTRA_KEYS} 摊一张「每把附加项一格」的表 —— 出厂值、两张 schema、一张全空的
 * per-目标表,四处共用这一份。
 *
 * 它存在只为收断言:`Object.fromEntries` 的返回类型永远是宽的(`{[k: string]: T}`),
 * 所以从前四个调用点各自补一发 `as`,四种写法还各不相同;其中两处更把 zod 的内部类型
 * (`ZodDefault<ZodRecord<ZodUUID, ZodBoolean>>`)抄进了断言里 —— 那串跟着 zod 升级一漂,
 * 断言就会静默把错误的类型按住。收进泛型之后 `T` 由 `make` 的返回值推断,没有可抄错的东西。
 *
 * 住在零依赖的 constants 里:它是纯函数、一条依赖都不引入(见文件头那条硬规矩),
 * 而消费它的 schema 侧都带 zod。
 */
export const extrasRecord = <T>(make: (k: ExtraKey) => T): Record<ExtraKey, T> =>
	Object.fromEntries(EXTRA_KEYS.map((k) => [k, make(k)])) as Record<ExtraKey, T>;

/**
 * 附加项:挂在某个主特性下面、与本体分开发的一条消息(历史行里 `role: "extra"`)。ADR-0016。
 *
 * 主特性关了它们一起关,主特性推到哪儿它们就跟到哪儿(目标是主特性目标的子集)。
 * 键是**一维**的 —— 每把键自己声明挂在哪把主特性下、面板上叫什么、出厂开不开。@全体
 * 在动态与开播下的出厂值本就不同(动态 OFF、开播 ON),走二维(`extras[附加项][主特性]`)
 * 的话还得再开一层「同一把键在不同特性下默认不同」。
 *
 * `capability` 是这把附加项对**平台能力**的要求(ADR-0016 决策 4 的「有没有平台限制」):
 * 填了就表示目标平台不报这项能力时这把附加项发不出去 —— 面板据此禁用它的开关,推送层
 * 据此跳过。⚠️ 这是能力面,与配置面的三态无关:用户关不掉、也开不了它。不填 = 无限制,
 * 词云 / 总结就是普通消息,哪个平台都发得出去。**别拿 `label` 去判这件事** —— 那是
 * 显示文案,改一次措辞守卫就静默失效。
 *
 * 表里只放代码真读的这几样。**排在本体前还是后、等不等它算完,归各自的发送路**
 * (@全体 在推送层排本体前且不 await;词云 / 总结是直播引擎算完后另发的两次广播)——
 * 见 ADR-0016 决策 4。抄进这张表只会变成没人读的死数据。
 */
export const PUSH_EXTRAS: Record<
	ExtraKey,
	{ feature: FeatureKey; label: string; default: boolean; capability?: "atAll" }
> = {
	atAllDynamic: { feature: "dynamic", label: "@全体", default: false, capability: "atAll" },
	atAllLive: { feature: "live", label: "@全体", default: true, capability: "atAll" },
	wordcloud: { feature: "liveEnd", label: "弹幕词云", default: true },
	liveSummary: { feature: "liveEnd", label: "AI 总结", default: true },
};

/** 四把附加项开关。全局一份、per-UP 一份 partial(schema 见 schema/common.ts)。 */
export type PushExtras = Record<ExtraKey, boolean>;

/** 每个特性的开关 + 四个附加项。schema 本体在 schema/common.ts(`FeatureFlagsSchema`)。 */
export type FeatureFlagValues = Record<FeatureKey, boolean> & { extras: PushExtras };

/** 默认全局值；resolve() 在 per-UP overrides 缺失字段时回退到这里。 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlagValues = {
	dynamic: true,
	live: true,
	liveEnd: true,
	liveGuardBuy: false,
	superchat: false,
	specialDanmaku: false,
	specialUserEnter: false,
	// 出厂值只写在注册表里 —— 两处各抄一份迟早漂。
	extras: extrasRecord((k) => PUSH_EXTRAS[k].default),
};

/**
 * 直连连接器词表 —— 「**怎么**连」这一轴,与「连到**哪个**平台」正交。
 *
 * 今天它的值住在 OneBot config 的 `transport` 里,所以「加一个平台」要连带抄一份传输分支;
 * 提到连接自己身上之后,tencent 走 ws、feishu 走 webhook 这类组合就是两根轴的叉乘,不用再各抄一份。
 * 桥(koishi / astrbot)是这根轴上的另外两档,等接桥那期再进词表。
 */
export const DIRECT_CONNECTORS = ["http", "ws", "ws-reverse", "webhook"] as const;
export type DirectConnector = (typeof DIRECT_CONNECTORS)[number];

/**
 * 推送目标的会话种类。`schema/targets.ts` 的 `PushTargetScopeSchema` 从这里取值 ——
 * 词表住零依赖模块,前端才拿得到运行时的那一份(见文件头 FEATURE_KEYS 那套安排)。
 */
export const PUSH_TARGET_SCOPES = ["group", "private", "channel"] as const;
export type PushTargetScope = (typeof PUSH_TARGET_SCOPES)[number];

/**
 * 推送目标的两支形态 —— `session` 是一个会话(有地址、收得到入站),
 * `endpoint` 是一个单向出站终点(地址烧在连接的 config 里,目标只是个壳)。
 */
export const PUSH_TARGET_KINDS = ["session", "endpoint"] as const;
export type PushTargetKind = (typeof PUSH_TARGET_KINDS)[number];

/**
 * **连接**能连的平台。schema 本体在 schema/targets.ts(`ConnectionPlatformSchema`),
 * 那边从这里取值 —— 与 FEATURE_KEYS 同一套安排:词表住零依赖模块,前端也拿得到。
 *
 * 这是**闭集**,因为每一档都要有一份 config schema、一个 server adapter、一排面板控件。
 * 它以前叫 `PUSH_TARGET_PLATFORMS`,同时也是推送目标那一格的词表 —— 但**目标那边是开的**:
 * 桥驮进来的平台(telegram、discord…)枚举不了,列进闭集等于要求先改词表才能收到它们。
 * 一个类型糊着开、闭两套词表,总有一边是错的,所以拆了。
 */
export const CONNECTION_PLATFORMS = [
	"onebot",
	"qq-official",
	"feishu",
	"dingtalk",
	"wecom",
	"generic",
] as const;
export type ConnectionPlatform = (typeof CONNECTION_PLATFORMS)[number];

/**
 * 一个平台的全部事实 —— 面板怎么叫它、走哪些连接器、它的目标长什么样、收不收得到回复。
 *
 * 这些事实原先散在**六处**各说各的:连接侧闭集与 webhook 那一族(本文件)、入站能力词表
 * (本文件)、面板的平台选择器(`apps/web/src/types/domain.ts` 的 `KNOWN_PLATFORMS`)、
 * 组件库里的色与短名(`packages/ui` 的 `PLATFORM_META`)、目标表单的会话种类与地址称呼
 * (`apps/web/src/pages/Targets.tsx`)、以及 server 那边每个 adapter 自报的 `platforms`。
 * 六份的代价不是重复本身,是**加一个平台要记得改六个地方**,漏掉哪一处都没有编译错 ——
 * 少了色就退灰、少了会话种类就只给通用三档,全都是「能跑但不对」。
 *
 * 所以事实收在这一张表里,那六处改成从它取。色与图标名也在这儿:一个十六进制串是数据、
 * 不是组件,把它留在组件库等于让纯展示件库认识业务平台(那正是 `PlatformIcon` 要改成
 * 注入式的原因)。
 */
export interface PlatformDescriptor {
	/** 面板上的全名 —— 平台选择器那一排写这个。 */
	label: string;
	/** 短名 —— 胶囊、一行小字里写这个;没有图标时的方章取它的**首字**。 */
	shortLabel: string;
	/** 标识色。认不出的平台在展示层退静默档,不在这儿兜底。 */
	tint: string;
	/** 图标名(组件库图标表里的键)。留空 = 走首字母方章。 */
	icon?: string;
	/** 这个平台走得通的连接器,**第一个是默认**(新建连接与迁移回落共用这个答案)。 */
	connectors: readonly DirectConnector[];
	/** 它名下的推送目标是哪一支形态。 */
	targetKind: PushTargetKind;
	/** 会话目标能选的会话种类。endpoint 那一族只有一档,目标本来就没得选。 */
	scopes: readonly PushTargetScope[];
	/** 地址那一格在这个平台叫什么(按会话种类)。缺的那档走通用称呼。 */
	addressNouns: Partial<Record<PushTargetScope, string>>;
	/** 主人在这个平台上回一句话,女仆**真的收得到**吗 —— 不是「协议上可行」。 */
	inbound: boolean;
	/** 能不能 @全体成员。 */
	atAll: boolean;
}

/**
 * 平台注册表。加一个平台从这里开始 —— 少一格是编译错,不是静默的默认值。
 *
 * `feishu` / `dingtalk` / `wecom` / `generic` 这一族原先是 webhook 连接 config 里的一个
 * `provider` 字段 —— 因为「webhook」被当成了平台,真平台只好降级成它的一个属性。可
 * webhook 从来不是平台,它是**怎么连**:飞书和钉钉是两个平台,只是恰好都用「往一个 URL
 * POST 一段 JSON」这种连法。所以 provider 升格成平台,webhook 挪进 {@link DIRECT_CONNECTORS}。
 * `generic` 是承认的疤:主人贴的 URL 可能是自建服务,那就没有平台可言 —— 面板上写
 * 「未指明的 HTTP 端点」,不假装它是个什么。
 */
export const PLATFORM_REGISTRY: Readonly<Record<ConnectionPlatform, PlatformDescriptor>> = {
	onebot: {
		label: "OneBot v11",
		shortLabel: "OneBot",
		tint: "#3b82f6",
		icon: "qq",
		connectors: ["http", "ws", "ws-reverse"],
		targetKind: "session",
		// OneBot 没有频道概念 —— 只给群与私聊两档。
		scopes: ["group", "private"],
		addressNouns: { group: "群", private: "用户" },
		inbound: true,
		atAll: true,
	},
	"qq-official": {
		label: "QQ 官方机器人",
		shortLabel: "QQ官方",
		tint: "#14b8a6",
		icon: "qq",
		// 官机只有 WS 网关一条路。
		connectors: ["ws"],
		targetKind: "session",
		scopes: ["group", "private", "channel"],
		addressNouns: { group: "群 openid", private: "C2C", channel: "子频道" },
		inbound: true,
		// 群里 @全体要特殊权限,适配器对 at-all 段一律丢弃。
		atAll: false,
	},
	feishu: {
		label: "飞书机器人",
		shortLabel: "飞书",
		tint: "#3370ff",
		icon: "feishu",
		connectors: ["webhook"],
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
		inbound: false,
		atAll: true,
	},
	dingtalk: {
		label: "钉钉机器人",
		shortLabel: "钉钉",
		tint: "#00c2ff",
		icon: "dingtalk",
		connectors: ["webhook"],
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
		inbound: false,
		atAll: true,
	},
	wecom: {
		label: "企业微信机器人",
		shortLabel: "企微",
		tint: "#07c160",
		icon: "wecom",
		connectors: ["webhook"],
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
		inbound: false,
		atAll: true,
	},
	generic: {
		label: "未指明的 HTTP 端点",
		shortLabel: "HTTP 端点",
		// 没有品牌可借,给一档中性的板岩灰。
		tint: "#94a3b8",
		connectors: ["webhook"],
		targetKind: "endpoint",
		scopes: ["channel"],
		addressNouns: {},
		inbound: false,
		atAll: true,
	},
};

/** 认不认识这个平台 —— 认识就把它的那一行交出来。目标侧的平台是开放词表,常常认不出。 */
export function platformDescriptor(platform: string): PlatformDescriptor | undefined {
	return (PLATFORM_REGISTRY as Record<string, PlatformDescriptor>)[platform];
}

/**
 * 出站 webhook 那一族平台。
 *
 * 它是注册表的一个**投影**,写成字面量只因为 `z.enum` 与类型都要求可枚举的元组 ——
 * 两边会不会漂由 `platform-registry.test.ts` 钉着。判据本身在注册表:走 webhook 连的
 * 就是这一族,别在各处手写四个平台名。
 */
export const WEBHOOK_PLATFORMS = ["feishu", "dingtalk", "wecom", "generic"] as const;
export type WebhookPlatform = (typeof WEBHOOK_PLATFORMS)[number];

/**
 * 分发键 —— 「该由哪套实现处理这条连接」。
 *
 * 直连就是它的平台(一条直连就是一个平台,那套协议是我们自己说的);拓展提供的连接
 * 用**拓展 id** —— 一个拓展一个推送源(ADR-0012 决策 28),后面挂着哪些平台是它运行时
 * 才知道的事,枚举不了。
 *
 * 它是**算出来的**,不落盘:落一格分发键就等于把「连到哪」与「谁来处理」又焊回一起,
 * 而那两件事正是这次重构拆开的。
 *
 * 入参按形状收(与 {@link isTargetPaused} 同一套安排),免得为了一个类型把 schema
 * 拖进这个零依赖模块 —— 前端要**运行时**用它。
 */
export function connectionDispatchKey(
	connection: { kind: "direct"; platform: string } | { kind: "extension"; extensionId: string },
): string {
	return connection.kind === "direct" ? connection.platform : connection.extensionId;
}

/** 这个平台是不是靠 webhook 连的。 */
export function isWebhookPlatform(platform: string): platform is WebhookPlatform {
	return platformDescriptor(platform)?.connectors[0] === "webhook";
}

/**
 * 一个平台默认走哪个连接器 —— 注册表里 `connectors` 的第一档。
 *
 * 两个用处共用这一份:迁移时老 OneBot 条目没有 `transport` 字段的回落(与 schema 的
 * `.default("http")` 同一个答案),以及前端新建连接时的初值。两处各写一份的话,
 * 「新建的连接」与「迁移过来的连接」会从不同的默认值出发,而且没人会发现。
 * 住零依赖的 constants 是因为前端要**运行时**用它 —— 从带 zod 的 schema 里导会把
 * zod 拖进 web 产物(见 apps/web/src/types/domain.ts 顶上那段)。
 */
export function defaultConnectorFor(platform: "onebot"): "http";
export function defaultConnectorFor(platform: "qq-official"): "ws";
export function defaultConnectorFor(platform: WebhookPlatform): "webhook";
export function defaultConnectorFor(platform: string): DirectConnector | undefined;
export function defaultConnectorFor(platform: string): DirectConnector | undefined {
	return platformDescriptor(platform)?.connectors[0];
}

/**
 * 这个平台的这种会话,地址那一格该叫什么。
 *
 * 认不出的平台(桥驮进来的)走通用称呼 —— 不认识不等于说不出话,「群 / 用户 / 子频道」
 * 对任何一个聊天平台都成立。
 */
export function addressNounFor(platform: string, scope: PushTargetScope): string {
	const named = platformDescriptor(platform)?.addressNouns[scope];
	if (named) return named;
	if (scope === "channel") return "子频道";
	return scope === "private" ? "用户" : "群";
}

// ---------------------------------------------------------------------------
// UP 主强调色
// ---------------------------------------------------------------------------
//
// dashboard 的卡片 / 头像 / 图表线 / Tab 圆点,以及**服务端渲染的周报图片**都取自
// 这里 —— 同一位 UP 在页面上和推到群里的图片上必须是同一个颜色,两边各存一份调色板
// 迟早会漂。
//
// 住在这个零依赖模块而不是 `util/` 里,理由与 BUILTIN_AI_PRESETS 一样:`util/` 只能
// 从根入口拿,而根入口带 zod —— 页面为了一个调色板把整个 zod 拖进 bundle。

/**
 * 曾经只有 8 色,其中 `#FF6699` 与 `#FB7299` 的 ΔE2000 只有 2.4(肉眼就是同一个粉),
 * 实际可辨的只有 7 种;而分配是 `hash(uid) % 8`,按生日悖论**订阅 4 位就有约 65%
 * 概率撞色**,订阅 10 位几乎必然重复。
 *
 * **试过纯按 uid 连续取色(LCh 空间取点、不设调色板),结论是更差,别再回去。**
 * 完全同色确实没了,但「有点像、分不清哪个是哪个」的比例反而从 4.0% 涨到 7.4% ——
 * 调色板是人为按 ΔE 摆开的,随机撒点做不到;而且逐色相取最大彩度会在黄绿区扫出
 * 一片芥末色、橄榄色,不好看。指标上「ΔE<6 完全难分」是降了,但人眼看的是前一档。
 *
 * 这 24 色是在 CIE Lab 里按「两两 ΔE2000 ≥ 11」贪心挑出来的,明度锁在 L\* 64–81,
 * 且**黄到黄绿那段(Lab 色相 55–125°)强制 L\* ≥ 78** —— 那一段明度一低就发闷成
 * 芥末 / 橄榄,是上一版最招人嫌的地方。品牌粉 / 蓝 / 紫三色原样占位,保住辨识度。
 *
 * **调这里时注意**:头像是白色粗体首字母直接压在这个颜色上(见 web 的 `atoms.tsx`
 * Avatar 与周报卡),所以别往更浅走 —— 这一族对白字的对比度只有 1.65–2.78,是这套
 * 设计有意选的浅调,再浅白字就糊了。测试只锁「两两分得开」,明度与调性靠这段说明。
 */
export const UP_COLORS = [
	"#fb7299",
	"#ff6b6d",
	"#ff9c89",
	"#ff6e42",
	"#ffaf7b",
	"#ffb22e",
	"#e0bf20",
	"#b3cd2f",
	"#67ad1b",
	"#6cd557",
	"#01b355",
	"#03d98e",
	"#02b088",
	"#05d6bd",
	"#03ada8",
	"#03dfe7",
	"#01b9d2",
	"#00aeec",
	"#489dff",
	"#a29bfe",
	"#d7a9ff",
	"#bf7cff",
	"#ee66db",
	"#ff93d1",
] as const;

/**
 * Stable per-UP color derived from uid; gives every UP a recognisable accent.
 *
 * 哈希用 FNV-1a 而不是原来的 `h * 31 + c`:B 站 uid 是纯数字,字符只在 '0'–'9' 这
 * 十个码位里取值,多项式哈希在 24 这种模数下散得不够开(实测 2 万个随机 uid,
 * χ² 41.4 vs FNV 的 19.5)—— 那样加再多颜色也只会集中用到其中几个。
 */
export function colorFromUid(uid: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < uid.length; i++) {
		h ^= uid.charCodeAt(i);
		// imul 才是 32 位整数乘法;直接 `*` 会溢出成浮点,低位精度丢光。
		h = Math.imul(h, 0x01000193);
	}
	return UP_COLORS[(h >>> 0) % UP_COLORS.length] as string;
}

// ---------------------------------------------------------------------------
// 自带字体的体积口径
// ---------------------------------------------------------------------------

/**
 * 单款字体的硬上限。完整中文字库的 ttf/otf 单字重就有 15-25MB,卡太死会把正常字体
 * 挡在门外,所以留到 20MB。
 *
 * 两端共享:服务端据它拒收(`apps/server/src/runtime/font-assets.ts`),前端据它写
 * 说明文案。
 */
export const MAX_FONT_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * 超过它就在上传后提醒换 woff2。
 *
 * 上限那个数是按「文件本身多大」定的,**没算出图时的开销**:字体会被 base64 内联进
 * 渲染 HTML(再涨三分之一),而 Docker 镜像里 V8 的 old-space 上限只有 512MB
 * (见 `apps/Dockerfile`)。传一款 20MB 的 ttf 完全合法,出图时却可能把服务撑爆。
 *
 * 做成**提醒而不是拒收**:降上限会把已经传上去的字体挡在门外,那是破坏性的;而同一套
 * 字转成 woff2 通常只占 ttf 的三分之一,说清楚就够主人自己决定了。
 */
export const FONT_ASSET_WARN_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// OneBot 慢动作的超时下限
// ---------------------------------------------------------------------------

/**
 * 带图普通消息(`send_group_msg` / `send_private_msg` 里含 image 段)的超时下限。
 *
 * 协议端收到带图消息后要先把图落盘、上传到 QQ 图床、拿回 fileid 才组消息回响应,
 * 这个往返与图多大关系不大(卡片图只有 0.1MB 量级),但稳定压在十几秒 —— 默认的
 * 15s 正好卡在临界点上,于是时好时坏。用户实测(LLOneBot):词云 / 动态卡反复标
 * 失败,服务端日志每一条都恰好停在 `响应超时 (15000ms)`,而同时段纯文字全部秒回。
 *
 * 只作**下限**(取 `max(配置值, 此值)`):主人把超时调得更大是有意为之,别被压低。
 * 纯文字不适用 —— 协议端真挂了的场景,每条文本都多等半分钟只会让失败来得更晚。
 *
 * 两端共享:服务端据它放宽超时(`apps/server/src/platforms/onebot.ts`),前端据它
 * 写超时那栏的说明文案,免得两边各写一个数、改了一处另一处照旧。
 */
export const ONEBOT_IMAGE_MIN_TIMEOUT_MS = 30_000;

/**
 * 合并转发(`send_*_forward_msg`)的超时下限。比单图那档长一倍:forward 要把每张图
 * 逐张下载再上传组装,9 图常要 20~60s。
 */
export const ONEBOT_FORWARD_MIN_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// AI 服务商注册表
// ---------------------------------------------------------------------------

/**
 * 已适配方言的服务商;`custom` 是兜底,不发任何方言参数,只认主人手写的额外参数。
 *
 * 这份注册表两端共享:服务端据它把「开思考」翻译成各家写法(见
 * `@bilibili-notify/ai#buildProviderParams`),前端据 `supportsThinking` 决定要不要
 * 显示思考开关。放在这里而不是 packages/ai,是因为 apps/web 只依赖 internal。
 */
export const AI_PROVIDER_IDS = [
	"openrouter",
	"volcengine",
	"siliconflow",
	"bailian",
	"deepseek",
	"custom",
] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

/** 配置面上统一的三档思考深度,各家在适配层各自映射。 */
export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 实例桶的「接口风味」—— 同一家服务商的两套 wire 协议。`chat` 在前作默认位:
 * 老配置零迁移,谁都不会被静默换协议。`responses` 是 OpenAI 2025 起的接任协议,
 * 思考在那边是一等公民(`reasoning.effort` 与三档天然对齐),不再走各家方言。
 */
export const API_FLAVOR_IDS = ["chat", "responses"] as const;
export type APIFlavorId = (typeof API_FLAVOR_IDS)[number];

/**
 * 联网搜索的后端。与 AI 服务商是**两个正交的选择**:搜索不走各家 LLM 的原生
 * 联网方言(分裂且 DeepSeek 官方压根没有),而是我们自己的 `web_search` 工具,
 * 由这里选定的后端真正执行 —— 所以任何支持 function calling 的服务商都能联网。
 */
export const WEB_SEARCH_BACKEND_IDS = ["bocha", "tavily"] as const;
export type WebSearchBackendId = (typeof WEB_SEARCH_BACKEND_IDS)[number];

export interface WebSearchBackendMeta {
	id: WebSearchBackendId;
	/** 配置面上的显示名。 */
	label: string;
	/** 申请 key 的入口,只作提示。 */
	keyUrl: string;
}

export const WEB_SEARCH_BACKENDS: readonly WebSearchBackendMeta[] = [
	// 博查在前:B 站语境下中文搜索质量是主场景。
	{ id: "bocha", label: "博查", keyUrl: "https://open.bochaai.com" },
	{ id: "tavily", label: "Tavily", keyUrl: "https://app.tavily.com" },
];

/** 按 id 取搜索后端元数据。id 只可能来自 zod 校验过的配置,不做兜底。 */
export function webSearchBackendMeta(id: WebSearchBackendId): WebSearchBackendMeta {
	// biome-ignore lint/style/noNonNullAssertion: 枚举封闭,zod 已挡住未知 id
	return WEB_SEARCH_BACKENDS.find((b) => b.id === id)!;
}

export interface AIProviderMeta {
	id: AIProviderId;
	/** 配置面上的显示名。 */
	label: string;
	/** 这家是否吃我们适配过的思考参数。custom 为 false —— 它只走额外参数。 */
	supportsThinking: boolean;
	/**
	 * 这家**默认就开着思考**吗。决定了开关的「关」位要不要显式发一条禁用 ——
	 * 默认关的家发了纯属多余风险,默认开的家不发则等于这个开关根本关不掉。
	 */
	thinkingDefaultsOn: boolean;
	/**
	 * 这家的接口里有没有**能看图的模型**。
	 *
	 * DeepSeek 官方 API 一个都没有 —— 那边「主模型支持看图」是个永远为否的问题,
	 * 不该摆出来让人勾。这不只是少显示一个开关:发图守卫也据此判断,否则勾着它
	 * 发图会一路走到模型那儿才被拒,白烧一次请求。
	 *
	 * 兜底档一律 `true`:能力未知时不替主人做减法。
	 */
	supportsVision: boolean;
	/**
	 * 开思考时这家会**静默忽略** temperature(以及 top_p / presence_penalty /
	 * frequency_penalty)。DeepSeek 官方文档明说不报错也不生效 —— 摆着让人调,
	 * 只会让主人以为设置没存上。
	 */
	temperatureIgnoredWhenThinking: boolean;
	/**
	 * 这家有没有 **Responses API**(`/responses`,OpenAI 2025 起的接任协议)。
	 * 决定设置页「接口风味」选项露不露 —— 未确认支持的家不开放,免得选出
	 * 必然 404 的组合;日后他们支持了,这里改一行即可。2026-08 核实:
	 * DeepSeek 生产级、百炼 qwen3-max 系、OpenRouter beta;硅基/火山未见。
	 * custom 恒 true:能力未知时不替主人做减法(OpenAI 官方正是经此接入)。
	 */
	supportsResponses: boolean;
	/** 配置面上的参考地址,只作提示,不自动填。 */
	baseUrlHint: string;
}

export const AI_PROVIDERS: readonly AIProviderMeta[] = [
	{
		id: "openrouter",
		label: "OpenRouter",
		supportsThinking: true,
		thinkingDefaultsOn: false,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		supportsResponses: true,
		baseUrlHint: "https://openrouter.ai/api/v1",
	},
	{
		id: "volcengine",
		label: "火山方舟",
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		supportsResponses: false,
		baseUrlHint: "https://ark.cn-beijing.volces.com/api/v3",
	},
	{
		id: "siliconflow",
		label: "硅基流动",
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		supportsResponses: false,
		baseUrlHint: "https://api.siliconflow.cn/v1",
	},
	{
		id: "bailian",
		label: "阿里云百炼",
		supportsThinking: true,
		// 百炼的默认按**模型**分:qwen-plus / qwen-flash / qwen3-max 默认关,
		// qwen3.7+ 商业版与开源版默认开。填 true 让「关」位显式发 enable_thinking:false
		// —— 对默认开的模型这是唯一能关掉的路,对默认关的模型这个字段也合法无害。
		thinkingDefaultsOn: true,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		supportsResponses: true,
		baseUrlHint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		supportsThinking: true,
		thinkingDefaultsOn: true,
		supportsVision: false,
		temperatureIgnoredWhenThinking: true,
		supportsResponses: true,
		baseUrlHint: "https://api.deepseek.com",
	},
	{
		id: "custom",
		label: "自定义",
		supportsThinking: false,
		thinkingDefaultsOn: false,
		supportsVision: true,
		temperatureIgnoredWhenThinking: false,
		supportsResponses: true,
		baseUrlHint: "任何 OpenAI 兼容地址",
	},
];

/** 查不到就落到兜底档,永远返回一个可用的 meta。 */
export function providerMeta(id: AIProviderId): AIProviderMeta {
	return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[AI_PROVIDERS.length - 1];
}

/**
 * 这份实例能不能开「深度思考」—— chat 风味看这家有没有适配过的方言
 * (`supportsThinking`),responses 风味一律解禁:那套协议里思考是标准字段
 * (`reasoning.effort`),不再是「方言未知不敢发」。
 *
 * **谓词只能有这一份。**它曾在三处各手抄一遍(聊天胶囊 / 实例编辑器 /
 * 「AI 聊天」设置块),第三处漏掉 responses 解锁 —— 胶囊点得亮、服务端真在
 * 发思考参数,设置页却藏起档位还宣称「不会发」。
 */
export function canProfileThink(p: { provider: AIProviderId; apiFlavor?: APIFlavorId }): boolean {
	return providerMeta(p.provider).supportsThinking || (p.apiFlavor ?? "chat") === "responses";
}

/**
 * 一家服务商的整套配置(与 `schema/common.ts#AIProviderProfileSchema` 同形)。
 * 类型声明在这里而不是 schema 里,是为了让**零依赖**的 {@link resolveAIProfile}
 * 也能用上 —— 设置页经 `/constants` 子路径运行时消费它,不能把 zod 拖进前端 bundle。
 */
export interface AIProviderProfileShape {
	/**
	 * 这桶配置属于哪家服务商 —— 决定「开思考」翻译成哪家方言。桶键只是**实例 id**
	 * (同一家可以有多份实例),方言归属必须写在桶里,不能再从键名推。
	 */
	provider: AIProviderId;
	/** 实例的显示名。空串 = 用注册表里那家的名字(避免把家名抄进配置,改名会过期)。 */
	label: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	/** 这桶走哪套 wire 协议。默认 `chat`;能否选 `responses` 见 {@link AIProviderMeta.supportsResponses}。 */
	apiFlavor: APIFlavorId;
	temperature: number;
	enableThinking: boolean;
	thinkingLevel: ThinkingLevel;
	extraParams: string;
	enableVision: boolean;
	vision: { baseUrl: string; apiKey: string; model: string };
}

/**
 * 一套「什么都没配」的档案。**必须与 `AIProviderProfileSchema` 的各字段默认值逐一
 * 一致** —— 那边有一条测试拿 `parse({})` 与这里比深等,写歪了会当场红。
 */
export const EMPTY_AI_PROVIDER_PROFILE: AIProviderProfileShape = {
	provider: "custom",
	label: "",
	apiKey: "",
	baseUrl: "",
	model: "",
	apiFlavor: "chat",
	temperature: 0.7,
	enableThinking: false,
	thinkingLevel: "medium",
	extraParams: "",
	enableVision: false,
	vision: { baseUrl: "", apiKey: "", model: "" },
};

/**
 * 取当前生效的那一套配置。
 *
 * `activeProfile` 指向的实例可能不存在(主人刚把它删掉、配置是手改的、或者这就是
 * 一份全新配置),这时返回一套**空默认值**而不是 undefined:调用方拿到空 `model` 会按
 * 既有规矩判定「还没配齐」并停用 AI —— 那是它们本来就处理得了的情形;返回
 * undefined 则会在各处炸出读属性的 TypeError。
 *
 * 对残缺入参也不炸(`providers` 整个缺席时同样兜空档案) —— 它同时服务于前端的
 * 局部状态与后端的完整配置,前者在数据还没到齐时就会渲染。
 */
export function resolveAIProfile(ai: {
	activeProfile?: string;
	providers?: Record<string, AIProviderProfileShape | undefined>;
}): AIProviderProfileShape {
	return ai.providers?.[ai.activeProfile ?? ""] ?? EMPTY_AI_PROVIDER_PROFILE;
}

/**
 * AI 聊天此刻用的思考**等级**。
 *
 * `ai.chat` 与实例桶里的那两格是**分了家的**:桶里的管引擎(点评 / 总结 / 锐评),
 * `ai.chat` 管聊天页。chat 里没写等级就跟随当前实例(「初始默认值从女仆读取」),
 * 写过就压过实例、从此互不牵动。方言翻译仍按当前实例的 `provider` 走。
 *
 * 只剩**等级**没有开关:聊天的思考开关是**会话级**的(输入框旁那颗胶囊,默认关、
 * 手动开、不落盘),按消息走请求体 —— 配置里没有它的位置。
 */
export function resolveChatThinkingLevel(ai: {
	activeProfile?: string;
	providers?: Record<string, AIProviderProfileShape | undefined>;
	chat?: { thinkingLevel?: ThinkingLevel };
}): ThinkingLevel {
	return ai.chat?.thinkingLevel ?? resolveAIProfile(ai).thinkingLevel;
}

/**
 * 一份人格(与 `schema/common.ts#AIPersonaSchema` 同形)。类型声明在这里的理由与
 * {@link AIProviderProfileShape} 一样:让下面那个**零依赖**的解析函数能直供浏览器端。
 */
export interface AIPersonaShape {
	name: string;
	addressUser: string;
	addressSelf: string;
	traits: string;
	catchphrase: string;
	baseRole: string;
	extraSystemPrompt: string;
}

/** 人格库里的一份 —— 两段 prompt 缺席 = 「用全局那份」。 */
export interface AIPresetShape {
	id: string;
	persona: AIPersonaShape;
	dynamicPrompt?: string;
	liveSummaryPrompt?: string;
}

/** 当前生效的那份人格与它的两段 prompt。 */
export interface ActivePersonaShape {
	persona: AIPersonaShape;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
}

/**
 * 全局此刻用的是哪份人格 —— **「当前用哪份」只能有这一个读法**。
 *
 * 人格住在 `presets[]` 里,`activePreset` 是指着其中一份的指针,且**不改写**
 * `ai.persona`(切回原来那份时主人手写的内容原封不动地回来)。代价是 `ai.persona`
 * 自指针上线就再没有界面入口 —— 它只剩两个身份:老配置的原值、以及指针落空时的
 * 安全网。**谁直读它,谁那条路上的人格就永远停在老值上**:主人在设置页换来换去,
 * 那一侧的女仆还是原来那位,而界面上高亮、指示器全都指着新那份,看不出哪儿不对。
 * (「换了人格没反应」就是这么来的,一次同时坑了常驻 generator、试一句、锐评与
 * 聊天窗抬头四处。)
 *
 * 指针落空 —— 没填、或指着一份刚被删掉 / 备份换掉的预设 —— 静静回落 `ai.persona`。
 * 两段 prompt 逐段回落:预设里缺席 = 「用全局那段」,不是「发一段空的」。
 */
export function resolveActivePersona(ai: {
	persona: AIPersonaShape;
	dynamicPrompt: string;
	liveSummaryPrompt: string;
	activePreset?: string;
	presets?: readonly AIPresetShape[];
}): ActivePersonaShape {
	const active = ai.activePreset ? ai.presets?.find((p) => p.id === ai.activePreset) : undefined;
	return {
		persona: active?.persona ?? ai.persona,
		dynamicPrompt: active?.dynamicPrompt ?? ai.dynamicPrompt,
		liveSummaryPrompt: active?.liveSummaryPrompt ?? ai.liveSummaryPrompt,
	};
}

// 第一个 AI 人格预设「温柔女仆」。同时作为 DEFAULT_AI 的默认 persona / prompt 来源,
// 保证「默认配置 = 首个预设」单一真相,不靠手抄两份。
const PRESET_GENTLE_MAID = {
	id: "gentle-maid",
	label: "温柔女仆",
	persona: {
		name: "小绫",
		addressUser: "主人",
		addressSelf: "小绫",
		traits: "温柔、体贴、说话轻声细语",
		catchphrase: "请主人慢用~",
		baseRole: "你是主人贴身的小女仆,语气温柔、耐心、关心主人,把每一次汇报都当成对主人的服务。",
		extraSystemPrompt: "回复保持礼貌,可以用 (*´ω`*) 之类的颜文字点缀,不要过分卖萌。",
	},
	dynamicPrompt:
		"主人订阅的 UP 主刚刚更新了动态,请用温柔的语气向主人转述核心内容,并补一两句你的看法。",
	liveSummaryPrompt:
		"用温柔的语气向主人讲讲直播主要发生了什么(150-200 字),从弹幕和氛围中提炼亮点。",
} as const;

/**
 * 内置人格清单 —— **纯数据,住在零依赖的 constants 里**,三方都要用它:
 *
 * - `schema/globals.ts` 的 `DEFAULT_AI`(默认配置 = 首份)
 * - `schema/common.ts` 的迁移(老配置 `presets: []` 时补齐这四份)
 * - `apps/web` 的设置页(「从内置恢复」列出缺的那几份、判断哪些是锁死的)
 *
 * 前端那条路是把它放这儿的硬理由:从根入口拿会把 zod 拽进浏览器 bundle。
 *
 * 这四份在界面上**只读**:可以删、可以「从内置修改」另存一份可改的副本,但不能就地
 * 改 —— 它们是一份稳定的参照库,改花了就没法「恢复内置」了。
 */
export const BUILTIN_AI_PRESETS = [
	PRESET_GENTLE_MAID,
	{
		id: "tsundere",
		label: "傲娇毒舌",
		persona: {
			name: "凛子",
			addressUser: "笨蛋",
			addressSelf: "本小姐",
			traits: "嘴硬心软、毒舌、爱用反问",
			catchphrase: "哼,才不是为了你才看的呢!",
			baseRole: "你是一个嘴硬心软的傲娇 AI,虽然嘴上不饶人,但实际上还是认真在帮主人盯 UP 主动态。",
			extraSystemPrompt: "可以毒舌但避免人身攻击,关键信息一定要说清楚。不要把每句话都加'哼'。",
		},
		dynamicPrompt:
			"主人让你看的 UP 主又更新动态了,用傲娇的语气吐槽一下,但内容核心要讲清楚,不要光吐槽不汇报。",
		liveSummaryPrompt:
			"主人非要让你帮他看一整场直播,用傲娇的语气把这场直播总结一下,允许适当吐槽,但关键点要交代到。",
	},
	// 这一份此前写成了一个中立的「内容分析师」—— 称呼用户、自称「我」,跟另外三份
	// 不是一路人。它同样是女仆,只是**冷静干练**的那一种:该有的称呼与身份都在,
	// 只是不寒暄、不堆颜文字,把话说清楚就收。
	{
		id: "analyst",
		label: "理性女仆",
		persona: {
			name: "理子",
			addressUser: "主人",
			addressSelf: "理子",
			traits: "冷静、条理清晰、言简意赅",
			catchphrase: "以上,请主人过目。",
			baseRole:
				"你是主人身边最干练的那位女仆,负责把 UP 主的动态与直播整理成一份清楚的简报。你依然恭敬有礼,但不寒暄、不铺垫,信息优先。",
			extraSystemPrompt:
				"保持敬语,但不用颜文字、不堆感叹号、不做情绪渲染。结构化输出:亮点 / 关键信息 / 简评 三段式,简评不超过两句。事实与你的判断要分得开。",
		},
		dynamicPrompt:
			"主人订阅的 UP 主更新了动态。按「亮点 / 关键信息 / 简评」三段式向主人汇报,语言简洁克制,简评不超过两句,不做情绪渲染。",
		liveSummaryPrompt:
			"向主人汇报这场直播:涉及话题、互动热点、整体氛围。控制在 200 字内,保持敬语但不用颜文字与感叹号。",
	},
	{
		id: "genki",
		label: "元气少女",
		persona: {
			name: "小阳",
			addressUser: "你",
			addressSelf: "我",
			traits: "活泼、热情、爱用感叹号",
			catchphrase: "诶嘿~",
			baseRole: "你是一个超级元气的助手,充满活力、热情地分享 UP 主的最新动态和直播!",
			extraSystemPrompt:
				"语气活泼但不要刷感叹号刷到刺眼,一两个就够。可以用「!!」、「~」、「诶嘿」之类。",
		},
		dynamicPrompt: "用元气满满的语气把 UP 主新动态讲给用户听,内容核心要说出来,语气活泼但别过头。",
		liveSummaryPrompt: "用元气满满的语气帮用户回顾这场直播的重点(200 字内),保持热情但抓住关键点。",
	},
] as const;

/**
 * 模板默认值（占位，可由 UI 编辑）。
 *
 * 占位符统一 `{key}` 语法,由 `LiveTemplateRenderer.applyTemplate` / `interpolate`
 * 替换(`applyTemplate` 同时兼容旧存档的 legacy `-key`)。变量集严格对齐
 * 渲染器实际提供的字段:
 * - 直播:`{name}` `{time}` `{follower}` `{follower_change}` `{watched}`
 * - 上舰:`{uname}` `{mname}` `{guard}`
 * - 特别关注:`{mastername}` `{uname}` `{msg}`
 * - 弹幕总结:`{dmc}` `{mdn}` `{dca}` `{un1..5}` `{dc1..5}`
 * - 动态:`{name}`
 *
 * 链接不再是模板变量:动态 / 视频 / 开播的链接是消息版式的独立「链接」部件
 * (显隐 / 位置由版式决定),模板里没有链接变量。
 *
 * liveStart/liveOngoing/liveEnd 与 packages/live 的 `DEFAULT_LIVE_TEMPLATES`
 * 保持字面量一致 —— 这样「自定义关闭时实际推送的内建默认」== 「自定义打开时
 * UI 载入的默认文本」,不再出现 `{name}` 原样吐出的错配。
 */
export const DEFAULT_TEMPLATES = {
	liveStart: "{name} 开播啦，当前粉丝数：{follower}",
	liveOngoing: "{name} 正在直播，已播 {time}，累计观看：{watched}",
	liveEnd: "{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
	liveSummary: `🔍【弹幕情报站】本场直播数据如下：
🧍‍♂️ 总共 {dmc} 位{mdn}上线
💬 共计 {dca} 条弹幕飞驰而过
📊 热词云图已生成，快来看看你有没有上榜！
👑 本场顶级输出选手：
🥇 {un1} - 弹幕输出 {dc1} 条
🥈 {un2} - 弹幕 {dc2} 条，萌力惊人
🥉 {un3} - {dc3} 条精准狙击
🎖️ 特别嘉奖：{un4} & {un5}
你们的弹幕，我们都记录在案！🕵️‍♀️`,
	dynamic: "{name}发布了一条动态",
	dynamicVideo: "{name}发布了新视频",
	wordcloudStopWords: "",
	specialDanmaku: "{mastername} 的关注用户 {uname} 发送弹幕：{msg}",
	specialUserEnter: "{uname} 进入了 {mastername} 的直播间",
	guardBuy: {
		// false = 默认上舰图 + 内置文案；true = 启用三档自定义文案/图片
		enable: false,
		captain: { imageUrl: "", template: "{uname} 成为了 {mname} 的舰长！" },
		commander: {
			imageUrl: "",
			template: "{uname} 成为了 {mname} 的提督！",
		},
		governor: {
			imageUrl: "",
			template: "{uname} 成为了 {mname} 的总督！",
		},
	},
} as const;

// ── 锐评定时推送 ──────────────────────────────────────────────────────────────
// 住在这里而不是 `schema/roast-schedule.ts`:配置页要拿它们做输入提示,而
// `apps/web` 不能把 zod 拉进浏览器 bundle —— 从那个文件 import 就会。

/** 锐评统计窗口下界。schema 校验与 `apps/server` 的取数共用,别在两处各定一份。 */
export const ROAST_MIN_DAYS = 1;
/** 锐评统计窗口上界。取数与 AI prompt 都按这个上界设计。 */
export const ROAST_MAX_DAYS = 90;
/** 定时锐评的默认 cron —— 每周一早九点,「周报」最符合直觉的那档,用户可改。 */
export const DEFAULT_ROAST_CRON = "0 9 * * 1";
/** 默认统计窗口,与默认 cron 的一周间隔对齐。周期与窗口本身是解耦的两个字段。 */
export const DEFAULT_ROAST_DAYS = 7;

/**
 * 一条**关着**的定时锐评配置。
 *
 * 住在这里而不是 schema 文件:`apps/web` 造空订阅时要用它,而那个文件 import 了
 * zod —— 从那儿取一份默认值就把 zod 拉进浏览器 bundle 了。schema 侧拿它当
 * `.default()`,两边同一份。
 *
 * `enabled: false` 是硬要求:存量用户升级上来,不该有任何东西开始自己往群里发帖。
 */
export const DEFAULT_ROAST_SCHEDULE = {
	enabled: false,
	cron: DEFAULT_ROAST_CRON,
	days: DEFAULT_ROAST_DAYS,
	targets: [] as string[],
	approval: false,
	notifyOnError: true,
} as const;

/**
 * 已经**实现了入站消息解析**的推送平台。
 *
 * 列的是「主人在这里回一句话，我们真的收得到」，不是「协议上理论可行」。审批要靠
 * 它把 y/n 收回来 —— 一个平台如果只是协议上支持而我们没解析，配置页放行就等于让
 * 主人开了一个永远等不到回复的开关，草稿全部超时作废。宁可少列。
 *
 * webhook 天生不可能:它就是个出站 HTTP POST,没有回程。将来薄插件桥接进来的平台
 * 协议上收得到、只是还没接时 —— 说法见 {@link inboundGapReason},别写成平台的毛病。
 *
 * 与 {@link WEBHOOK_PLATFORMS} 一样是 {@link PLATFORM_REGISTRY} 的**投影**,写成字面量
 * 只因为 `LinkSourcePlatform` 要从它取联合类型;两边漂了由注册表的守卫测试报红。
 */
export const INBOUND_CAPABLE_PLATFORMS = ["onebot", "qq-official"] as const;

/** 这个平台收不收得到主人的回复。审批开关能不能用就看它。 */
export function platformCanReceiveReply(platform: string): boolean {
	return platformDescriptor(platform)?.inbound === true;
}

/**
 * 为什么这个平台上收不到主人的回复 —— 一句给人看的话。
 *
 * **不能一律说成「这个通道只能发不能收」**:除了 webhook,别的平台协议上都收得到,
 * 只是我们还没解析(qq-official 甚至连 WS 网关和 USER_MESSAGE intent 都已经在跑了,
 * 只差把正文接出来)。把实现缺口说成平台的毛病,主人会对着一个「明明能收」的通道
 * 反复怀疑自己配错了。
 */
export function inboundGapReason(platform: string): string {
	return isWebhookPlatform(platform)
		? "webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话"
		: `女仆还没在 ${platform} 上接入站消息，主人回的 y 送不到女仆手里`;
}

/**
 * 该平台能不能 @全体成员。QQ 官方机器人在群里 @全体要特殊权限,适配器对 at-all 段一律
 * 丢弃 —— 推送层据此不给这种目标单发 @全体(否则那条到适配器就成了空消息,每次都记一条
 * 失败),UP 抽屉里这种目标的 @全体开关也据此禁用并写着「发送时会自动跳过」。两边必须是
 * 同一份判断,界面上说跳过就得真的跳过。
 */
export function platformSupportsAtAll(platform: string): boolean {
	// 入参收 string 而不是闭集:它吃的是**目标**的平台,而那是开放词表。桥驮进来的平台
	// 默认按「能 @全体」算 —— 真不能的话,能力位会在桥探测时说,推送层据能力位跳过。
	return platformDescriptor(platform)?.atAll ?? true;
}

/**
 * 「这个推送目标现在算不算暂停」。目标自己的开关关了,或它挂在一条已停用的连接下面
 * (投递层对这两种情况一律回不可达),都算。
 *
 * 住在这里而不是服务端:面板上的「已停用」标记与运行时的「跳过」必须是同一句话 ——
 * 前端只看 `target.enabled` 的话,连接停用的目标在选择器里显示为启用,发的时候却被
 * 跳过。入参按形状收,免得为了两个类型把 schema 拖进这个零依赖模块。
 */
export function isTargetPaused(
	target: { enabled: boolean; connectionId: string },
	connections: readonly { id: string; enabled: boolean }[],
): boolean {
	if (!target.enabled) return true;
	return !connections.find((a) => a.id === target.connectionId)?.enabled;
}

/**
 * 一行历史的四态。词表在这儿(schema 用它 enum),两个谓词也在这儿 —— 服务端的按日
 * 聚合与面板上的乐观补丁吃的是同一份口径,各写一遍的话,加第五态时只会改一边:KPI
 * 两头对不上,而门禁一点都不红。
 */
export const PUSH_STATUSES = ["delivered", "partial", "failed", "no-targets"] as const;

/** 算不算「推到了某个地方」—— 进不进「今日推送」与趋势图。无目标行没推到任何地方。 */
export function countsAsDelivery(status: (typeof PUSH_STATUSES)[number]): boolean {
	return status !== "no-targets";
}

/** 算不算「今日失败」。部分失败(本体到了、附加没到)也算 —— 有件事该看一眼。 */
export function countsAsFailure(status: (typeof PUSH_STATUSES)[number]): boolean {
	return status === "failed" || status === "partial";
}

/**
 * 链接解析回什么:图片卡,或 QQ 小程序卡(B 站 App「分享到 QQ」那种,点开进小程序播放)。
 * 小程序卡要目标所在的 OneBot 实现能向腾讯签 ark(`get_mini_app_ark`,今天已知只有 NapCat),
 * 签不了的一律回落图片卡。只有这两档,没有「两个都发」。
 */
export const LINK_REPLY_FORMS = ["image", "miniapp"] as const;

export type LinkReplyForm = (typeof LINK_REPLY_FORMS)[number];

/**
 * 链接解析的硬上限。**不进面板**:面板上那条冷却只防「同一个视频反复贴」,这几条防的是
 * 换着视频刷 —— 谁都能触发的功能,资源面得有个不靠主人调的底。
 *
 * 放在这里而不是服务端里:面板的说明文字要把这两个数字念给主人听(web 只能从这个零依赖
 * 子入口拿运行时值),各写一份的话调了上限、说明还在念旧数字,而且什么都不会红。
 */
export interface LinkLimits {
	/** 单个群每分钟最多出几张链接卡。 */
	groupPerMinute: number;
	/**
	 * 全局同时在处理(取信息 / 渲染 / 发送)的链接卡上限;超了直接放弃,不排队。
	 *
	 * 它管的是**积压量**,不是给推送卡让路 —— 让路由渲染队列的低优先级车道做(链接卡在
	 * 正常车道排空之前不渲染)。这个数只是别让一群人刷链接时攒下几十个悬着的请求。
	 */
	maxInflight: number;
	/** 冷却表 / 群额度表各自的容量,满了丢最久没碰的 —— 忘一条顶多多出一张卡,表不会越涨越慢。 */
	tableCap: number;
}

export const LINK_LIMITS: LinkLimits = { groupPerMinute: 6, maxInflight: 3, tableCap: 2000 };

/**
 * 一条加速前缀长得合不合法:`https://` 开头、后面真有个主机名。空串(直连)不走这里,
 * 由调用方各自判。
 *
 * 三处要判得一模一样:落盘的 schema(`UpdateSettingsSchema.mirrors`,最终说了算的那道
 * 门)、服务端守 `POST /api/update/mirrors/probe` 的那道(这是一个让服务端去连任意主机
 * 的入口)、面板决定自定义那一格能不能选的那道。各写一份正则的话,用户会遇到「测得通、
 * 存不进去」—— 所以正则只有这一条,契约包从这里转出去给面板与路由。
 */
export const MIRROR_PREFIX_RE = /^https:\/\/[^\s/]+/;

export function isMirrorPrefix(value: string): boolean {
	return MIRROR_PREFIX_RE.test(value);
}

/* -------------------------------------------------------------------------- */
/* 连接的形状判断 —— 只看 `kind` / `connector` 两个字段,一点 zod 都用不上          */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ 这几个谓词**刻意住在这里而不是 `schema/targets.ts`**:面板(apps/web)也要问同样的
 * 问题,而它只能 `import type` 域模型 —— 谓词留在带 zod 的那一侧,web 就只能自己再抄一份,
 * 于是同一句话有两份实现、改判据要记得改两处。搬到这个零依赖模块之后只剩一份。
 *
 * (`isConnectionOn` 留在 schema 那边:它 narrow 到某个平台的 **config 形状**,那是 schema
 * 自己的事。)
 */

/**
 * 这条连接自己就是一个平台吗 —— 是的话把平台名交出来。
 *
 * 读点写 `connection.platform` 的地方**大多真正想问的是这个**:桥接入没有单一平台,
 * 该走的是「问桥报了哪些」那条路。留这个谓词是为了让那些地方显式说出「认不出就没有」,
 * 而不是靠一个可选字段悄悄变 `undefined`。
 */
export function isDirectConnection(connection: Connection): connection is DirectConnection {
	return connection.kind === "direct";
}

/**
 * 这条连接是不是 webhook 那种**单向投递**。
 *
 * 从前全仓 20 处写的是 `connection.connector === "webhook"` —— 那是把一个字段当接口用:
 * 拓展那一支没有 `connector`,于是每一处都要先想一遍「它有没有这一格」。问题本来就只有
 * 一个,答案也只有一份,所以收成这一句。
 */
export function isWebhookConnection(connection: Connection): connection is WebhookConnection {
	return connection.kind === "direct" && connection.connector === "webhook";
}

/**
 * 这条连接归不归某个拓展 —— 不给 id 就是问「是不是拓展提供的」。
 *
 * ctx 交给拓展的那份快照就是拿它筛的(决策 30):**归属是宿主的判断**,所以筛这一步
 * 只有一份实现。
 */
export function isExtensionConnection(
	connection: Connection,
	extensionId?: string,
): connection is ExtensionConnection {
	if (connection.kind !== "extension") return false;
	return extensionId === undefined || connection.extensionId === extensionId;
}

// ---- 卡片皮肤(ADR-0014)的零依赖词表 ----------------------------------------

/**
 * 七种卡。前四种有块可排;后三种(AI 周报榜单 / 单人锐评 / 弹幕词云)各自整张是**一个固定
 * 内置块**,皮肤只管外框(ADR-0014 决策 3)。
 */
export const CARD_SKIN_KINDS = [
	"live",
	"dynamic",
	"sc",
	"guard",
	"roastBoard",
	"roastSolo",
	"wordcloud",
] as const;
export type CardSkinKind = (typeof CARD_SKIN_KINDS)[number];

/**
 * 七种卡的中文名。卡片工坊的提示词与聊天里的工具小条共用这一份 —— 各写一份的话,
 * 加第八种卡时总有一边漏掉,而漏掉的那边是静默的。
 */
export const CARD_SKIN_KIND_NAMES: Readonly<Record<CardSkinKind, string>> = {
	live: "直播卡",
	dynamic: "动态卡",
	sc: "醒目留言卡",
	guard: "上舰卡",
	roastBoard: "锐评榜单卡",
	roastSolo: "单人锐评卡",
	wordcloud: "弹幕词云卡",
};

// ---- 预览场景 ---------------------------------------------------------------

/**
 * 编辑器实时预览里,一种卡可选的「场景」—— 同一张卡在不同状态下长得不一样(直播卡的
 * 直播中 / 下播、动态卡的纯文字 / 视频投稿 / 图文 / 转发),皮肤得挨个看过才知道有没有
 * 写塌。
 */
export interface PreviewScene {
	/** 稳定的机器名,进 URL / 请求体。小写 kebab。 */
	id: string;
	/** 面板上显示的中文短名,如「直播中」。 */
	label: string;
}

/**
 * 每种卡可选的场景,**第一项是默认**(没带 scene、或带了不认识的名字都落回它);面板照
 * 数组顺序显示。
 *
 * 住在 internal 而不是 `packages/image`,是依赖方向定的:面板(`apps/web`)要拿这张表画
 * 那排场景按钮,它经 `apps/contract` 借类型,而 contract 只准从 internal 借、`packages/*`
 * 又不许反向依赖 contract —— 只有 internal 这一份是出图端与面板都够得着的。所以它和
 * `CARD_SKIN_FIELDS` 是同一类东西:**契约常量**。场景对应的示例 props 是另一回事,那是
 * 出图端的活,住在 `packages/image` 的 `preview/sample-cards.ts`,面板一个字都不碰。
 */
export const CARD_PREVIEW_SCENES: Readonly<Record<CardSkinKind, readonly PreviewScene[]>> = {
	// 直播卡两态各画各的(角标、时间行、粉丝行都不同);默认落在「直播中」—— 那是最常被
	// 看到的一张。「开播」不单列:它与直播中 `liveStatus` 都是 1,只差一句文案,出图端分不开,
	// 留着就只能是别名(ADR-0014 决策 10 的 2026-09-19 🔗)。
	live: [
		{ id: "streaming", label: "直播中" },
		{ id: "ended", label: "下播" },
	],
	// 四场按主媒体分,每一场就是出图端分得出来的一种卡:纯文字是底档(正文 + 话题 + 附加
	// 内容都在这儿看);「视频投稿」是真机上 UP 发视频推过来的那张 —— 只有头部、视频五块和
	// 互动数,没有正文、话题、附加内容(群里贴视频链接出的卡也是这个形状);「图文」是带图的
	// 那一种,图廊只有它看得到;转发单给一场:它里头是**另一整张卡**(转发框 + 跟着同一份
	// 皮肤摆的块),不单列的话皮肤作者在面板上一眼都看不到这一层。
	// 从前的「全字段」(视频 + 正文 + 话题)砍了 —— 它在出图端与「视频投稿」是同一种卡。
	dynamic: [
		{ id: "text", label: "纯文字" },
		{ id: "video", label: "视频投稿" },
		{ id: "pics", label: "图文" },
		{ id: "forward", label: "转发" },
	],
	sc: [{ id: "default", label: "醒目留言" }],
	guard: [{ id: "default", label: "上舰" }],
	roastBoard: [{ id: "default", label: "锐评榜单" }],
	roastSolo: [{ id: "default", label: "单人锐评" }],
	wordcloud: [{ id: "default", label: "词云" }],
};

/**
 * 请求里那个场景名 → 真正要用的场景。**认不出就回落到第一个**,不报错:场景名从 URL /
 * 请求体来,面板换过一版、链接被人存过书签都会送来旧名字,为这个给张错误页不值。
 *
 * 收成一处是因为有**两个**调用方(出图端挑示例数据、预览路由回报「实际用了哪个」),
 * 各写一遍 `find ?? 第一个` 的话,哪天回落规则改了就只改得动其中一边。
 */
export function resolvePreviewScene(kind: CardSkinKind, scene?: string): PreviewScene {
	const scenes = CARD_PREVIEW_SCENES[kind];
	// biome-ignore lint/style/noNonNullAssertion: 表里每种卡都至少一个场景,有测试钉着
	return scenes.find((s) => s.id === scene) ?? scenes[0]!;
}

/**
 * 块在网格里的位置(与 `CardSkinBlockSchema` 的 `grid` 同形)。声明在这里而不是 schema 里,
 * 是为了让**零依赖**的 {@link rowMapOf} 也能用上 —— 画布经 `/constants` 子路径运行时
 * 消费它,不能把 zod 拖进前端 bundle(与 {@link AIProviderProfileShape} 同一条理由)。
 */
export interface CardSkinGrid {
	row: number;
	column: number;
	span: number;
	rowSpan?: number;
	z?: number;
}

/**
 * **压行**:把一组块**占到**的行按从小到大重编成 1..n,回一张「真行号 → 压后行号」的表。
 * 占到 ≠ 起在:跨行的块把中间那几行也占着,漏掉它们就会把下一块压进它身上;一个块占的
 * 行因此恒是连着的一段,`rowSpan` 不用跟着改。整行没块的行不在表里 —— 那就是被压掉的行。
 *
 * 出图端与画布**共用这一处**(ADR-0014 决策 10 的 2026-09-19 🔗「画布与出图一样紧」):
 * 各写一遍的话,编辑器里看着紧贴的两块,真画出来中间多一条缝,或者反过来。
 */
export function rowMapOf(
	grids: Iterable<Pick<CardSkinGrid, "row" | "rowSpan">>,
): Map<number, number> {
	const occupied = new Set<number>();
	for (const { row, rowSpan } of grids) {
		for (let r = row; r < row + (rowSpan ?? 1); r++) occupied.add(r);
	}
	const map = new Map<number, number>();
	for (const r of [...occupied].sort((a, b) => a - b)) map.set(r, map.size + 1);
	return map;
}

/**
 * **皮肤自定义旋钮**(ADR-0014 决策 16 的 🔗,2026-09-14:主人推翻自己「被否:皮肤自定义
 * 旋钮」那一条)。皮肤声明几枚旋钮,面板照声明生成控件,用户拧出来的值注成
 * `--bn-knob-<key>`,皮肤 CSS 里 `var(--bn-knob-<key>, <自己的默认>)` 引用。
 *
 * 固定变量表({@link CARD_SKIN_VARIABLES})管的是**用户的资产**(背景图)与**数据**
 * (档位色):皮肤换了它们还在。旋钮管的是**这套皮肤自己的调色板**:皮肤换了就换一套。
 *
 * 🔴 **`default` 不注入**。它只是面板控件的起始位置;用户没动过就什么都不注,皮肤 CSS 里
 * 那个 `var(…, 兜底)` 的兜底生效(「存覆盖不存值」,决策 16 的第二个 🔗)。这条不是省事:
 * 默认皮肤的玻璃白纱各卡基线不同(直播 .82 / SC .75 / 锐评 .86),注了就只能注一个数、
 * 三档立刻塌成一档;不注,各卡 CSS 写各自的兜底,用户一拧才统一覆盖。
 */
export const CARD_SKIN_KNOB_LIMITS = {
	/** 一套皮肤最多几枚旋钮(面板一屏能拧完的量)。 */
	maxKnobs: 16,
	/** 下拉最多几个候选。 */
	maxOptions: 8,
	/** 旋钮 / 候选的人话名长度。 */
	label: { max: 24 },
	/** key 长度(变量名要人能读)。 */
	key: { max: 32 },
	/** 下拉候选 / 开关两端那种字面量的长度。 */
	value: { max: 80 },
	/** 一枚图片旋钮最多选几张(多张按推送轮换)。与皮肤包内资产同量级。 */
	maxImages: 12,
} as const;

/**
 * key:小写字母起头的 kebab。它直接拼进变量名,所以大写(CSS 自定义属性大小写敏感,
 * 面板与 CSS 各写一种就永远对不上)、下划线、非 ASCII 都不收。
 */
export const CARD_SKIN_KNOB_KEY_RE = /^[a-z][a-z0-9-]*$/;

/** 数值旋钮的单位。固定几种 —— 单位直接拼在数字后面进 CSS,不能是自由文本。 */
export const CARD_SKIN_KNOB_UNITS = ["px", "%", "em", "rem", "deg", "s", "ms"] as const;
export type CardSkinKnobUnit = (typeof CARD_SKIN_KNOB_UNITS)[number];

// ---- 上限 -------------------------------------------------------------------

/** 取值域的唯一事实源:server 的清洗 / 装包与 web 的编辑器都从这里读。 */
export const CARD_SKIN_LIMITS = {
	/** 网格列数,固定(CSS grid 惯例,2 / 3 / 4 等分都整除)。 */
	columns: 12,
	/** 卡宽 px。下限要装得下上舰卡的徽章 + 两行字,上限是截图与群里看图的常识。 */
	width: { min: 240, max: 1200 },
	/** 行 / 列间距 px。 */
	gap: { min: 0, max: 64 },
	/**
	 * **出血** px —— 卡片四周留给辉光的那圈余量(2026-09-14 主人拍板)。
	 *
	 * 存在的理由:出图截的是 `html` 的 boundingBox,而 `box-shadow` / `filter` 的辉光
	 * **不参与布局、不撑大任何盒子**,所以画在卡外的那一圈在成品里一个像素都没有。
	 * 皮肤要辉光就得自己声明留多宽,以及那圈底什么色(JPEG 没有 alpha,不给色就是白边)。
	 *
	 * 上限跟 `gap` 同一个数:64 已经是 600 宽的卡外扩到 728,再宽就不像一张卡了。
	 */
	bleed: { min: 0, max: 64 },
	/** 一张卡最多几个块。 */
	maxBlocks: 40,
	/** 网格最多几行(块的 row 上限)。 */
	maxRows: 60,
	/**
	 * **一行多高** px。画布按它画格子,出图按它给「单张图」那类块算真高度
	 * ({@link CardSkinBuiltinBlock.heightFromRows},2026-09-18 主人拍板)。
	 *
	 * 两边必须是同一个数:画布上量着 3 行摆好的封面,出图得也是那么高 —— 各写一份的话,
	 * 编辑器里摆的和真画出来的迟早是两回事(这一摊已经栽过)。
	 *
	 * 56 是画布先定的:再矮,块名与那行 `id · 列区间` 的小字就挤不下了。它同时也就成了
	 * 作者调图高的**步长**,粗是粗了点,但网格本来就是格子。
	 */
	rowHeight: 56,
	/**
	 * **层次** —— 两个块占同一片格子时谁压在上面(2026-09-15 主人拍板「重叠是特性」)。
	 *
	 * 网格允许两个块的列区间相交,那是 CSS Grid 的正常行为,也真有人要
	 * (角标压在封面上)。但不写层次的话,谁压谁只看块在数组里的先后 —— 想调就得去
	 * 改块的顺序,而那同时会改掉别的东西。
	 *
	 * 上限 9:十层足够表达一张卡里的任何前后关系,而数字一大,面板上那个框就开始
	 * 像个能填 9999 的东西了。**不给负数** —— 0 是地面,要沉底就把别的抬高,
	 * 留负数只会让「默认 0」变成一个有上有下的中间层,平白多一种想不清楚的状态。
	 */
	layer: { min: 0, max: 9 },
	/**
	 * 每块 CSS 的字节上限(含根块)。**按 UTF-8 字节算**,量的人是
	 * {@link cardSkinBytes} —— 三层(清洗器 / schema / 面板计数器)必须同一把尺。
	 */
	maxCssBytes: 16 * 1024,
	/** 每个自定义块 HTML 的字节上限(同上,UTF-8 字节)。 */
	maxHtmlBytes: 8 * 1024,
	/** 包名 / 作者 / 描述的长度。 */
	name: { min: 1, max: 40 },
	author: { max: 40 },
	description: { max: 200 },
	/** 包内资产数量与单个体积(与 dashboard 皮肤同量级)。 */
	maxAssets: 12,
	maxAssetBytes: 5 * 1024 * 1024,
	/** 根 / 块各自那张「资产变量表」最多几项(ADR-0014 决策 13 的 🔗:`--bn-asset-<名>`)。 */
	maxAssetVars: 8,
	/** 皮肤级 `fonts` 最多几款。 */
	maxFonts: 4,
	/**
	 * 出图后的卡片最大高度 px(ADR-0014 决策 19「卡片有最大高度,超了算失败」)。
	 *
	 * 4000 是从**两头**夹出来的:今天最高的一张真卡是九图动态(600 宽 × 约 1800 高),
	 * 留一倍余量让长图文动态不误伤;另一头,截图是 `page.screenshot` 一次性出一张 JPEG,
	 * 600 × 4000 已是 240 万像素、几兆内存,而镜像里 V8 的 old-space 只有 512MB ——
	 * 再往上一个数量级(一条 `height:100vh` 写错的皮肤 CSS 就能做到)会把浏览器和
	 * 本进程一起拖垮,而症状只是「推送莫名其妙停了」。
	 *
	 * 超限只回落默认皮肤重画一次,**不拒发**:内容本来就长的时候默认皮肤也会超,那是
	 * 内容的问题不是皮肤的,照发。
	 */
	maxHeight: 4000,
} as const;

/**
 * 皮肤里那几道体积闸量的**同一把尺**:UTF-8 字节。
 *
 * 三层都得用它 —— server 的清洗器、`CardSkinBlockSchema` 的长度闸、面板上那个
 * 「3000 / 8192」计数器。用 `s.length` 量的是 UTF-16 单元数,一个汉字才记 1:
 * 中文密集的自定义块会在面板上显示得好好的、也过得了 schema,存的时候被清洗器
 * 退回来。挑字节当权威是因为存盘与 zip 预算算的本来就是字节。
 *
 * `TextEncoder` 浏览器与 Node 都有;server 那两处用的 `Buffer.byteLength(s, "utf8")`
 * 结果相同,不必改回来。
 */
const UTF8 = new TextEncoder();

export function cardSkinBytes(s: string): number {
	return UTF8.encode(s).length;
}

// ---- 卡片皮肤的数据契约 ----------------------------------------------------------------

export type CardSkinFieldType = "text" | "number" | "bool" | "image";

/** 一个对外字段:路径、类型、人话名。`image` 类型才准出现在 `<img src="{…}">` 里。 */
export interface CardSkinField {
	path: string;
	type: CardSkinFieldType;
	label: string;
}

const f = (path: string, type: CardSkinFieldType, label: string): CardSkinField => ({
	path,
	type,
	label,
});

const AUTHOR_FIELDS = (who: string) => [
	f("up.name", "text", `${who}名`),
	f("up.face", "image", `${who}头像`),
];

/**
 * 每种卡对外承诺的字段(ADR-0014 决策 14)。**只增不删不改名。**
 * 已格式化的文本(「1.2 万」「已开播 1 小时」)直接给,占位符不带过滤器。
 * `is*` / `has*` 一律 bool,是 `showIf` 的目标。
 */
export const CARD_SKIN_FIELDS: Record<CardSkinKind, readonly CardSkinField[]> = {
	live: [
		...AUTHOR_FIELDS("主播"),
		f("live.title", "text", "直播标题"),
		f("live.area", "text", "分区"),
		f("live.time", "text", "开播时长 / 下播时间那句"),
		f("live.description", "text", "房间简介(纯文本)"),
		f("live.cover", "image", "封面(生效的那张)"),
		f("live.hasCover", "bool", "有没有封面"),
		f("live.isStreaming", "bool", "正在直播"),
		f("live.isEnded", "bool", "已下播"),
		f("stats.popularity", "text", "人气(直播中)/ 点赞(下播)"),
		f("stats.area", "text", "分区(同 live.area,给数据行用)"),
		f("stats.fans", "text", "粉丝数(直播中)/ 累计观看(下播)"),
		f("stats.fansChanged", "text", "粉丝变化(下播才有)"),
		f("stats.hasFansChanged", "bool", "有没有粉丝变化"),
	],
	dynamic: [
		...AUTHOR_FIELDS("UP 主"),
		f("up.isVip", "bool", "是大会员"),
		f("dynamic.type", "text", "动态类型(DYNAMIC_TYPE_*)"),
		f("dynamic.action", "text", "「投稿了视频」这类动作标签"),
		f("dynamic.time", "text", "发布时间"),
		f("dynamic.topic", "text", "话题"),
		f("dynamic.hasTopic", "bool", "有没有话题"),
		f("dynamic.isForward", "bool", "是转发"),
		f("dynamic.hasAdditional", "bool", "有没有附加内容(预约 / 商品…)"),
		f("dynamic.hasVideo", "bool", "带视频卡"),
		f("dynamic.hasPics", "bool", "带图"),
		f("video.title", "text", "视频标题"),
		f("video.desc", "text", "视频简介"),
		f("video.cover", "image", "视频封面"),
		f("video.duration", "text", "视频时长"),
		f("video.views", "text", "播放量"),
		f("video.danmaku", "text", "弹幕数"),
		f("pics.count", "number", "图片张数"),
		f("pics.first", "image", "第一张图"),
		f("stats.forward", "text", "转发数"),
		f("stats.comment", "text", "评论数"),
		f("stats.like", "text", "点赞数"),
	],
	sc: [
		f("sender.name", "text", "发送者名"),
		f("sender.face", "image", "发送者头像"),
		f("master.name", "text", "主播名"),
		f("master.face", "image", "主播头像"),
		f("sc.price", "text", "金额(带货币符号)"),
		f("sc.priceValue", "number", "金额数字"),
		f("sc.duration", "text", "留言时长"),
		f("sc.level", "number", "价位档(0~5)"),
		f("sc.text", "text", "留言"),
	],
	guard: [
		f("user.name", "text", "上舰用户名"),
		f("user.face", "image", "上舰用户头像"),
		f("user.isAdmin", "bool", "是房管"),
		f("master.name", "text", "主播名"),
		f("master.face", "image", "主播头像"),
		f("guard.level", "number", "舰长等级(1 总督 / 2 提督 / 3 舰长)"),
		f("guard.levelName", "text", "舰长 / 提督 / 总督"),
		f("guard.badge", "image", "徽章图"),
		f("guard.text", "text", "文字信息那句"),
	],
	roastBoard: [f("master.name", "text", "主播名"), f("report.days", "number", "统计天数")],
	roastSolo: [
		f("up.name", "text", "UP 主名"),
		f("up.face", "image", "UP 主头像"),
		f("report.days", "number", "统计天数"),
	],
	wordcloud: [f("master.name", "text", "主播名"), f("master.face", "image", "主播头像")],
};

/**
 * 每块 CSS 里指「块自己」的挂点。皮肤写 `[data-bn="self"]`,渲染器把它翻成该块的真实
 * 选择器 —— 与 dashboard 皮肤同一套「按 hook 存盘、注入时翻译」的哲学。
 */
export const CARD_SKIN_SELF_HOOK = "self";

/**
 * 根块(卡片外框)的两层挂点。外层是渐变 / 背景图那层(带 15px 内边距),内层是玻璃层
 * (圆角 / 阴影 / 白纱 / 模糊)。块都画在玻璃层里。
 */
export const CARD_SKIN_FRAME_HOOKS = {
	frame: "外框(渐变 / 背景图那一层)",
	glass: "玻璃层(圆角、阴影、白纱、模糊)",
} as const;
export type CardSkinFrameHook = keyof typeof CARD_SKIN_FRAME_HOOKS;

/** 主人自己传上来的资产在旋钮值里的前缀。**对外 API**,只增不改。 */
export const CARD_SKIN_UPLOAD_PREFIX = "upload:";

/**
 * 字体旋钮的值 → 宿主要做什么。
 *
 * - `upload:<资产 id>` —— 主人传的字体文件,宿主读盘拼 `@font-face`(与 `cardStyle.fontAsset`
 *   从前同一条路);
 * - 别的非空字符串 —— 一个家族名(系统字体、手填的、或者皮肤自带的那几款);
 * - 空串 / 别的类型 —— 没什么要注的(跟着兜底链走)。
 */
export function parseCardSkinFontKnobValue(
	value: unknown,
): { upload: string } | { family: string } | null {
	if (typeof value !== "string" || value === "") return null;
	if (value.startsWith(CARD_SKIN_UPLOAD_PREFIX)) {
		const id = value.slice(CARD_SKIN_UPLOAD_PREFIX.length);
		return id === "" ? null : { upload: id };
	}
	return { family: value };
}

/**
 * 图片旋钮的值 → 一串资产 id(多张按推送轮换)。空列表与「没拧过」同义,回 null。
 *
 * 混进来的空串 / 非字符串**剔掉**而不是整条作废:存量里被手改过的值不该让一整张卡的
 * 背景凭空消失。
 */
export function parseCardSkinImageKnobValue(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const ids = value.filter((v): v is string => typeof v === "string" && v !== "");
	return ids.length > 0 ? ids : null;
}

/** 一个内置块的目录条目:人话名 + 它内部可分别挂 CSS 的部件。 */
export interface CardSkinBuiltinBlock {
	label: string;
	/** 是复合块(头像 + 名字 + 时间捆一起)还是原子块(只画一样)。编辑器分组用。 */
	atom?: true;
	/**
	 * 内部挂点 → 人话名。皮肤写 `[data-bn="avatar"]`。
	 *
	 * `self` 是渲染器包在块外面那层 wrapper(网格里的格子),**不是块自己的根元素**。所以
	 * 2026-09-19 起(ADR-0014 决策 7 的 🔗)原子块的根也挂一个:它长什么样(字号、字色、圆角、
	 * 胶囊底色)全写在默认皮肤这个挂点的规则里,渲染器只留结构。根挂点的名字只有几个,按
	 * 「它是什么」取:图 `image`、文字 `text`、胶囊 / 角标 `pill`、留言气泡 `bubble`、分割线
	 * `line`;根之外的部件照旧各有各的名(正文文字里的 `body`、图廊里的 `pic`、互动数里的
	 * `icon`)。`atom` 只管编辑器分组,不代表「没有挂点」。
	 */
	hooks: Record<string, string>;
	/**
	 * 这块画的是**一张有确定尺寸的图**,它的高度由 `grid.rowSpan` 说了算
	 * (`rowSpan × ` {@link CARD_SKIN_LIMITS.rowHeight}),不由内容撑;图按
	 * `object-fit:cover` 填满那块地方(按比例裁,不压扁)。2026-09-18 主人拍板。
	 *
	 * **只标单张图。**文字块的高度取决于真实数据(标题一行还是三行、简介几行),写死就是
	 * 裁字或压到下一块身上 —— 那正是 ADR-0014 决策 6 否掉「绝对坐标排版」的理由;图廊
	 * 同理,它多高取决于有几张图。没标的块 `rowSpan` 照旧只是给画布看的一句声明。
	 *
	 * 画布照它决定上下两条边画不画把手:拉得动的,拉完出图就真的跟着变。
	 */
	heightFromRows?: true;
	/**
	 * 这块**只属于这几场**(`CARD_PREVIEW_SCENES[kind]` 里的 id;ADR-0014 决策 10 的
	 * 2026-09-19 🔗)。不写 = 共有块,每一场都有它。
	 *
	 * 只给编辑器用:画布切到哪一场就只摆这一场会有的块,加块目录上给独有块挂个小标。
	 * **出图端不读它** —— 图廊在视频那场本来就没数据、整块不画,目录只是把这件事提前
	 * 告诉画布。所以皮肤格式里没有任何场景名单:共有块改了处处改,没有「专属本场」。
	 */
	scenes?: readonly string[];
}

/**
 * 分割线块的块名。原来住在旧版式那份 schema 里(它退役了,见 ADR-0014 决策 17 的
 * 2026-09-18 🔗),但渲染器要靠它认出分割线 —— 「开头的收起、悬空的收起、末尾的弹掉」
 * 那套规矩就是按它判的。**单点定义**:块目录、皮肤渲染器、四份块库认的是同一个字符串。
 */
export const DIVIDER_TYPE = "divider";

/** 四种可编辑卡共用的分割线。 */
const DIVIDER_BLOCK: CardSkinBuiltinBlock = { label: "分割线", atom: true, hooks: { line: "线" } };

/**
 * 内置块目录:每种卡有哪些块、每块内部有哪些挂点。**块名与挂点名是对外 API。**
 *
 * **只有原子块与天生拆不动的块**(ADR-0014 决策 8 的 2026-09-18 🔗):复合块整批退役了 ——
 * 用户多是从默认皮肤复制一份再改,目录里留着「一块顶半张卡」的东西,能挪的就只有整行。
 *
 * `atom` 分的是**「这块画一样东西,还是捆了好几样」**,不是「能不能再拆」:转发框里确实
 * 套着一整张内层卡、图廊里确实有好几张图,但搬动时它们各是一件,所以是原子块。剩下的
 * 非原子块是一份**闭集**,由 `card-blocks.test.ts` 钉着:附加内容(预约 / 商品 / 通用 /
 * 关联视频四种形态结构各异、字段不在契约里,主人拍板不拆)与三种不可编辑卡的整卡块。
 */
export const CARD_SKIN_BUILTIN_BLOCKS: Record<
	CardSkinKind,
	Record<string, CardSkinBuiltinBlock>
> = {
	live: {
		// 角标与封面**占同一片格子**、层次更高,不再嵌在封面里(决策 8 的 2026-09-18 🔗)。
		// ⚠️ `image` 挂点是拆封面之前就有的**公开 API**,拆的时候连同 `<img>` 上那个
		// `data-bn` 一起掉了一次(`5fa842ca`)—— 挂点名只增不改不删,而且没有它,皮肤连
		// 「把封面压矮一点」都写不出来(`[data-bn="self"]` 是外面那层 div,在它上面写
		// height 图会直接溢出去)。
		cover: { label: "封面图", atom: true, heightFromRows: true, hooks: { image: "封面图片" } },
		status: { label: "直播状态", atom: true, hooks: { pill: "胶囊" } },
		title: { label: "直播标题", atom: true, hooks: { text: "文字" } },
		desc: { label: "简介", atom: true, hooks: { text: "文字" } },
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		avatar: { label: "头像", atom: true, hooks: { image: "头像图片" } },
		name: { label: "主播名", atom: true, hooks: { text: "文字" } },
		time: { label: "开播时间", atom: true, hooks: { text: "文字" } },
		// 数据区的三件(ADR-0014 决策 16 的 🔗):从前由三个显隐开关管,而开关管的是复合块
		// **内部的一行**、块级的 `showIf` 够不着 —— 所以拆成原子块,想少显示哪件就删哪块。
		popularity: { label: "人气 / 点赞", atom: true, hooks: { text: "文字" } },
		area: { label: "分区", atom: true, hooks: { text: "文字" } },
		fans: { label: "粉丝行", atom: true, hooks: { text: "文字" } },
	},
	dynamic: {
		additional: {
			label: "附加内容",
			hooks: { card: "附加卡", cover: "附加卡封面", button: "按钮" },
		},
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		avatar: { label: "头像", atom: true, hooks: { image: "头像图片" } },
		name: { label: "UP 主名", atom: true, hooks: { text: "文字" } },
		time: { label: "发布时间", atom: true, hooks: { text: "文字" } },
		// 文字与媒体是呈现态里分开的几份(`DynamicNode.text` / `.video` / `.pics`)。
		topic: { label: "话题", atom: true, hooks: { text: "文字" } },
		// 正文富文本整段留在渲染器(决策 7 的 2026-09-19 🔗),所以这块没有根挂点 ——
		// `body` 是富文本自己的根,样子也归它。
		text: { label: "正文文字", atom: true, hooks: { body: "正文" } },
		// 投稿视频那张卡拆成的五块。外面那圈灰底圆角容器不是块,是皮肤用 CSS 拼的 ——
		// 三段文字各带一段灰底、首尾分担圆角(决策 8 的 2026-09-18 🔗)。
		// 三组独有块各自只属于一场(`scenes`):画布切到别的场就不摆它们。
		videoCover: {
			label: "视频封面",
			atom: true,
			heightFromRows: true,
			hooks: { image: "封面图片" },
			scenes: ["video"],
		},
		videoDuration: { label: "视频时长", atom: true, hooks: { pill: "角标" }, scenes: ["video"] },
		videoTitle: { label: "视频标题", atom: true, hooks: { text: "文字" }, scenes: ["video"] },
		videoDesc: { label: "视频简介", atom: true, hooks: { text: "文字" }, scenes: ["video"] },
		videoStats: {
			label: "播放 · 弹幕数",
			atom: true,
			hooks: { text: "文字", stat: "一项数据" },
			scenes: ["video"],
		},
		// 图廊张数是动态的,拆不开,整块画。
		pics: {
			label: "图廊",
			atom: true,
			hooks: { pics: "图廊", pic: "图廊里的一张图" },
			scenes: ["pics"],
		},
		// 根就是转发框,它的样子挂在 `bubble` 上;框里是一整张内层卡,那些部件归内层卡
		// 自己的块管,这里不声明。
		forward: { label: "转发框", atom: true, hooks: { bubble: "转发框" }, scenes: ["forward"] },
		forwardCount: { label: "转发数", atom: true, hooks: { text: "文字", icon: "图标" } },
		commentCount: { label: "评论数", atom: true, hooks: { text: "文字", icon: "图标" } },
		likeCount: { label: "点赞数", atom: true, hooks: { text: "文字", icon: "图标" } },
	},
	sc: {
		// 留言的根是一层撑满格子的壳(居中靠块的 `self` 说),气泡与文字各一个挂点。
		message: { label: "留言", atom: true, hooks: { bubble: "留言气泡", text: "留言文本" } },
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		// 头像的根是那个把图裁圆的框,`image` 挂在框上 —— 尺寸与圆都归它,里头的 img 填满即可。
		avatar: { label: "发送者头像", atom: true, hooks: { image: "头像图片" } },
		name: { label: "发送者名", atom: true, hooks: { pill: "胶囊" } },
		price: { label: "金额", atom: true, hooks: { text: "文字" } },
		duration: { label: "时长胶囊", atom: true, hooks: { pill: "胶囊" } },
		to: {
			label: "「SC to」那一行",
			atom: true,
			hooks: {
				text: "文字",
				label: "「SC to」三个字",
				master: "主播那一组",
				masterAvatar: "主播小头像",
				masterName: "主播名",
			},
		},
	},
	guard: {
		badge: { label: "舰长徽章", atom: true, hooks: { image: "舰长徽章图" } },
		text: { label: "文字信息", atom: true, hooks: { text: "文字" } },
		[DIVIDER_TYPE]: DIVIDER_BLOCK,
		// 头像的根是那个把图裁圆的框,`image` 挂在框上 —— 尺寸与圆都归它。
		avatar: { label: "头像", atom: true, hooks: { image: "头像图片" } },
		user: { label: "用户名胶囊", atom: true, hooks: { pill: "胶囊", text: "文字" } },
		master: {
			label: "主播胶囊",
			atom: true,
			hooks: { pill: "胶囊", masterAvatar: "主播小头像", masterName: "主播名" },
		},
	},
	roastBoard: { body: { label: "周报榜单", hooks: {} } },
	roastSolo: { body: { label: "单人锐评", hooks: {} } },
	wordcloud: { body: { label: "弹幕词云", hooks: {} } },
};
