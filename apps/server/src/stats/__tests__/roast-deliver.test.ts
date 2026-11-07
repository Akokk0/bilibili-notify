/**
 * 锐评投递 —— 多目标发送里「停用的目标」怎么处理。
 *
 * 缝在 `deliverRoast`:目标 id 列表进,发了谁 / 跳过谁 / 谁失败出。投递本体(渲染、
 * 降级)不在这儿测;这里只看它对目标表与连接表的判断。
 *
 * 「停用」在链接解析与周报里是同一个意思(主人定的):目标或它的连接停用 = 暂停,勾着
 * 也不发。以前的做法是把停用目标扔给推送管线,管线判它不可达、退避重试到上限再报失败 ——
 * 一次停用换来一条失败通知,而且要等好几分钟。
 */

import type { Connection, DeliveryResult, PushTarget } from "@bilibili-notify/internal";
import { fail, identityColor, makeDefaultGlobalSettings, ok } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	type BoardLike,
	buildRoastPayload,
	deliverRoast,
	type RoastDeliverDeps,
	type SoloLike,
} from "../roast-deliver.js";

const ADAPTER = "11111111-1111-4111-8111-111111111111";
const ADAPTER_OFF = "22222222-2222-4222-8222-222222222222";
const T_ON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_OFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_ON_ADAPTER_OFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const BOARD: BoardLike = {
	pushText: "本周榜单",
	pigeon: { subscriptionId: "s1", reason: "鸽" },
	diligent: { subscriptionId: "s2", reason: "勤" },
	roast: [],
	scores: [],
};

function target(id: string, connectionId: string, enabled: boolean): PushTarget {
	return {
		id,
		name: id.slice(0, 4),
		connectionId,
		scope: "group",
		enabled,
		kind: "session",
		address: "123",
	} as PushTarget;
}

function connection(id: string, enabled: boolean): Connection {
	return { id, name: "bot", enabled, platform: "onebot", config: {} } as unknown as Connection;
}

function makeDeps() {
	const sendToTarget = vi.fn(async (_id: string): Promise<DeliveryResult> => ok({ latencyMs: 1 }));
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const deps = {
		runtime: {
			pipeline: { imageRenderer: null, push: { sendToTarget } },
			serviceCtx: { logger },
			subscriptionStateStore: { get: () => undefined },
		},
		store: {
			getGlobals: () => makeDefaultGlobalSettings(),
			getSubscriptions: () => [],
			getTargets: () => [
				target(T_ON, ADAPTER, true),
				target(T_OFF, ADAPTER, false),
				target(T_ON_ADAPTER_OFF, ADAPTER_OFF, true),
			],
			getConnections: () => [connection(ADAPTER, true), connection(ADAPTER_OFF, false)],
		},
	} as unknown as RoastDeliverDeps;
	return { deps, sendToTarget };
}

describe("deliverRoast — 没送到的带着投递那头的失败", () => {
	const opts = { kind: "board" as const, result: BOARD, days: 7, targetIds: [T_ON] };

	it("投递回了失败 → failed 里是那条失败原样(码、原话、upstreamCode)", async () => {
		const { deps, sendToTarget } = makeDeps();
		const failure = fail("rate_limited", "慢点", { upstreamCode: 22009 });
		sendToTarget.mockResolvedValueOnce(failure);
		const out = await deliverRoast(deps, opts);
		expect(out.sent).toEqual([]);
		expect(out.failed).toEqual([{ targetId: T_ON, failure }]);
	});

	it("发送口抛错 → unavailable + 原话", async () => {
		const { deps, sendToTarget } = makeDeps();
		sendToTarget.mockRejectedValueOnce(new Error("sender exploded"));
		const out = await deliverRoast(deps, opts);
		expect(out.failed).toEqual([
			{ targetId: T_ON, failure: { ok: false, code: "unavailable", message: "sender exploded" } },
		]);
	});

	it("推送链路还没起 → unavailable", async () => {
		const { deps } = makeDeps();
		(deps.runtime as { pipeline: unknown }).pipeline = null;
		const out = await deliverRoast(deps, opts);
		expect(out.failed).toEqual([
			{ targetId: T_ON, failure: { ok: false, code: "unavailable", message: "服务尚未就绪" } },
		]);
	});
});

describe("deliverRoast — 停用的目标", () => {
	it("都启用 → 每个目标发一次,skipped 为空", async () => {
		const { deps, sendToTarget } = makeDeps();
		const out = await deliverRoast(deps, {
			kind: "board",
			result: BOARD,
			days: 7,
			targetIds: [T_ON],
		});
		expect(sendToTarget).toHaveBeenCalledTimes(1);
		expect(out.sent).toEqual([T_ON]);
		expect(out.skipped).toEqual([]);
		expect(out.failed).toEqual([]);
	});

	it("目标本身停用 → 跳过、记进 skipped、不算失败、不碰推送管线", async () => {
		const { deps, sendToTarget } = makeDeps();
		const out = await deliverRoast(deps, {
			kind: "board",
			result: BOARD,
			days: 7,
			targetIds: [T_ON, T_OFF],
		});
		expect(sendToTarget.mock.calls.map(([id]) => id)).toEqual([T_ON]);
		expect(out.sent).toEqual([T_ON]);
		expect(out.skipped).toEqual([T_OFF]);
		expect(out.failed).toEqual([]);
	});

	it("目标所属的连接停用 → 同样跳过", async () => {
		const { deps, sendToTarget } = makeDeps();
		const out = await deliverRoast(deps, {
			kind: "board",
			result: BOARD,
			days: 7,
			targetIds: [T_ON_ADAPTER_OFF, T_ON],
		});
		expect(sendToTarget.mock.calls.map(([id]) => id)).toEqual([T_ON]);
		expect(out.skipped).toEqual([T_ON_ADAPTER_OFF]);
	});
});

/**
 * 卡上的人(ADR-0020 决策 15 / 3):按订阅 id 认,两支订阅都行。
 *
 * - 拓展的头像在资料里是图库引用(`avatar`),面板用的同源地址 `/api/images/<ref>` 截图的浏览器加载不到 —— 出卡前
 *   从图库读字节、转成内嵌图(同 ADR-0019 决策 68 那个坑)。B 站头像抓进图库后同样读图库;头像还没抓到(资料里只有来源地址 `avatarUrl`)就没有头像 —— 渲染页不联网,远端图链交过去也画不出来。
 * - 颜色跟着人走,与面板同一个算法(`identityColor`):B 站按 uid,拓展按「拓展 id:外部 id」。
 * - 名字:所有来源都走同一条链(资料里的名字 → 身份标签);B 站经自己的描述符仍是 UID xxx。
 */
describe("buildRoastPayload — 卡上的人", () => {
	it("即使来源未运行，锐评仍按宿主保留的来源描述取色", async () => {
		const { deps, generateRoastSoloCard } = makeCardDeps();
		deps.runtime.sourceRegistry.getRunView = (sourceKey) => ({
			sourceKey,
			status: "failed",
			descriptor: { label: "Library", supportedFeatures: [], colorByExternalId: true },
		});
		await buildRoastPayload(deps, {
			kind: "solo",
			days: 7,
			result: { subscriptionId: "s-dy", pushText: "", verdict: "ok", score: 60, highlights: [] },
		});
		const data = generateRoastSoloCard.mock.calls[0]?.[0] as { creator: { color: string } };
		expect(data.creator.color).toBe("#fb7299");
	});
	/** 最小的 PNG 文件头就够 `sniffImageFormat` 认出来。 */
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const BILI = {
		id: "s-bili",
		identity: { sourceKey: "bilibili", externalId: "12345" },
		overrides: {},
	};
	/** 头像已经抓进图库的 B 站订阅(资料里有 `avatar` 引用,也记着来源地址)。 */
	const BILI_STORED = {
		id: "s-bili-stored",
		identity: { sourceKey: "bilibili", externalId: "67890" },
		overrides: {},
	};
	const EXT = {
		id: "s-dy",
		identity: { sourceKey: "douyin", externalId: "12345" },
		overrides: {},
	};
	const EXT_BARE = {
		id: "s-bare",
		identity: { sourceKey: "douyin", externalId: "sec-bare" },
		overrides: {},
	};

	/** 拓展订阅 s-dy 资料里的头像引用。 */
	const DY_REF = `${"d".repeat(64)}.png`;
	/** B 站订阅 s-bili-stored 资料里的头像引用。 */
	const BILI_REF = `${"e".repeat(64)}.png`;

	/** `images`:图库里每个引用对应的字节(`"throws"` = 读盘抛了);默认 s-dy 的头像在。 */
	function makeCardDeps(
		images: Record<string, Buffer | "throws"> = { [DY_REF]: PNG, [BILI_REF]: PNG },
	) {
		const generateRoastBoardCard = vi.fn(async (..._args: unknown[]) => Buffer.from("B"));
		const generateRoastSoloCard = vi.fn(async (..._args: unknown[]) => Buffer.from("S"));
		const profiles: Record<string, { name: string; avatar?: string; avatarUrl?: string }> = {
			"s-bili": { name: "B 站甲", avatarUrl: "https://i0.hdslb.com/a.jpg" },
			"s-bili-stored": {
				name: "B 站丙",
				avatar: BILI_REF,
				avatarUrl: "https://i0.hdslb.com/stored.jpg",
			},
			"s-dy": { name: "抖音乙", avatar: DY_REF },
		};
		const deps = {
			runtime: {
				pipeline: {
					extensionPlatformLabel: (id: string) => (id === "douyin" ? "抖音" : undefined),
					imageRenderer: { generateRoastBoardCard, generateRoastSoloCard },
				},
				serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
				subscriptionStateStore: { get: (id: string) => ({ cachedProfile: profiles[id] }) },
				sourceRegistry: {
					get: () => undefined,
					getRunView: (sourceKey: string) => ({
						sourceKey,
						status: "running",
						descriptor: {
							label: sourceKey,
							supportedFeatures: [],
							colorByExternalId: sourceKey === "bilibili",
						},
					}),
				},
				imageStore: {
					read: async (ref: string) => {
						const image = images[ref];
						if (image === "throws") throw new Error("盘挂了");
						return image ? { bytes: image, mime: "image/png" } : undefined;
					},
				},
			},
			store: {
				getGlobals: () => makeDefaultGlobalSettings(),
				getSubscriptions: () => [BILI, BILI_STORED, EXT, EXT_BARE],
			},
		} as unknown as RoastDeliverDeps;
		return { deps, generateRoastBoardCard, generateRoastSoloCard };
	}

	it.each([
		["s-bili", "s-bili-stored", [], "UP主"],
		["s-bili", "s-bili-stored", [{ subscriptionId: "s-dy", score: 50 }], "创作者"],
		["s-dy", "s-bare", [], "博主"],
		["s-bili", "deleted", [], "创作者"],
	])(
		"榜单按所有参与者选叫法,卡片与兜底文字一致 (%s/%s)",
		async (pigeon, diligent, scores, noun) => {
			const { deps, generateRoastBoardCard } = makeCardDeps();
			deps.runtime.sourceRegistry.get = (key) => ({
				sourceKey: key,
				descriptor: {
					label: key,
					creatorNoun: key === "bilibili" ? "UP主" : "博主",
					supportedFeatures: [],
				},
				searchCreators: async () => ok({ candidates: [] }),
				fetchProfile: async () => fail("unavailable", "fixture"),
			});
			const out = await buildRoastPayload(deps, {
				kind: "board",
				days: 7,
				result: {
					...BOARD,
					pushText: "",
					pigeon: { subscriptionId: pigeon, reason: "鸽" },
					diligent: { subscriptionId: diligent, reason: "勤" },
					scores,
				},
			});
			expect(out.text).toContain(`勤奋${noun}：`);
			expect(out.text).toContain(`${noun}周报`);
			expect(generateRoastBoardCard.mock.calls[0]?.[0]).toMatchObject({ creatorNoun: noun });
		},
	);

	it("单人锐评评的是拓展订阅:头像是内嵌图(不是面板的相对地址),名字与颜色跟面板一致", async () => {
		const { deps, generateRoastSoloCard } = makeCardDeps();
		const solo: SoloLike = {
			pushText: "",
			subscriptionId: "s-dy",
			verdict: "还行",
			score: 60,
			highlights: [],
		};
		const out = await buildRoastPayload(deps, { kind: "solo", result: solo, days: 7 });
		expect(out.mode).toBe("image");
		const up = (
			generateRoastSoloCard.mock.calls[0]?.[0] as { creator: Record<string, unknown> } | undefined
		)?.creator;
		expect(up?.avatar).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
		expect(up?.name).toBe("抖音乙");
		expect(up?.color).toBe(identityColor({ sourceKey: "douyin", externalId: "12345" }, undefined));
		// 兜底文案用的也是这个名字。
		expect(out.text).toContain("抖音乙");
	});

	it("B 站订阅的头像已在图库:和拓展一样读图库、内嵌成 data URL(不再交远端图链)", async () => {
		const { deps, generateRoastSoloCard } = makeCardDeps();
		await buildRoastPayload(deps, {
			kind: "solo",
			result: {
				pushText: "",
				subscriptionId: "s-bili-stored",
				verdict: "v",
				score: 1,
				highlights: [],
			},
			days: 7,
		});
		const up = (
			generateRoastSoloCard.mock.calls[0]?.[0] as { creator: Record<string, unknown> } | undefined
		)?.creator;
		expect(up?.avatar).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
	});

	it("榜单两支混着:B 站头像还没进图库时头像留空(不交远端图链);颜色 = identityColor(按人,外部 id 与 uid 同串也不同色)", async () => {
		const { deps, generateRoastBoardCard } = makeCardDeps();
		const board: BoardLike = {
			pushText: "x",
			pigeon: { subscriptionId: "s-dy", reason: "鸽" },
			diligent: { subscriptionId: "s-bili", reason: "勤" },
			roast: [{ subscriptionId: "s-bare", comment: "咕" }],
			scores: [
				{ subscriptionId: "s-bili", score: 90 },
				{ subscriptionId: "s-dy", score: 10 },
			],
		};
		await buildRoastPayload(deps, { kind: "board", result: board, days: 7 });
		const data = generateRoastBoardCard.mock.calls[0]?.[0] as Record<
			string,
			Record<string, unknown> & Array<Record<string, unknown>>
		>;
		expect(data.diligent).toHaveProperty("avatar", undefined);
		expect(data.diligent?.color).toBe(
			identityColor({ sourceKey: "bilibili", externalId: "12345" }, { colorByExternalId: true }),
		);
		expect(data.pigeon?.color).toBe(
			identityColor({ sourceKey: "douyin", externalId: "12345" }, undefined),
		);
		expect(data.pigeon?.color).not.toBe(data.diligent?.color);
		expect(String(data.pigeon?.avatar)).toMatch(/^data:image\/png;base64,/);
		// 没存头像、资料里也没名字的拓展那位:名字退身份标签,头像留空(卡上画首字母),不塞相对地址。
		expect(data.roast?.[0]).toMatchObject({ name: "抖音 · sec-bare", avatar: undefined });
	});

	it("资料里的引用指着的图已经不在了 → 头像留空,照样出卡", async () => {
		const { deps, generateRoastSoloCard } = makeCardDeps({});
		await buildRoastPayload(deps, {
			kind: "solo",
			result: { pushText: "", subscriptionId: "s-dy", verdict: "v", score: 1, highlights: [] },
			days: 7,
		});
		const up = (
			generateRoastSoloCard.mock.calls[0]?.[0] as { creator: Record<string, unknown> } | undefined
		)?.creator;
		expect(up?.name).toBe("抖音乙");
		expect(up?.avatar).toBeUndefined();
	});

	it("读图库抛了 → 头像留空,照样出卡(不因一张头像整张卡降级成文字)", async () => {
		const { deps, generateRoastSoloCard } = makeCardDeps({ [DY_REF]: "throws" });
		const out = await buildRoastPayload(deps, {
			kind: "solo",
			result: { pushText: "", subscriptionId: "s-dy", verdict: "v", score: 1, highlights: [] },
			days: 7,
		});
		expect(out.mode).toBe("image");
		const up = (
			generateRoastSoloCard.mock.calls[0]?.[0] as { creator: Record<string, unknown> } | undefined
		)?.creator;
		expect(up).toBeDefined();
		expect(up?.avatar).toBeUndefined();
	});
});
