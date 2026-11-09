/**
 * `POST /api/targets/:id/test` —— 试一次、回报结果(目标 id 在路径里,ADR-0036;此前在 push 路由的请求体里,叫 `targetId`)。
 *
 * 投递的结果(送达 / 没送达)都回 200,体是 `Result<{ latencyMs }>`;请求本身不成才是非 2xx 的错误体。
 * 这条路由此前没有测试走到,它的旧形状不在守卫的白名单里 —— 这里补上。
 */

import { fail } from "@bilibili-notify/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { i18n } from "../../i18n/index.js";
import { createTargetsRoute } from "../targets.js";
import type { RouteDeps } from "../types.js";

const TARGET_ID = "33333333-3333-4333-8333-333333333333";
beforeEach(() => i18n.set({ locale: "zh-CN", voice: "maid" }));

function makeApp(opts: { pipeline?: boolean; targets?: unknown[]; sendToTarget?: unknown } = {}) {
	const sendToTarget = vi.fn(async () => opts.sendToTarget ?? { ok: true, latencyMs: 7 });
	const app = createTargetsRoute({
		runtime: {
			pipeline: opts.pipeline === false ? null : { push: { sendToTarget } },
			serviceCtx: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
		},
		store: { getTargets: () => opts.targets ?? [{ id: TARGET_ID }] },
	} as unknown as RouteDeps);
	return { app, sendToTarget };
}

/** 打 `POST /:id/test`。`body` 缺省就是整个体都不带。 */
function post(
	app: ReturnType<typeof makeApp>["app"],
	body?: unknown,
	id: string = TARGET_ID,
): Promise<Response> {
	return Promise.resolve(
		app.request(`/${id}/test`, {
			method: "POST",
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: typeof body === "string" ? body : JSON.stringify(body),
					}),
		}),
	);
}

describe("POST /api/targets/:id/test 请求级失败(非 2xx 的错误体)", () => {
	it.each([
		["en", "The service is not ready. Try again later."],
		["ja", "サービスの準備ができていません。しばらくしてから再試行してください。"],
		["zh-TW", "服務尚未準備就緒，請稍後再試。"],
	] as const)(
		"%s reports an unready pipeline without attempting delivery",
		async (locale, message) => {
			const { app, sendToTarget } = makeApp({ pipeline: false });
			i18n.set({ locale, voice: "plain" });
			const res = await post(app);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ code: "unavailable", message });
			expect(sendToTarget).not.toHaveBeenCalled();
		},
	);
	it("体不对 → 400 invalid,逐格原因进 issues,不会去发", async () => {
		const { app, sendToTarget } = makeApp();
		const res = await post(app, { kind: "nope" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string; issues: unknown[] };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain("kind");
		expect(body.issues).toEqual([expect.objectContaining({ path: ["kind"] })]);
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("路径里的 id 不是 uuid → 400 invalid(与从前体里的 targetId 同一道),不会去发", async () => {
		const { app, sendToTarget } = makeApp();
		const res = await post(app, {}, "not-a-uuid");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
		expect(sendToTarget).not.toHaveBeenCalled();
	});

	it("体不是 JSON → 同样 400 invalid", async () => {
		const { app } = makeApp();
		const res = await post(app, "{oops");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
	});

	it("推送链路还没起 → 503 unavailable", async () => {
		const { app } = makeApp({ pipeline: false });
		const res = await post(app);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({
			code: "unavailable",
			message: "服务还没准备好，请稍后重试",
		});
	});

	it("没这个目标 → 404 not_found,且不会去发", async () => {
		const { app, sendToTarget } = makeApp({ targets: [] });
		const res = await post(app);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ code: "not_found", message: "没有这个推送目标" });
		expect(sendToTarget).not.toHaveBeenCalled();
	});
});

describe("POST /api/targets/:id/test 投递的结果(照旧回 200,体是 Result)", () => {
	it("送达 → 200 { ok: true, latencyMs },发的是文字载荷", async () => {
		const { app, sendToTarget } = makeApp({ sendToTarget: { ok: true, latencyMs: 42 } });
		const res = await post(app, { kind: "superchat" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, latencyMs: 42 });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, {
			kind: "text",
			text: expect.stringContaining("SC"),
		});
	});

	it("没送达 → 200 { ok: false, code, message },没有假的 latencyMs", async () => {
		const { app } = makeApp({ sendToTarget: fail("unavailable", "群不存在") });
		const res = await post(app);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: false, code: "unavailable", message: "群不存在" });
		expect(body).not.toHaveProperty("latencyMs");
	});

	it("kind 用特性键:liveStart / post / superchat / membership 各发各的样板句", async () => {
		const expected = {
			liveStart: "直播开播",
			post: "作品",
			superchat: "SC",
			membership: "会员",
		} as const;
		for (const [kind, word] of Object.entries(expected)) {
			const { app, sendToTarget } = makeApp();
			const res = await post(app, { kind });
			expect(res.status, kind).toBe(200);
			expect(sendToTarget, kind).toHaveBeenCalledWith(TARGET_ID, {
				kind: "text",
				text: expect.stringContaining(word),
			});
		}
	});

	it("老的种类名(live / dyn / sc / guard)不再收 → 400 invalid,不会去发", async () => {
		for (const kind of ["live", "dyn", "sc", "guard"]) {
			const { app, sendToTarget } = makeApp();
			const res = await post(app, { kind });
			expect(res.status, kind).toBe(400);
			expect(await res.json(), kind).toMatchObject({ code: "invalid" });
			expect(sendToTarget, kind).not.toHaveBeenCalled();
		}
	});

	it("整个体都不带 → 按缺省的 text 种类发,不是 400", async () => {
		const { app, sendToTarget } = makeApp();
		const res = await post(app);
		expect(res.status).toBe(200);
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, {
			kind: "text",
			text: "[bilibili-notify] 测试推送已送达 ✓",
		});
	});

	it("请求体里多带的 targetId 不再有人认:要测的是路径里那个", async () => {
		const { app, sendToTarget } = makeApp();
		await post(app, { targetId: "44444444-4444-4444-8444-444444444444" });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, expect.anything());
	});

	it("自带的文字优先于 kind 的预设", async () => {
		const { app, sendToTarget } = makeApp();
		await post(app, { text: "你好" });
		expect(sendToTarget).toHaveBeenCalledWith(TARGET_ID, { kind: "text", text: "你好" });
	});
});

it("test message samples follow the active language at send time and preserve supplied text", async () => {
	const previous = i18n.state();
	const { app, sendToTarget } = makeApp();
	try {
		const samples = [
			[
				"en",
				[
					"[bilibili-notify] Test push delivered ✓",
					"[Test push · Live started] Example creator is live! Title: Test stream",
					"[Test push · Post] Example creator published a test post",
					"[Test push · SC] ¥30 from Test user — Keep it up!",
					"[Test push · Membership] Example user joined the example membership tier!",
				],
			],
			[
				"ja",
				[
					"[bilibili-notify] テスト通知が届きました ✓",
					"[テスト通知 · 配信開始] サンプル作者が配信を開始しました！タイトル: テスト配信",
					"[テスト通知 · 投稿] サンプル作者がテスト投稿を公開しました",
					"[テスト通知 · SC] テストユーザーから ¥30 — 応援しています！",
					"[テスト通知 · メンバーシップ] サンプルユーザーがサンプルのメンバーシップに加入しました！",
				],
			],
			[
				"zh-TW",
				[
					"[bilibili-notify] 測試推播已送達 ✓",
					"[測試推播 · 開始直播] 範例創作者開始直播了！標題：測試直播",
					"[測試推播 · 作品] 範例創作者發布了一則測試作品",
					"[測試推播 · SC] 測試使用者贊助 ¥30 — 主播加油！",
					"[測試推播 · 會員] 範例使用者加入了範例會員等級！",
				],
			],
		] as const;
		for (const [locale, expected] of samples) {
			i18n.set({ locale, voice: "plain" });
			const kinds = ["text", "liveStart", "post", "superchat", "membership"] as const;
			for (const [index, kind] of kinds.entries()) {
				const res = await post(app, kind === "text" ? undefined : { kind });
				expect(res.status).toBe(200);
				expect(await res.json()).toEqual({ ok: true, latencyMs: 7 });
				expect(sendToTarget).toHaveBeenLastCalledWith(TARGET_ID, {
					kind: "text",
					text: expected[index],
				});
			}
			await post(app, { text: "原始消息 그대로" });
			expect(sendToTarget).toHaveBeenLastCalledWith(TARGET_ID, {
				kind: "text",
				text: "原始消息 그대로",
			});
		}
		expect(sendToTarget).toHaveBeenCalledTimes(18);
	} finally {
		i18n.set(previous);
	}
});
