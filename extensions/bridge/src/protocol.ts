/**
 * 桥接协议的**边界层** —— 把不受信的外部帧变成 BN 内部形状。
 *
 * wire 形状(帧、能力词表、close code、协议版本)的单一来源是
 * `./contract.js` 是 wire 形状;这里放宿主侧职责的那一半:zod 校验、
 * 版本判定、能力归一。给插件作者看的规范在 `../PROTOCOL.md`。
 *
 * 这一层最要紧的一条纪律是**「不认识的帧忽略、认识但畸形的帧拒」**:
 * 反过来任何一边都是 bug —— 前者反了,桥升级多发一种帧就把老 BN 打死,协议再也没法
 * 单边演进;后者反了,一条畸形帧被当成正常帧喂进 BN 内部。
 */

import type { ExtensionI18n, FailureCode, Result } from "@bilibili-notify/extension";
import { fail, ok } from "@bilibili-notify/extension";
import { z } from "zod";
import {
	BRIDGE_CAPABILITIES,
	BRIDGE_CAPABILITY_STATES,
	BRIDGE_KINDS,
	BRIDGE_PROTOCOL_VERSION,
	BRIDGE_TO_SERVER_FRAME_TYPES,
	type BridgeCapabilityReport,
	type BridgeCapabilityState,
	type BridgeCapabilityWire,
	type BridgeProtocolVersion,
	type BridgeResultFrame,
	type BridgeToServerFrame,
} from "./contract.js";

// ---------------------------------------------------------------------------
// 帧 schema
// ---------------------------------------------------------------------------

const ProtocolVersionSchema = z.object({
	major: z.number().int().min(0),
	minor: z.number().int().min(0),
});

/**
 * 能力表**故意校验得松**:键与值都开放。一格 BN 没见过的能力不该把整帧握手拒掉 ——
 * 收窄是 {@link normalizeBridgeCapabilities} 的事,而且只在那一处做。
 */
const CapabilityWireSchema = z.record(z.string(), z.string());

const BotSchema = z.object({
	botId: z.string().min(1),
	platform: z.string().min(1),
	name: z.string().optional(),
	selfId: z.string().optional(),
	// 与能力表同一个道理:wire 上只要求是字符串,收窄在 normalizeBridgeBotIcon 一处做 ——
	// 一枚坏图标不该把整份 bot 名单拒掉。
	icon: z.string().optional(),
	capabilities: CapabilityWireSchema.optional(),
});

const HelloFrameSchema = z.object({
	type: z.literal("hello"),
	protocol: ProtocolVersionSchema,
	bridge: z.object({
		kind: z.enum(BRIDGE_KINDS),
		name: z.string().optional(),
		version: z.string().optional(),
	}),
	bots: z.array(BotSchema),
});

const BotsFrameSchema = z.object({
	type: z.literal("bots"),
	bots: z.array(BotSchema),
});

/**
 * 入站那两格链接的上限(协议 1.4)。**是门,不是注释** —— 没有它,一条 `inbound` 帧能驮
 * 上来近一兆的链接(整帧上限 `MAX_BRIDGE_FRAME_BYTES` 就是 1 MB),而下游链接解析要
 * 逐条过正则:一个不花钱的放大器。
 *
 * 数字取得宽松是刻意的:一张真卡里顶多几条链接,32 条 × 2048 字够任何正常的卡用,
 * 撞得到这道门的只会是 bug 或者恶意。
 *
 * 🔴 超了**截断**(单条超长的丢掉、总数截到上限),**不按畸形帧拒**:这里存在一个安全的
 * 解释 ——「这条消息里的卡链接就是前 32 条」,而畸形留给形状真的不对的(§11:认识的 type
 * 形状不对)。代价不对称是关键:拒帧会让 server 回 close `4003`,而插件侧把 4003 当终局
 * 永不重连 —— 一张卡里 URL 多了几条就把整条桥永久打死,而这道门本来只是防放大器。
 */
export const BRIDGE_INBOUND_LINKS_MAX = 32;
export const BRIDGE_INBOUND_LINK_MAX_CHARS = 2048;

const InboundLinksSchema = z
	.array(z.string().min(1))
	.transform((links) =>
		links
			.filter((link) => link.length <= BRIDGE_INBOUND_LINK_MAX_CHARS)
			.slice(0, BRIDGE_INBOUND_LINKS_MAX),
	)
	.optional();

const InboundMessageSchema = z.discriminatedUnion("scope", [
	z.object({
		scope: z.literal("private"),
		userId: z.string().min(1),
		text: z.string(),
	}),
	z.object({
		scope: z.literal("group"),
		groupId: z.string().min(1),
		userId: z.string().min(1),
		text: z.string(),
		// 1.4 起的两格分享卡链接。**可选**:老桥(1.3)一格都不报,而 major 相同就得连得住 ——
		// 写成必填的话,症状是所有老桥握完手、第一条群消息就被 4003 踢掉。
		cardLinks: InboundLinksSchema,
		miniAppCardLinks: InboundLinksSchema,
	}),
]);

const InboundFrameSchema = z.object({
	type: z.literal("inbound"),
	botId: z.string().min(1),
	platform: z.string().min(1),
	message: InboundMessageSchema,
});

const ResultFrameSchema = z.object({
	type: z.literal("result"),
	id: z.string().min(1),
	ok: z.boolean(),
	code: z.string().optional(),
	message: z.string().optional(),
	upstreamCode: z.union([z.string(), z.number()]).optional(),
	err: z.string().optional(),
});

const PongFrameSchema = z.object({ type: z.literal("pong"), id: z.string().min(1).optional() });

const BridgeFrameSchema = z.discriminatedUnion("type", [
	HelloFrameSchema,
	BotsFrameSchema,
	InboundFrameSchema,
	ResultFrameSchema,
	PongFrameSchema,
]);

type ParsedBridgeFrame = z.infer<typeof BridgeFrameSchema>;

/**
 * 契约 ⇄ schema **双向**对齐的编译期守卫:任一侧加了字段而另一侧没跟上,下面那个常量
 * 就编译不过。单向不够 —— schema 漏掉契约里的一格时,类型上「有」、运行时被 zod
 * strip 掉「没有」,正是那类门禁全绿、只有真机露馅的 bug。
 */
type BridgeFrameContractAligned = ParsedBridgeFrame extends BridgeToServerFrame
	? BridgeToServerFrame extends ParsedBridgeFrame
		? true
		: never
	: never;

void (true satisfies BridgeFrameContractAligned);

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 两种失败,处置不同:`unsupported` 记一行 debug 继续用这条连接,`invalid` 断连
 * (`BRIDGE_CLOSE_CODES.badFrame`)。
 */
export type BridgeFrameParseResult = Result<{ frame: BridgeToServerFrame }>;

const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set(BRIDGE_TO_SERVER_FRAME_TYPES);

function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
		.join("; ");
}

export function parseBridgeFrame(raw: unknown, t: ExtensionI18n["t"]): BridgeFrameParseResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return fail("invalid", t("error.frameObject"));
	}
	const type = (raw as { type?: unknown }).type;
	if (typeof type !== "string") {
		return fail("invalid", t("error.frameType"));
	}
	// 认不认识要在 zod 之前判:判别联合对没见过的 type 只会回一条「不是这几个之一」,
	// 分不出「桥比我新」与「这是垃圾」—— 而这两者的处置一个是忽略、一个是断连。
	if (!KNOWN_FRAME_TYPES.has(type)) {
		return fail("unsupported", t("error.unknownFrame", { type }));
	}
	const parsed = BridgeFrameSchema.safeParse(raw);
	if (!parsed.success) {
		return fail("invalid", describeIssues(parsed.error));
	}
	return ok({ frame: parsed.data });
}

// 同名的正本住在 internal;拓展只拿到 `FailureCode` 类型,运行时不能从核心借这张表。
// 两边由 下方的类型断言双向钉住:任何一边加码而另一边没跟上,类型检查当场红。
const FAILURE_CODES = [
	"not_found",
	"invalid",
	"unauthorized",
	"rate_limited",
	"unavailable",
	"not_configured",
	"timeout",
	"unsupported",
	"conflict",
	"indeterminate",
	"unknown",
] as const satisfies readonly FailureCode[];

type UncoveredFailureCode = Exclude<FailureCode, (typeof FAILURE_CODES)[number]>;
void (true satisfies UncoveredFailureCode extends never ? true : never);

const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set(FAILURE_CODES);

/** 按顺序挑第一句非空白的话;判空用 trim,交出去的是原话。 */
function firstNonBlank(...candidates: (string | undefined)[]): string | undefined {
	for (const candidate of candidates) {
		if (candidate !== undefined && candidate.trim() !== "") return candidate;
	}
	return undefined;
}

/**
 * 把一个 `send` 回执翻成桥统一的发送结果。新写法按标准码结算;认不得的码记 `unknown`,
 * 只带 `err` 的旧回执也记 `unknown`,都保留原来的话给主人看。空白的当没给 —— 否则失败原因
 * 会在推送历史里显示成空白,空的 `message` 还会吞掉同帧里有内容的 `err`。
 */
export function sendResultFromReceipt(frame: BridgeResultFrame): Result {
	if (frame.ok) return ok();
	const code: FailureCode =
		frame.code !== undefined && KNOWN_FAILURE_CODES.has(frame.code)
			? (frame.code as FailureCode)
			: "unknown";
	const message = firstNonBlank(frame.message, frame.err) ?? "桥回了失败,没说原因";
	return frame.upstreamCode === undefined
		? fail(code, message)
		: fail(code, message, { upstreamCode: frame.upstreamCode });
}

// ---------------------------------------------------------------------------
// 版本
// ---------------------------------------------------------------------------

/**
 * **只看 major**。minor 差多少、谁大谁小都接受 —— 不然协议加一个可选字段就得逼所有
 * 插件同时发版。major 不同一律拒,包括桥比 BN 旧的情况。
 */
export function isBridgeProtocolCompatible(theirs: BridgeProtocolVersion): boolean {
	return theirs.major === BRIDGE_PROTOCOL_VERSION.major;
}

// ---------------------------------------------------------------------------
// 能力归一
// ---------------------------------------------------------------------------

const CAPABILITY_STATES: ReadonlySet<string> = new Set(BRIDGE_CAPABILITY_STATES);

/**
 * 开放词表 → 闭合的六项三态。归一**只在边界做这一次**:让「桥没报」以 `unknown`
 * 的身份进业务层,而不是以「这个键不存在」的身份 —— 后者迟早在某处被 `?? true`
 * 之类的兜底悄悄当成「支持」。
 *
 * 缺的、值不认识的一律 `unknown`(保守:不是「不支持」,那是个结论,我们没有);
 * 桥多报的键静默丢掉,让协议两个方向都能单边演进。
 */
/** 图标 data URL 的上限。名单一变就整份重发,一枚图标不该比一条消息还重。 */
const BRIDGE_BOT_ICON_MAX_BYTES = 32 * 1024;

const BOT_ICON_DATA_URL = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

/**
 * bot 的平台图标过一道门:只认 `data:image/…;base64,` 且不超上限,其余一律当没给。
 *
 * 🔴 **不收 http(s) 地址**:面板每次打开都会去那个地址取图,等于替对家点一次名(拿得到
 * 内网 IP 与访问时间)。data URL 是自包含的,浏览器画它不会发任何请求;而 `<img>` 里的
 * SVG 不会跑脚本、也拉不进外部资源,所以这里不用像清单图标那样逐标签过白名单。
 */
export function normalizeBridgeBotIcon(icon: string | undefined): string | undefined {
	if (!icon) return undefined;
	if (icon.length > BRIDGE_BOT_ICON_MAX_BYTES) return undefined;
	return BOT_ICON_DATA_URL.test(icon) ? icon : undefined;
}

export function normalizeBridgeCapabilities(
	wire: BridgeCapabilityWire | undefined,
): BridgeCapabilityReport {
	const report = {} as BridgeCapabilityReport;
	for (const capability of BRIDGE_CAPABILITIES) {
		const reported = wire?.[capability];
		report[capability] =
			typeof reported === "string" && CAPABILITY_STATES.has(reported)
				? (reported as BridgeCapabilityState)
				: "unknown";
	}
	return report;
}
