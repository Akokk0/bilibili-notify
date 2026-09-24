/**
 * 单元测试 — `POST /api/stats/roast/push`(把锐评推到一个推送目标)。
 *
 * 这条路由的核心契约是**降级**:图片推不出去时必须退成文字送达,而不是整条失败。
 * 一份已经生成好的周报,不该因为服务器上没装 Chrome 就发不出去。
 *
 * 另一条是**不信前端**:名称 / 头像 / 配色一律服务端按订阅 id 自己 join,请求体里
 * 只有订阅 id 说了算(ADR-0020 决策 18:两支订阅混着,uid 不再是回指的键)。
 */

// biome-ignore-all lint/suspicious/noExplicitAny: 断言 JSON 响应体,不为测试再造一遍 wire 类型
import { describe, expect, it, vi } from "vite-plus/test";
import { createStatsRoute } from "../stats.js";
import type { RouteDeps } from "../types.js";

const BOARD = {
	pigeon: { subscriptionId: "s200", reason: "一个月就发一条" },
	diligent: { subscriptionId: "s100", reason: "更新最勤" },
	roast: [{ subscriptionId: "s200", comment: "鸽子精本精" }],
	scores: [
		{ subscriptionId: "s100", score: 96 },
		{ subscriptionId: "s200", score: 41 },
	],
	pushText: "本周鸽王诞生 🕊️",
};

const SOLO = {
	subscriptionId: "s200",
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
	targets?: Array<{ id: string; enabled?: boolean; connectionId?: string }>;
	/** 全局在用的卡片皮肤。 */
	cardSkin?: string;
}

const ADAPTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeDeps(opts: StubOpts = {}) {
	const sendToTarget = vi.fn(async () => ({
		ok: !opts.sendFails,
		latencyMs: 1,
		err: opts.sendFails ? "目标不可达" : undefined,
	}));
	// 变参签名照抄真身:写成零参的话 `mock.calls[0][1]` 在类型上是「长度 0 的元组」,
	// 断言第二个参数(皮肤 id)根本编译不过。
	const generateRoastBoardCard = vi.fn(async (..._args: unknown[]) => {
		if (opts.renderThrows) throw new Error("Chrome 崩了");
		return Buffer.from("BOARD-PNG");
	});
	const generateRoastSoloCard = vi.fn(async (..._args: unknown[]) => {
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
				{ kind: "bilibili", id: "s100", uid: "100" },
				{ kind: "bilibili", id: "s200", uid: "200" },
			],
			getGlobals: () => ({
				defaults: {
					ai: { enabled: true },
					cardStyle: { enabled: opts.cardStyleEnabled ?? true },
					cardSkin: opts.cardSkin ?? "default",
				},
			}),
			// 投递前会看目标与连接是不是停用了(停用 = 跳过),所以夹具里的目标得像真的一样
			// 带着 enabled 与 connectionId,不然全被当成停用、一条都发不出去。
			getTargets: () =>
				(opts.targets ?? [{ id: "11111111-1111-4111-8111-111111111111" }]).map((t) => ({
					enabled: true,
					connectionId: ADAPTER,
					...t,
				})),
			getConnections: () => [{ id: ADAPTER, enabled: true }],
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
	it("targetId 不是 uuid → 400,与 /api/push、/api/cards、/api/ai 同一把尺子", async () => {
		// PushTarget.id 本来就是 z.uuid();这里曾是 z.string().min(1),于是同一个
		// 「目标 id」在四个端点上有两套校验,松的那个把错 id 一路带到投递层才失败。
		const { deps, sendToTarget } = makeDeps();
		const res = await push(createStatsRoute(deps), boardBody({ targetId: "not-a-uuid" }));

		expect(res.status).toBe(400);
		expect(sendToTarget).not.toHaveBeenCalled();
	});

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

	// 锐评卡与词云卡同源:不属于任何单个 UP,吃全局那套皮肤(ADR-0014 决策 3)。
	// 不传的话渲染器退回内置默认皮肤,主人换了皮肤只有周报卡还是老样子。
	it("榜单与单人锐评都带上全局在用的那套皮肤", async () => {
		const { deps, generateRoastBoardCard, generateRoastSoloCard } = makeDeps({
			cardSkin: "k3ccc-beefbeef",
		});
		const app = createStatsRoute(deps);
		await push(app, { targetId: TARGET, kind: "board", days: 7, result: BOARD });
		await push(app, { targetId: TARGET, kind: "solo", days: 7, result: SOLO });
		// 验红:把 roast-deliver.ts 里那两个 `{ cardSkin }` 删掉,这两条红。
		expect(generateRoastBoardCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "k3ccc-beefbeef" });
		expect(generateRoastSoloCard.mock.calls[0]?.[1]).toEqual({ cardSkin: "k3ccc-beefbeef" });
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
		// 兜底文本必须是**名字**,不是 id —— 群友不认识 id。
		expect(text).toContain("机智的党妹");
		expect(text).toContain("老番茄");
		expect(text).not.toContain("s200");
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
	it("卡片拿到的是订阅里的名字与头像,请求体里只有订阅 id 说了算", async () => {
		const { deps, generateRoastBoardCard } = makeDeps();
		await push(createStatsRoute(deps), boardBody());

		const data = (generateRoastBoardCard.mock.calls[0] as any)[0];
		expect(data.pigeon.name).toBe("机智的党妹");
		expect(data.pigeon.avatar).toBe("https://i0.hdslb.com/dangmei.jpg");
		expect(data.diligent.name).toBe("老番茄");
		expect(data.days).toBe(30);
		// 颜色来自 upColor —— 与 dashboard 上同一位 UP 的颜色一致。
		expect(data.pigeon.color).toMatch(/^#[0-9a-f]{6}$/i);
		expect(data.pigeon.color).not.toBe(data.diligent.color);
	});

	it("订阅 id 对不上任何订阅 → 写「未知 UP」,而不是渲染出一张空名字的卡", async () => {
		const { deps, generateRoastBoardCard } = makeDeps();
		await push(
			createStatsRoute(deps),
			boardBody({ result: { ...BOARD, pigeon: { subscriptionId: "gone", reason: "查无此人" } } }),
		);
		expect((generateRoastBoardCard.mock.calls[0] as any)[0].pigeon.name).toBe("未知 UP");
	});

	it("请求体还按 uid 回指(旧页面)→ 400,不拿一个认不出的键去出卡", async () => {
		const { deps, sendToTarget } = makeDeps();
		const legacy = {
			...BOARD,
			pigeon: { uid: "200", reason: "鸽" },
			diligent: { uid: "100", reason: "勤" },
		};
		const res = await push(createStatsRoute(deps), boardBody({ result: legacy }));
		expect(res.status).toBe(400);
		const solo = await push(createStatsRoute(deps), {
			targetId: TARGET,
			days: 7,
			kind: "solo",
			result: { uid: "200", verdict: "v", score: 1 },
		});
		expect(solo.status).toBe(400);
		expect(sendToTarget).not.toHaveBeenCalled();
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

describe("POST /roast/push — 停用的目标", () => {
	// 「停用」在周报与链接解析里是同一个意思:目标暂停,勾着也不发。手动推送选中一个停用的
	// 目标,得明说是停用,不能是一句含糊的「推送失败」—— 那会让人去查网络。
	it("目标已停用 → 409 + 明说已停用,不碰推送管线", async () => {
		const { deps, sendToTarget } = makeDeps({ targets: [{ id: TARGET, enabled: false }] });
		const res = await push(createStatsRoute(deps), boardBody());
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).err).toBe("推送目标已停用");
		expect(sendToTarget).not.toHaveBeenCalled();
	});
});
