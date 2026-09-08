/**
 * 桥接协议的**边界层** —— 把不受信的外部帧变成 BN 内部形状。
 *
 * wire 形状(帧、能力词表、close code、协议版本)的单一来源是
 * `@bilibili-notify/contract` 的 `bridge` 段;这里放服务端职责的那一半:zod 校验、
 * 版本判定、能力归一。给插件作者看的规范在 `docs/protocol/bridge.md`。
 *
 * 这一层最要紧的一条纪律是**「不认识的帧忽略、认识但畸形的帧拒」**:
 * 反过来任何一边都是 bug —— 前者反了,桥升级多发一种帧就把老 BN 打死,协议再也没法
 * 单边演进;后者反了,一条畸形帧被当成正常帧喂进 BN 内部。
 */

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
	type BridgeToServerFrame,
} from "@bilibili-notify/contract";
import { z } from "zod";

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
	err: z.string().optional(),
});

const PongFrameSchema = z.object({ type: z.literal("pong") });

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

export const BRIDGE_FRAME_CONTRACT_ALIGNED: BridgeFrameContractAligned = true;

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 三态,不是两态。`unknown-type` 与 `invalid` 的**处置完全不同**:前者记一行 debug
 * 继续用这条连接,后者断连(`BRIDGE_CLOSE_CODES.badFrame`)。
 */
export type BridgeFrameParse =
	| { ok: true; frame: BridgeToServerFrame }
	| { ok: false; reason: "unknown-type"; type: string }
	| { ok: false; reason: "invalid"; message: string };

const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set(BRIDGE_TO_SERVER_FRAME_TYPES);

function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length ? issue.path.join(".") : "(根)"}: ${issue.message}`)
		.join("; ");
}

export function parseBridgeFrame(raw: unknown): BridgeFrameParse {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reason: "invalid", message: "帧不是一个对象" };
	}
	const type = (raw as { type?: unknown }).type;
	if (typeof type !== "string") {
		return { ok: false, reason: "invalid", message: "帧没有 type" };
	}
	// 认不认识要在 zod 之前判:判别联合对没见过的 type 只会回一条「不是这几个之一」,
	// 分不出「桥比我新」与「这是垃圾」—— 而这两者的处置一个是忽略、一个是断连。
	if (!KNOWN_FRAME_TYPES.has(type)) {
		return { ok: false, reason: "unknown-type", type };
	}
	const parsed = BridgeFrameSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, reason: "invalid", message: describeIssues(parsed.error) };
	}
	return { ok: true, frame: parsed.data };
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
 * 开放词表 → 闭合的五项三态。归一**只在边界做这一次**:让「桥没报」以 `unknown`
 * 的身份进业务层,而不是以「这个键不存在」的身份 —— 后者迟早在某处被 `?? true`
 * 之类的兜底悄悄当成「支持」。
 *
 * 缺的、值不认识的一律 `unknown`(保守:不是「不支持」,那是个结论,我们没有);
 * 桥多报的键静默丢掉,让协议两个方向都能单边演进。
 */
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
