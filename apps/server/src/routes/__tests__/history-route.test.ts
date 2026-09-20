/**
 * 单元测试 — history 路由的 limit/since 输入校验(P2-J)。
 *
 * 报告 #P2:`limit=Number("abc")` → NaN 经 Math.min/max 透传成 limit=NaN
 * 静默喂给 query();`since` 非 ISO 直接透传致静默 no-op / 错误过滤。修复后
 * 非法 limit / since 显式 400,而非静默坏行为。
 *
 * 末尾还有 `POST /:id/repush`(ADR-0017):这一层只管**接住请求、把结果翻成状态码**,
 * 判断全在 `RepushRunner` 里(它自己有一整份测试)。三个码各有各的意思:
 * **202** 收下了、女仆去补(不是 200 —— 消息还没发出去,`sendToTarget` 光退避就可能
 * 走 190s);**404** 没这一行;**409** 有这一行但现在不能补(全送到了 / 路由改了 /
 * 目标停用 / 正在补 / 原件没了),理由原样交给面板显示。
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHistoryRoute } from "../history.js";
import type { RouteDeps } from "../types.js";

let query: ReturnType<typeof vi.fn>;
let aggregateDaily: ReturnType<typeof vi.fn>;
let startRepush: ReturnType<typeof vi.fn>;
let canRepush: ReturnType<typeof vi.fn>;
/** `canRepush` 回什么:`null` = 能补,字符串 = 不能补的理由。 */
let canRepushResult: string | null = null;

function makeApp(repushResult: unknown = { ok: true, count: 2 }) {
	query = vi.fn(async () => []);
	aggregateDaily = vi.fn(async () => []);
	startRepush = vi.fn(async () => repushResult);
	canRepush = vi.fn(async () => canRepushResult);
	const deps = {
		runtime: {
			historyStore: { query, aggregateDaily, imageDir: () => join(tmpdir(), "bn-history-test") },
			repushRunner: { start: startRepush, canRepush, isRunning: () => false },
		},
	} as unknown as RouteDeps;
	return createHistoryRoute(deps);
}

const ROW = "11111111-1111-4111-8111-111111111111";
const TS = "2026-09-20T08:00:00.000Z";

function repush(app: ReturnType<typeof makeApp>, body: unknown) {
	return app.request(`/${ROW}/repush`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("history route — limit/since 校验 (P2-J)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("limit 非数字 → 400,不调用 query", async () => {
		const res = await makeApp().request("/?limit=abc");
		expect(res.status).toBe(400);
		expect(query).not.toHaveBeenCalled();
	});

	it("since 非 ISO → 400,不调用 query", async () => {
		const res = await makeApp().request("/?since=notadate");
		expect(res.status).toBe(400);
		expect(query).not.toHaveBeenCalled();
	});

	it("合法 limit → 200,query 收到 clamp 后的 limit", async () => {
		const res = await makeApp().request("/?limit=50");
		expect(res.status).toBe(200);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 50 });
	});

	it("limit 越界 → clamp 到 [1,500](500 上限)", async () => {
		await makeApp().request("/?limit=9999");
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 500 });
	});

	it("合法 ISO since → 200 透传", async () => {
		const since = "2026-01-01T00:00:00.000Z";
		const res = await makeApp().request(`/?since=${encodeURIComponent(since)}`);
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ since });
	});

	it("无任何 query 参数 → 200,默认 limit=100", async () => {
		const res = await makeApp().request("/");
		expect(res.status).toBe(200);
		expect(query.mock.calls[0]?.[0]).toMatchObject({ limit: 100 });
	});
});

describe("history route — kind 过滤与 view 投影", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("kind 合法 → 透传给 query;不认识的 kind 当没传", async () => {
		const app = makeApp();
		await app.request("/?kind=live-end");
		expect(query.mock.calls[0]?.[0]).toMatchObject({ kind: "live-end" });
		await app.request("/?kind=live-summary");
		expect(query.mock.calls[1]?.[0]).not.toHaveProperty("kind", "live-summary");
		expect(query.mock.calls[1]?.[0].kind).toBeUndefined();
	});

	it("entries 投影成 wire view:消息逐条、无目标行 targetId 为 null", async () => {
		const app = makeApp();
		query.mockResolvedValueOnce([
			{
				id: "h1",
				pushId: "p1",
				ts: "2026-05-16T00:00:00.000Z",
				kind: "dynamic",
				uid: "u1",
				subscriptionId: "sub1",
				targetId: null,
				status: "no-targets",
				messages: [{ payload: { kind: "text", text: "卡片" }, role: "main" }],
				unameSnapshot: "UP",
			},
		]);
		const res = await app.request("/");
		expect(await res.json()).toEqual({
			entries: [
				{
					id: "h1",
					pushId: "p1",
					ts: "2026-05-16T00:00:00.000Z",
					kind: "dynamic",
					status: "no-targets",
					uid: "u1",
					subscriptionId: "sub1",
					targetId: null,
					messages: [{ text: "卡片", role: "main" }],
					unameSnapshot: "UP",
				},
			],
		});
	});
});

describe("history /daily — 按日聚合(本周推送趋势数据源)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("透传 clamp 后的 days/tzOffset,响应 { days }", async () => {
		const app = makeApp();
		const res = await app.request("/daily?days=7&tzOffset=-480");
		expect(res.status).toBe(200);
		expect(aggregateDaily).toHaveBeenCalledTimes(1);
		expect(aggregateDaily.mock.calls[0]?.[0]).toMatchObject({ days: 7, tzOffsetMin: -480 });
		expect(await res.json()).toEqual({ days: [] });
	});

	it("无参数 → 默认 days=7, tzOffsetMin=0", async () => {
		await makeApp().request("/daily");
		expect(aggregateDaily.mock.calls[0]?.[0]).toMatchObject({ days: 7, tzOffsetMin: 0 });
	});

	it("days/tzOffset 越界 → clamp 到 [1,90] / [-840,840]", async () => {
		const app = makeApp();
		await app.request("/daily?days=9999&tzOffset=99999");
		expect(aggregateDaily.mock.calls[0]?.[0]).toMatchObject({ days: 90, tzOffsetMin: 840 });
		await app.request("/daily?days=0&tzOffset=-99999");
		expect(aggregateDaily.mock.calls[1]?.[0]).toMatchObject({ days: 1, tzOffsetMin: -840 });
	});

	it("days / tzOffset 非数字 → 400,不调用 aggregateDaily", async () => {
		const app = makeApp();
		expect((await app.request("/daily?days=abc")).status).toBe(400);
		expect((await app.request("/daily?tzOffset=abc")).status).toBe(400);
		expect(aggregateDaily).not.toHaveBeenCalled();
	});
});

describe("history route — POST /:id/repush", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * 🔴 **202,不是 200。** 回来的时候消息一条都还没发出去 —— `sendToTarget` 光退避
	 * 就可能走满 190s,一行补几条就是几倍。面板据此说「女仆去补了」而不是「补好了」,
	 * 真正的结果随后经 `history-updated` 一条条回来。
	 */
	it("收下了 → 202,带这一趟要补几条", async () => {
		const res = await repush(makeApp(), { ts: TS, mode: "missing" });
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ ok: true, count: 2 });
		expect(startRepush).toHaveBeenCalledWith(ROW, TS, "missing");
	});

	it("mode: all 照样透传", async () => {
		await repush(makeApp(), { ts: TS, mode: "all" });
		expect(startRepush).toHaveBeenCalledWith(ROW, TS, "all");
	});

	it("没这一行 → 404", async () => {
		const res = await repush(makeApp({ ok: false, notFound: true, reason: "找不到" }), {
			ts: TS,
			mode: "missing",
		});
		expect(res.status).toBe(404);
	});

	/** 拒绝的理由**原样**交给面板 —— 自编一句「重推失败」等于让主人对着黑盒猜。 */
	it("有这一行但不能补 → 409,理由原样带回去", async () => {
		const res = await repush(
			makeApp({ ok: false, reason: "这个目标（或者它所在的连接）停用了，先启用再补" }),
			{ ts: TS, mode: "missing" },
		);
		expect(res.status).toBe(409);
		expect((await res.json()) as { err?: string }).toEqual({
			ok: false,
			err: "这个目标（或者它所在的连接）停用了，先启用再补",
		});
	});

	it.each([
		["mode 不认识", { ts: TS, mode: "everything" }],
		["ts 不是时间", { ts: "notadate", mode: "missing" }],
		["少了 ts", { mode: "missing" }],
		["空 body", null],
	])("%s → 400,一条都不发", async (_name, body) => {
		const app = makeApp();
		const res = await repush(app, body);
		expect(res.status).toBe(400);
		expect(startRepush).not.toHaveBeenCalled();
	});
});

/**
 * **按钮该不该灰,列表里就告诉面板**(ADR-0017 决策 9)。
 *
 * 只为失败 / 部分失败的行问 —— 一页两百行里失败的通常是个位数,而每问一次是一次
 * `stat`。已送达与无目标的行不问也不带:它们本来就没有按钮。
 *
 * WS 推来的新行**刻意不带**这个字段(投影在另一层,拿不到 runner)。面板对缺省按
 * 「能补」处理,而那恰好总是对的:一条刚刚失败的推送,它的原件必然还在。
 */
describe("history route — 列表带上「能不能补」", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		canRepushResult = null;
	});

	function rows(...statuses: string[]) {
		return statuses.map((status, i) => ({
			id: `id${i}`,
			pushId: "p",
			ts: TS,
			kind: "dynamic",
			uid: "u1",
			subscriptionId: "s",
			targetId: status === "no-targets" ? null : "t",
			status,
			messages: [],
		}));
	}

	it("失败行带 repush(能补时是 null),别的行不带也不问", async () => {
		const app = makeApp();
		query.mockImplementation(async () => rows("failed", "partial", "delivered", "no-targets"));
		const body = (await (await app.request("/")).json()) as {
			entries: Array<{ status: string; repush?: unknown }>;
		};
		expect(body.entries.map((e) => "repush" in e)).toEqual([true, true, false, false]);
		expect(body.entries[0]?.repush).toEqual({ can: true, total: 0, missing: 0 });
		expect(canRepush).toHaveBeenCalledTimes(2);
	});

	it("不能补时带回那句原因", async () => {
		const app = makeApp();
		canRepushResult = "这个目标（或者它所在的连接）停用了，先启用再补";
		query.mockImplementation(async () => rows("failed"));
		const body = (await (await app.request("/")).json()) as {
			entries: Array<{ repush?: unknown }>;
		};
		expect(body.entries[0]?.repush).toEqual({
			can: false,
			reason: "这个目标（或者它所在的连接）停用了，先启用再补",
		});
	});
});
