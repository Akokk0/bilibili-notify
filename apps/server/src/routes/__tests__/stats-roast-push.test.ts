/**
 * 单元测试 — `POST /api/stats/roast/push`(把锐评推到一个推送目标)。
 *
 * 这条路由的核心契约是**降级**:图片推不出去时必须退成文字送达,而不是整条失败。
 * 一份已经生成好的周报,不该因为服务器上没装 Chrome 就发不出去。
 *
 * 另一条是**不信前端**:名称 / 头像 / 配色一律服务端按 uid 自己 join,请求体里
 * 只有 uid 说了算。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型
import { describe, expect, it, vi } from "vite-plus/test";
import { createStatsRoute } from "../stats.js";
import type { RouteDeps } from "../types.js";

const BOARD = {
	pigeon: { uid: "200", reason: "一个月就发一条" },
	diligent: { uid: "100", reason: "更新最勤" },
	roast: [{ uid: "200", comment: "鸽子精本精" }],
	scores: [
		{ uid: "100", score: 96 },
		{ uid: "200", score: 41 },
	],
	pushText: "本周鸽王诞生 🕊️",
};

const SOLO = {
	uid: "200",
	verdict: "一个月就发一条",
	score: 32,
	highlights: [{ label: "涨粉", comment: "掉了两万" }],
	pushText: "党妹本月鸽了 🕊️",
};

interface StubOpts {
	/** 有没有 puppeteer(未装 Chrome 时为 null)。 */
	renderer?: boolean;
	/** 全局图片渲染总开关。 */
	cardStyleEnabled?: boolean;
	/** 让渲染抛错,验降级。 */
	renderThrows?: boolean;
	/** 让投递失败。 */
	sendFails?: boolean;
	targets?: Array<{ id: string }>;
}

function makeDeps(opts: StubOpts = {}) {
	const sendToTarget = vi.fn(async () => ({
		ok: !opts.sendFails,
		latencyMs: 1,
		err: opts.sendFails ? "目标不可达" : undefined,
	}));
	const generateRoastBoardCard = vi.fn(async () => {
		if (opts.renderThrows) throw new Error("Chrome 崩了");
		return Buffer.from("BOARD-PNG");
	});
	const generateRoastSoloCard = vi.fn(async () => {
		if (opts.renderThrows) throw new Error("Chrome 崩了");
		return Buffer.from("SOLO-PNG");
	});

	const profiles: Record<string, { name: string; avatar: string }> = {
		s100: { name: "老番茄", avatar: "https://i0.hdslb.com/tomato.jpg" },
		s200: { name: "机智的党妹", avatar: "https://i0.hdslb.com/dangmei.jpg" },
	};

	const deps = {
		store: {
			getSubscriptions: () => [
				{ id: "s100", uid: "100" },
				{ id: "s200", uid: "200" },
			],
			getGlobals: () => ({
				defaults: {
					ai: { enabled: true },
					cardStyle: { enabled: opts.cardStyleEnabled ?? true },
				},
			}),
			getTargets: () => opts.targets ?? [{ id: "11111111-1111-4111-8111-111111111111" }],
		},
		runtime: {
			engines: {
				push: { sendToTarget },
				imageRenderer:
					opts.renderer === false ? null : { generateRoastBoardCard, generateRoastSoloCard },
			},
			subRuntimeStore: { get: (id: string) => ({ cachedProfile: profiles[id] }) },
			serviceCtx: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
		},
	} as unknown as RouteDeps;

	return { deps, sendToTarget, generateRoastBoardCard, generateRoastSoloCard };
}

const TARGET = "11111111-1111-4111-8111-111111111111";

function push(app: ReturnType<typeof createStatsRoute>, body: unknown) {
	return app.request("/roast/push", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const boardBody = (over: Record<string, unknown> = {}) => ({
	targetId: TARGET,
	days: 30,
	kind: "board",
	result: BOARD,
	...over,
});

describe("POST /roast/push — 图片优先", () => {
	it("图片渲染开着时推图片,并把周报文本一起带上作图说明", async () => {
		// caption 不是可有可无的装饰:图挂了 / 客户端不展图时,那段文字是唯一还能读的东西。
		const { deps, sendToTarget } = makeDeps();
		const res = await push(createStatsRoute(deps), boardBody());

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).mode).toBe("image");
		const [targetId, payload] = sendToTarget.mock.calls[0] as any;
		expect(targetId).toBe(TARGET);
		expect(payload.kind).toBe("image");
		expect(payload.image.buffer.toString()).toBe("BOARD-PNG");
		expect(payload.caption).toBe("本周鸽王诞生 🕊️");
	});

	it("单人锐评走单人卡,不是榜单卡", async () => {
		const { deps, generateRoastBoardCard, generateRoastSoloCard } = makeDeps();
		await push(createStatsRoute(deps), {
			targetId: TARGET,
			days: 7,
			kind: "solo",
			result: SOLO,
		});
		expect(generateRoastSoloCard).toHaveBeenCalled();
		expect(generateRoastBoardCard).not.toHaveBeenCalled();
	});
});

describe("POST /roast/push — 降级成文字", () => {
	it("关掉图片渲染总开关 → 推文字", async () => {
		const { deps, sendToTarget, generateRoastBoardCard } = makeDeps({ cardStyleEnabled: false });
		const res = await push(createStatsRoute(deps), boardBody());

		expect(((await res.json()) as any).mode).toBe("text");
		expect(generateRoastBoardCard).not.toHaveBeenCalled();
		expect((sendToTarget.mock.calls[0] as any)[1]).toEqual({
			kind: "text",
			text: "本周鸽王诞生 🕊️",
		});
	});

	it("没装 Chrome(没有渲染器)→ 推文字,而不是报错", async () => {
		const { deps, sendToTarget } = makeDeps({ renderer: false });
		const res = await push(createStatsRoute(deps), boardBody());

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).mode).toBe("text");
		expect((sendToTarget.mock.calls[0] as any)[1].kind).toBe("text");
	});

	it("渲染中途炸了 → 仍然把文字发出去", async () => {
		// 一份已经生成好的周报,不该因为 Chrome 崩了就彻底发不出去。
		const { deps, sendToTarget } = makeDeps({ renderThrows: true });
		const res = await push(createStatsRoute(deps), boardBody());

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).mode).toBe("text");
		expect((sendToTarget.mock.calls[0] as any)[1].kind).toBe("text");
	});

	it("模型没给周报文本时用结构化数据兜底,绝不推一条空消息", async () => {
		const { deps, sendToTarget } = makeDeps({ cardStyleEnabled: false });
		await push(createStatsRoute(deps), boardBody({ result: { ...BOARD, pushText: "" } }));

		const text = (sendToTarget.mock.calls[0] as any)[1].text as string;
		expect(text.length).toBeGreaterThan(0);
		// 兜底文本必须是**名字**,不是 uid —— 群友不认识 uid。
		expect(text).toContain("机智的党妹");
		expect(text).toContain("老番茄");
		expect(text).not.toContain("200");
	});

	it("单人锐评的兜底文本也走名字", async () => {
		const { deps, sendToTarget } = makeDeps({ cardStyleEnabled: false });
		await push(createStatsRoute(deps), {
			targetId: TARGET,
			days: 7,
			kind: "solo",
			result: { ...SOLO, pushText: "" },
		});
		const text = (sendToTarget.mock.calls[0] as any)[1].text as string;
		expect(text).toContain("机智的党妹");
		expect(text).toContain("一个月就发一条");
	});
});

describe("POST /roast/push — 名称与配色由服务端 join", () => {
	it("卡片拿到的是订阅里的名字与头像,请求体里只有 uid 说了算", async () => {
		const { deps, generateRoastBoardCard } = makeDeps();
		await push(createStatsRoute(deps), boardBody());

		const data = (generateRoastBoardCard.mock.calls[0] as any)[0];
		expect(data.pigeon.name).toBe("机智的党妹");
		expect(data.pigeon.avatar).toBe("https://i0.hdslb.com/dangmei.jpg");
		expect(data.diligent.name).toBe("老番茄");
		expect(data.days).toBe(30);
		// 颜色来自 colorFromUid —— 与 dashboard 上同一位 UP 的颜色一致。
		expect(data.pigeon.color).toMatch(/^#[0-9a-f]{6}$/i);
		expect(data.pigeon.color).not.toBe(data.diligent.color);
	});

	it("uid 不在订阅里 → 退回 `UID xxx`,而不是渲染出一张空名字的卡", async () => {
		const { deps, generateRoastBoardCard } = makeDeps();
		await push(
			createStatsRoute(deps),
			boardBody({ result: { ...BOARD, pigeon: { uid: "999", reason: "查无此人" } } }),
		);
		expect((generateRoastBoardCard.mock.calls[0] as any)[0].pigeon.name).toBe("UID 999");
	});
});

describe("POST /roast/push — 诚实失败", () => {
	it("推送目标不存在 → 404", async () => {
		const { deps } = makeDeps({ targets: [] });
		const res = await push(createStatsRoute(deps), boardBody());
		expect(res.status).toBe(404);
		expect(((await res.json()) as any).ok).toBe(false);
	});

	it("请求体缺字段 → 400,不带着半截数据去渲染", async () => {
		const { deps, generateRoastBoardCard } = makeDeps();
		const res = await push(createStatsRoute(deps), { targetId: TARGET, kind: "board" });
		expect(res.status).toBe(400);
		expect(generateRoastBoardCard).not.toHaveBeenCalled();
	});

	it("投递失败 → ok:false 并带上原因,不谎报成功", async () => {
		const { deps } = makeDeps({ sendFails: true });
		const res = await push(createStatsRoute(deps), boardBody());
		const body = (await res.json()) as any;
		expect(body.ok).toBe(false);
		expect(body.err).toContain("目标不可达");
	});
});
