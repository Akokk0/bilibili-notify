/**
 * 假平台适配器 —— 给推送守卫③一个真包:`PlatformAdapter` 的每个成员都有人实现、有人从宿主那头驱动。
 *
 * **硬约束**:`start` 不建连接、不出网、不起定时器。九条 e2e 都装着假源,装上以后登记表里多一个它,
 * 那几条不许因此变红、变慢。它收到的每一次发送只记进内存环(最近 50 条),经拓展页的视图给人看。
 */

import type {
	Connection,
	ConnectionCandidate,
	ConnectionCapabilities,
	DestinationRef,
	NotificationPayload,
	PlatformAdapterContext,
	PlatformAdapterDef,
} from "@bilibili-notify/extension";
import {
	fail,
	neutralPlatformDescriptor,
	ok,
	type SettingsFieldMeta,
} from "@bilibili-notify/extension";
import { z } from "zod";

/**
 * 连接配置:清单里的 `contributes.push.settingsFields` 由构建从这份规则导出(规则只写一份),
 * 给人看的那几格写在 `.meta()` 上。
 */
export const FakeConnectionSettingsSchema = z.object({
	atAll: z
		.boolean()
		.default(false)
		.meta({
			label: "支持 @全体",
			description: "打开后,这条连接对外说自己能单发 @全体(用来演推送路由的 @全体 那一支)。",
		} satisfies SettingsFieldMeta),
	inboundFrom: z
		.string()
		.default("")
		.meta({
			label: "入站发送者",
			description:
				"填了,页上的入站按钮会以这个地址向女仆发一条私聊 /status,这条连接也就对外说自己收得到回复;留空就是收不到。",
			placeholder: "owner-address",
		} satisfies SettingsFieldMeta),
});
export type FakeConnectionSettings = z.infer<typeof FakeConnectionSettingsSchema>;

/** 记账环的容量。 */
const SENT_RING_SIZE = 50;
/** 记进账里的一段文字最长这么多字,再长截短。 */
const SHOWN_TEXT_MAX = 80;

/** 账上一条的一段载荷:种类,以及有字的那几种截短后的字。 */
export interface FakeSentSegment {
	kind: string;
	text?: string;
}

/** 假适配器记下的一次发送。 */
export interface FakeSentEntry {
	connectionId: string;
	platform: string;
	destination: {
		kind: "session" | "endpoint";
		scope?: string;
		address?: string;
		parentAddress?: string;
		endpointId?: string;
	};
	segments: FakeSentSegment[];
}

/** 对账表里一条连接留的两样:在哪个平台、开没开。 */
interface TrackedConnection {
	platform: string;
	enabled: boolean;
}

export interface FakeAdapterHooks {
	/** 连接名单变了(视图要重取)。 */
	changed(): void;
}

/** 这条连接的设置:递到手上的本来就是解过的输出,这里再过一遍 schema 只是给类型和兜底。 */
export function settingsOf(connection: Connection): FakeConnectionSettings {
	const parsed = FakeConnectionSettingsSchema.safeParse(connection.settings);
	return parsed.success ? parsed.data : FakeConnectionSettingsSchema.parse({});
}

function shorten(text: string): string {
	return text.length <= SHOWN_TEXT_MAX ? text : `${text.slice(0, SHOWN_TEXT_MAX)}…`;
}

/** 载荷拆成各段:只记种类,以及能读的那点字。 */
function segmentsOf(payload: NotificationPayload): FakeSentSegment[] {
	switch (payload.kind) {
		case "text":
			return [{ kind: "text", text: shorten(payload.text) }];
		case "image":
			return [
				payload.caption === undefined
					? { kind: "image" }
					: { kind: "image", text: shorten(payload.caption) },
			];
		case "composite":
			return payload.segments.map((segment): FakeSentSegment => {
				switch (segment.kind) {
					case "text":
						return { kind: "text", text: shorten(segment.text) };
					case "link":
						return { kind: "link", text: shorten(segment.href) };
					default:
						return { kind: segment.kind };
				}
			});
		case "native-share":
			return [{ kind: "native-share", text: shorten(payload.title) }];
		default:
			return [{ kind: payload.kind }];
	}
}

function destinationOf(destination: DestinationRef): FakeSentEntry["destination"] {
	if (destination.kind === "endpoint") return { kind: "endpoint", endpointId: destination.id };
	return {
		kind: "session",
		scope: destination.scope,
		address: destination.address,
		...(destination.parentAddress === undefined
			? {}
			: { parentAddress: destination.parentAddress }),
	};
}

/** 「确认支持 / 确认不支持」的两个小构造 —— `checkedAt` 是带时区的 ISO(UTC)。 */
function supported() {
	return { state: "supported" as const, checkedAt: new Date().toISOString() };
}
function unsupported(reason: string) {
	return { state: "unsupported" as const, reason, checkedAt: new Date().toISOString() };
}

/** 按这条连接的设置答 atAll 与 inbound 两格(`capabilities` 与 `probeCapabilities` 共用)。 */
function settingsCapabilities(connection: Connection) {
	const settings = settingsOf(connection);
	return {
		atAll: settings.atAll ? supported() : unsupported("这条假连接没打开 @全体"),
		inbound: settings.inboundFrom !== "" ? supported() : unsupported("这条假连接没填入站发送者"),
	};
}

function candidate(platform: string, name: string): ConnectionCandidate {
	return {
		name,
		platform: { ...neutralPlatformDescriptor(platform), label: name, shortLabel: "假" },
		settings: FakeConnectionSettingsSchema.parse({}),
	};
}

const CANDIDATES: readonly (() => ConnectionCandidate)[] = [
	// 会话型:群、私聊、频道三种(频道是两层地址用的,`parentAddress` 由主人手填)。
	() => candidate("fake-chat", "假聊天"),
	// 端点型:单向出站终点,目标由连接托管。
	() => ({
		...candidate("fake-hook", "假钩子"),
		platform: {
			...neutralPlatformDescriptor("fake-hook"),
			label: "假钩子",
			shortLabel: "假",
			targetKind: "endpoint",
			// 与内置 webhook 同一个约定:端点型的范围只写 channel。
			scopes: ["channel"],
		},
	}),
];

/**
 * 造一个假适配器。交回的 `def` 是登记给宿主的那份;其余几个读口给拓展页的视图与入站 / 问题按钮用。
 */
export function createFakeAdapter(hooks: FakeAdapterHooks) {
	/** `start` 拿到的适配器上下文;`stop` 之后清掉。 */
	let running: PlatformAdapterContext | undefined;
	/** 连接 id → 平台、开没开。对账的结果,「管着几条连接」读它。 */
	let tracked = new Map<string, TrackedConnection>();
	/** 最近的发送,最旧的在前。 */
	const sentRing: FakeSentEntry[] = [];

	// #region sample: adapter-reconcile
	// 对账:读一遍此刻归我的连接,和上次记的表比;没变是空操作,变了换表、喊视图刷新。
	// 幂等 —— 同一份名单来多少次都一样;不写配置、不触发探测(会经 `config-changed` 绕回来)。
	function reconcile(): boolean {
		if (!running) return false;
		const next = new Map<string, TrackedConnection>();
		for (const connection of running.connections()) {
			next.set(connection.id, { platform: connection.platform, enabled: connection.enabled });
		}
		const unchanged =
			next.size === tracked.size &&
			[...next].every(([id, one]) => {
				const old = tracked.get(id);
				return old?.platform === one.platform && old.enabled === one.enabled;
			});
		if (unchanged) return false;
		tracked = next;
		return true;
	}
	// #endregion sample: adapter-reconcile

	// #region sample: adapter-send
	// 发送:只用递进来的 `connection` 与去向,**不查自己记的连接表** —— 这就是「只调 HTTP 接口的适配器
	// 不用管连接名单」的样子。记一条账(满 50 条丢最旧的),回成功。
	async function send(
		connection: Connection,
		destination: DestinationRef,
		payload: NotificationPayload,
	) {
		sentRing.push({
			connectionId: connection.id,
			platform: connection.platform,
			destination: destinationOf(destination),
			segments: segmentsOf(payload),
		});
		if (sentRing.length > SENT_RING_SIZE) sentRing.shift();
		return ok({ latencyMs: 0 });
	}
	// #endregion sample: adapter-send

	const def = {
		// 故意的:下面三个成员不对拓展开放(ADR-0024 决策 11),类型里排除,这里照样塞进去,
		// 给推送守卫③证明宿主运行时会把 `adapterKey` 覆盖成拓展 id、把另两个摘掉。
		adapterKey: "onebot",
		listAddressCandidates: async () => ok({ candidates: [] }),
		connectionAuth: {
			begin: async () => fail("unsupported", "fake platform does not support connection auth"),
			state: async () => fail("unsupported", "fake platform does not support connection auth"),
			takeDraft: async () => fail("unsupported", "fake platform does not support connection auth"),
		},

		settingsSchema: FakeConnectionSettingsSchema,
		async listConnectionCandidates() {
			return CANDIDATES.map((make) => make());
		},
		// #region sample: adapter-start
		start(ctx: PlatformAdapterContext) {
			running = ctx;
			// 先对一次账,再订变更。头一次对账不算「变了」:视图本来就是现取的。
			reconcile();
			ctx.onConnectionsChanged(() => {
				if (reconcile()) hooks.changed();
			});
		},
		// #endregion sample: adapter-start
		stop() {
			running = undefined;
			tracked = new Map();
		},
		isAvailable(_connection: Connection, destination: DestinationRef) {
			return destination.kind === "endpoint" || destination.address !== "";
		},
		send,
		async probe() {
			return ok({ latencyMs: 0 });
		},
		capabilities(connection: Connection): ConnectionCapabilities {
			// 原生分享恒答「还不知道」:逼宿主在手动「测试」时补探一次。
			return { ...settingsCapabilities(connection), nativeShare: { state: "unknown" } };
		},
		async probeCapabilities(connection: Connection): Promise<ConnectionCapabilities> {
			return {
				...settingsCapabilities(connection),
				nativeShare: unsupported("假平台发不了原生分享"),
			};
		},
	};

	return {
		// 故意的:见上面 `def` 里那三个成员。
		def: def as unknown as PlatformAdapterDef,
		/** 此刻管着几条连接(对账表的大小)。 */
		connectionCount: () => tracked.size,
		/** 最近的发送,最旧的在前。 */
		sent: (): readonly FakeSentEntry[] => [...sentRing],
		/** 在跑的适配器上下文;没起来(或已停下)是 `undefined`。 */
		context: () => running,
	};
}

export type FakeAdapter = ReturnType<typeof createFakeAdapter>;
