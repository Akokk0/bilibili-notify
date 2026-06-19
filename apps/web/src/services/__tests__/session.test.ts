import { describe, expect, it } from "vite-plus/test";
import { classifyLoginResponse } from "../session";

function res(status: number, headers: Record<string, string> = {}): Response {
	return new Response(status === 200 ? "{}" : null, { status, headers });
}

describe("classifyLoginResponse", () => {
	it("200 → ok", async () => {
		expect(await classifyLoginResponse(res(200))).toEqual({ ok: true });
	});

	it("401 → invalid credentials", async () => {
		const r = await classifyLoginResponse(res(401));
		expect(r).toEqual({ ok: false, kind: "invalid", message: expect.any(String) });
	});

	it("429 with Retry-After → rate_limited carrying the seconds", async () => {
		const r = await classifyLoginResponse(res(429, { "Retry-After": "42" }));
		expect(r).toMatchObject({ ok: false, kind: "rate_limited", retryAfterSec: 42 });
	});

	it("429 without Retry-After → defaults to 60s", async () => {
		const r = await classifyLoginResponse(res(429));
		expect(r).toMatchObject({ ok: false, kind: "rate_limited", retryAfterSec: 60 });
	});

	it("429 with non-numeric or zero Retry-After → falls back to 60s", async () => {
		expect(await classifyLoginResponse(res(429, { "Retry-After": "soon" }))).toMatchObject({
			kind: "rate_limited",
			retryAfterSec: 60,
		});
		expect(await classifyLoginResponse(res(429, { "Retry-After": "0" }))).toMatchObject({
			kind: "rate_limited",
			retryAfterSec: 60,
		});
	});

	it("400 → auth_disabled (后端权威告知未启用鉴权,触发 LoginDialog 关壳)", async () => {
		const r = await classifyLoginResponse(res(400));
		expect(r).toEqual({ ok: false, kind: "auth_disabled" });
	});

	it("500 → error", async () => {
		const r = await classifyLoginResponse(res(500));
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});
});
