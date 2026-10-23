/**
 * 单元测试 — `/api/sources/:sourceKey/auth` 来源登录的三个口。
 *
 * 路由层:手写的假来源登进**真登记表**(视图摘 start / stop 那一步不绕开),逐个码对状态码。
 * 「拒绝重复发起」只在 `awaiting-scan` 时拦、`confirming` 放行,各有一条:`confirming` 同时表示
 * 「开机还没确认」,那时必须能发起扫码。
 */
import {
	type AuthState,
	type Disposable,
	fail,
	ok,
	type Result,
	type Source,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { noCandidates, noProfile } from "../../__tests__/support/no-candidates.js";
import { makeIntegration, makeLogger } from "../../subscriptions/__tests__/fixtures.js";
import { createSourceRegistry } from "../../subscriptions/registry.js";
import { createSourcesRoute } from "../sources.js";
import type { RouteDeps } from "../types.js";

const SCAN: AuthState = {
	status: "awaiting-scan",
	qr: { dataUrl: "data:image/png;base64,QR", expiresAt: "2026-10-11T00:03:00.000Z" },
};

function fakeAuth(initial: AuthState = { status: "logged-out" }) {
	let state = initial;
	const auth = {
		beginLogin: vi.fn(async (): Promise<Result> => {
			state = SCAN;
			return ok();
		}),
		logout: vi.fn(async (): Promise<Result> => {
			state = { status: "logged-out" };
			return ok();
		}),
		state: vi.fn(() => state),
		account: vi.fn(() =>
			state.status === "logged-in" ? { name: "主人", avatar: `${"a".repeat(64)}.webp` } : null,
		),
		onChange: (): Disposable => ({ dispose() {} }),
	} satisfies SourceAuth;
	return { auth, set: (next: AuthState) => (state = next) };
}

async function appOf(sources: Record<string, Pick<Source, "auth"> | undefined>) {
	const registry = createSourceRegistry();
	for (const [key, partial] of Object.entries(sources)) {
		if (!partial) continue;
		const source: Source = {
			descriptor: { label: "测试" },
			searchCreators: noCandidates,
			fetchProfile: noProfile,
			start: async () => {},
			stop: async () => {},
			...partial,
		};
		await registry.register(key, source, makeIntegration() as never);
	}
	const log = makeLogger();
	const deps = {
		runtime: { sourceRegistry: registry, serviceCtx: { logger: log } },
	} as unknown as RouteDeps;
	return { app: createSourcesRoute(deps), log, registry };
}

describe("来源缺席 / 没有登录口", () => {
	it.each(["GET", "POST", "DELETE"] as const)(
		"来源不在登记表 → %s 回 503 unavailable",
		async (method) => {
			const { app } = await appOf({});
			const res = await app.request("/bilibili/auth", { method });
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ code: "unavailable" });
		},
	);

	it.each(["GET", "POST", "DELETE"] as const)(
		"来源没有 auth → %s 回 400 unsupported",
		async (method) => {
			const { app } = await appOf({ bilibili: {} });
			const res = await app.request("/bilibili/auth", { method });
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "unsupported" });
		},
	);
});

describe("三个口", () => {
	it("GET:回此刻的状态与账号(没登录时没有 account 这一格)", async () => {
		const { auth, set } = fakeAuth();
		const { app } = await appOf({ bilibili: { auth } });

		const out = await app.request("/bilibili/auth");
		expect(out.status).toBe(200);
		expect(await out.json()).toEqual({ state: { status: "logged-out" } });

		set({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
		const inn = await app.request("/bilibili/auth");
		expect(await inn.json()).toEqual({
			state: { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" },
			account: { name: "主人", avatar: `${"a".repeat(64)}.webp` },
		});
	});

	it("POST:发起扫码,回带二维码的状态", async () => {
		const { auth } = fakeAuth();
		const { app } = await appOf({ bilibili: { auth } });
		const res = await app.request("/bilibili/auth", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ state: SCAN });
		expect(auth.beginLogin).toHaveBeenCalledTimes(1);
	});

	it("POST:发起失败照结果回(码、话、upstreamCode 原样)", async () => {
		const { auth } = fakeAuth();
		auth.beginLogin.mockResolvedValueOnce(
			fail("rate_limited", "获取二维码失败，请重试", { upstreamCode: -352 }),
		);
		const { app } = await appOf({ bilibili: { auth } });
		const res = await app.request("/bilibili/auth", { method: "POST" });
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({
			code: "rate_limited",
			message: "获取二维码失败，请重试",
			upstreamCode: -352,
		});
	});

	// 验红:把 `awaiting-scan` 的判据去掉,这条红;写成连 `confirming` 也拦,下一条红。
	it("POST:正在等扫码时再发起 → 409 conflict,不调实现", async () => {
		const { auth } = fakeAuth(SCAN);
		const { app } = await appOf({ bilibili: { auth } });
		const res = await app.request("/bilibili/auth", { method: "POST" });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "conflict" });
		expect(auth.beginLogin).not.toHaveBeenCalled();
	});

	it.each([
		["开机还没确认", "正在向 B 站确认登录状态，暂时连不上的话会自动重试"],
		["已扫码等手机确认", "已扫码，请在手机上确认"],
	])("POST:confirming(%s)时放行,换一张新码", async (_name, message) => {
		const { auth } = fakeAuth({ status: "confirming", message });
		const { app } = await appOf({ bilibili: { auth } });
		const res = await app.request("/bilibili/auth", { method: "POST" });
		expect(res.status).toBe(200);
		expect(auth.beginLogin).toHaveBeenCalledTimes(1);
	});

	it("DELETE:退出登录,回退出之后的状态;写盘失败照结果回", async () => {
		const { auth, set } = fakeAuth();
		set({ status: "logged-in", loggedInAt: "t" });
		const { app } = await appOf({ bilibili: { auth } });
		const res = await app.request("/bilibili/auth", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ state: { status: "logged-out" } });

		auth.logout.mockResolvedValueOnce(
			fail("unavailable", "已退出，但存着的登录状态没清掉：disk full，重启后可能还是登录着"),
		);
		const failed = await app.request("/bilibili/auth", { method: "DELETE" });
		expect(failed.status).toBe(503);
		expect(await failed.json()).toEqual({
			code: "unavailable",
			message: "已退出，但存着的登录状态没清掉：disk full，重启后可能还是登录着",
		});
	});

	it("实现抛了:回 503 unavailable 与固定的话,原话只进日志,不进回包", async () => {
		const { auth } = fakeAuth();
		auth.beginLogin.mockRejectedValueOnce(new Error("internal-explosion: secret-token-leak"));
		const { app, log } = await appOf({ bilibili: { auth } });
		const res = await app.request("/bilibili/auth", { method: "POST" });
		expect(res.status).toBe(503);
		const text = await res.text();
		expect(text).not.toContain("secret-token-leak");
		expect(JSON.parse(text)).toEqual({
			code: "unavailable",
			message: "发起扫码登录失败，详情在日志里",
		});
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining("internal-explosion"));
	});

	// 验红:把路由里的逐格挑改成把 account 整个放进回包,这条红。
	it("回包逐格挑:实现的 account 多带的格(比如 cookie)不外泄", async () => {
		const { auth } = fakeAuth();
		const leaky = {
			...auth,
			account: () => ({ name: "主人", cookie: "SESSDATA=secret" }) as never,
		} satisfies SourceAuth;
		const { app } = await appOf({ bilibili: { auth: leaky } });
		const text = await (await app.request("/bilibili/auth")).text();
		expect(text).not.toContain("SESSDATA");
		expect(JSON.parse(text)).toEqual({
			state: { status: "logged-out" },
			account: { name: "主人" },
		});
	});
});
