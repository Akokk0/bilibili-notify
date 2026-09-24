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

import type { Connection, PushTarget } from "@bilibili-notify/internal";
import { makeDefaultGlobalConfig, upColor } from "@bilibili-notify/internal";
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
		platform: "onebot",
		kind: "session",
		address: "123",
	} as PushTarget;
}

function connection(id: string, enabled: boolean): Connection {
	return { id, name: "bot", enabled, platform: "onebot", config: {} } as unknown as Connection;
}

function makeDeps() {
	const sendToTarget = vi.fn(async (_id: string) => ({ ok: true, latencyMs: 1 }));
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const deps = {
		runtime: {
			engines: { imageRenderer: null, push: { sendToTarget } },
			serviceCtx: { logger },
			subRuntimeStore: { get: () => undefined },
		},
		store: {
			getGlobals: () => makeDefaultGlobalConfig(),
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
 * - 拓展的头像在资料里是面板的同源相对地址(`/api/subs/<id>/avatar?v=…`),截图的浏览器加载不到 —— 出卡前
 *   读存下的头像文件、转成内嵌图(同 ADR-0019 决策 68 那个坑)。B 站头像照旧是 CDN 图链。
 * - 颜色跟着人走,与面板同一个算法(`upColor`):B 站按 uid,拓展按「拓展 id:外部 id」。
 * - 名字:B 站照旧(资料里的名字 → UID xxx),拓展走卡片那条链(资料 → 别名 → 外部 id)。
 */
describe("buildRoastPayload — 卡上的人", () => {
	/** 最小的 PNG 文件头就够 `sniffImageFormat` 认出来。 */
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const BILI = { kind: "bilibili", id: "s-bili", uid: "12345", overrides: {} };
	const EXT = {
		kind: "extension",
		id: "s-dy",
		extensionId: "douyin",
		externalId: "12345",
		overrides: {},
	};
	const EXT_BARE = {
		kind: "extension",
		id: "s-bare",
		extensionId: "douyin",
		externalId: "sec-bare",
		name: "别名乙",
		overrides: {},
	};

	function makeCardDeps(avatars: Record<string, Buffer | "throws"> = { "s-dy": PNG }) {
		const generateRoastBoardCard = vi.fn(async (..._args: unknown[]) => Buffer.from("B"));
		const generateRoastSoloCard = vi.fn(async (..._args: unknown[]) => Buffer.from("S"));
		const profiles: Record<string, { name: string; avatar: string }> = {
			"s-bili": { name: "B 站甲", avatar: "https://i0.hdslb.com/a.jpg" },
			"s-dy": { name: "抖音乙", avatar: "/api/subs/s-dy/avatar?v=abc" },
		};
		const deps = {
			runtime: {
				engines: { imageRenderer: { generateRoastBoardCard, generateRoastSoloCard } },
				serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
				subRuntimeStore: { get: (id: string) => ({ cachedProfile: profiles[id] }) },
				subAvatarStore: {
					read: async (id: string) => {
						const a = avatars[id];
						if (a === "throws") throw new Error("盘挂了");
						return a ? { bytes: a, contentType: "image/png" } : undefined;
					},
				},
			},
			store: {
				getGlobals: () => makeDefaultGlobalConfig(),
				getSubscriptions: () => [BILI, EXT, EXT_BARE],
			},
		} as unknown as RoastDeliverDeps;
		return { deps, generateRoastBoardCard, generateRoastSoloCard };
	}

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
			generateRoastSoloCard.mock.calls[0]?.[0] as { up: Record<string, unknown> } | undefined
		)?.up;
		expect(up?.avatar).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
		expect(up?.name).toBe("抖音乙");
		expect(up?.color).toBe(upColor({ extensionId: "douyin", externalId: "12345" }));
		// 兜底文案用的也是这个名字。
		expect(out.text).toContain("抖音乙");
	});

	it("榜单两支混着:B 站头像照旧是图链;颜色 = upColor(按人,外部 id 与 uid 同串也不同色)", async () => {
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
		expect(data.diligent?.avatar).toBe("https://i0.hdslb.com/a.jpg");
		expect(data.diligent?.color).toBe(upColor({ uid: "12345" }));
		expect(data.pigeon?.color).toBe(upColor({ extensionId: "douyin", externalId: "12345" }));
		expect(data.pigeon?.color).not.toBe(data.diligent?.color);
		expect(String(data.pigeon?.avatar)).toMatch(/^data:image\/png;base64,/);
		// 没存头像、资料里也没名字的拓展那位:名字退主人起的别名,头像留空(卡上画首字母),不塞相对地址。
		expect(data.roast?.[0]).toMatchObject({ name: "别名乙", avatar: undefined });
	});

	it("读头像文件抛了 → 头像留空,照样出卡(不因一张头像整张卡降级成文字)", async () => {
		const { deps, generateRoastSoloCard } = makeCardDeps({ "s-dy": "throws" });
		const out = await buildRoastPayload(deps, {
			kind: "solo",
			result: { pushText: "", subscriptionId: "s-dy", verdict: "v", score: 1, highlights: [] },
			days: 7,
		});
		expect(out.mode).toBe("image");
		const up = (
			generateRoastSoloCard.mock.calls[0]?.[0] as { up: Record<string, unknown> } | undefined
		)?.up;
		expect(up).toBeDefined();
		expect(up?.avatar).toBeUndefined();
	});
});
