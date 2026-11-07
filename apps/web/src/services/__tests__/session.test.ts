import { describe, expect, it } from "vite-plus/test";
import { classifyLoginResponse } from "../session";

/** 登录失败的回应:平铺的 `{ code, message }`(ADR-0026),面板按 `code` 分。 */
function failure(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify({ code, message }), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

describe("classifyLoginResponse", () => {
	it("200 → ok", async () => {
		const res = new Response("{}", { status: 200 });
		expect(await classifyLoginResponse(res)).toEqual({ ok: true });
	});

	it("unauthorized → invalid credentials,说的是服务端那句", async () => {
		const r = await classifyLoginResponse(failure(401, "unauthorized", "账号或密码错误"));
		expect(r).toEqual({ ok: false, code: "unauthorized", message: "账号或密码错误" });
	});

	it("rate_limited with Retry-After → carrying the seconds", async () => {
		const r = await classifyLoginResponse(
			failure(429, "rate_limited", "登录失败次数过多", { "Retry-After": "42" }),
		);
		expect(r).toMatchObject({ ok: false, code: "rate_limited", retryAfterSec: 42 });
	});

	it("rate_limited without Retry-After → defaults to 60s", async () => {
		const r = await classifyLoginResponse(failure(429, "rate_limited", "登录失败次数过多"));
		expect(r).toMatchObject({ ok: false, code: "rate_limited", retryAfterSec: 60 });
	});

	it("rate_limited with non-numeric or zero Retry-After → falls back to 60s", async () => {
		const soon = failure(429, "rate_limited", "登录失败次数过多", { "Retry-After": "soon" });
		expect(await classifyLoginResponse(soon)).toMatchObject({
			code: "rate_limited",
			retryAfterSec: 60,
		});
		const zero = failure(429, "rate_limited", "登录失败次数过多", { "Retry-After": "0" });
		expect(await classifyLoginResponse(zero)).toMatchObject({
			code: "rate_limited",
			retryAfterSec: 60,
		});
	});

	it("unsupported → auth_disabled (后端权威告知未启用鉴权,触发 LoginDialog 关壳)", async () => {
		const r = await classifyLoginResponse(failure(400, "unsupported", "面板没有开登录"));
		expect(r).toEqual({ ok: false, code: "unsupported", message: "面板没有开登录" });
	});

	/**
	 * 「没开登录」与「请求体不是 JSON」原来都是 400,面板按状态码判就把后者也当成「没开登录」
	 * 关掉了登录框。改按 `code` 判之后,同一个状态码里两件事分得开。
	 */
	it("同为 400 的 invalid 不是「没开登录」—— 落到通用错误,说服务端那句", async () => {
		const r = await classifyLoginResponse(failure(400, "invalid", "请求体要是 JSON"));
		expect(r).toEqual({ ok: false, code: "invalid", message: "请求体要是 JSON" });
	});

	it("来源被拒(403 invalid)→ 通用错误,不冒充账号密码错", async () => {
		const r = await classifyLoginResponse(failure(403, "invalid", "请求来源不被允许"));
		expect(r).toEqual({ ok: false, code: "invalid", message: "请求来源不被允许" });
	});

	it("桌面壳令牌被拒(401 unauthorized)→ 说服务端那句,别说成账号密码错", async () => {
		const r = await classifyLoginResponse(failure(401, "unauthorized", "缺少桌面壳的访问令牌"));
		expect(r).toMatchObject({ ok: false, code: "unauthorized", message: "缺少桌面壳的访问令牌" });
	});

	it("500 → error", async () => {
		const r = await classifyLoginResponse(failure(500, "unknown", "服务端出错了，详情在日志里"));
		expect(r).toMatchObject({ ok: false, code: "unknown" });
	});

	it("体读不出来(反代的 HTML / 空体)→ 通用错误,带状态码;不按状态码猜成别的", async () => {
		const html = new Response("<html>502</html>", { status: 502 });
		expect(await classifyLoginResponse(html)).toEqual({
			ok: false,
			code: "unavailable",
			message: "登录失败 (HTTP 502)",
		});
		// 401 但不是我们的服务端回的(没有 code):不是「账号密码错」。
		const bare401 = new Response(null, { status: 401 });
		expect(await classifyLoginResponse(bare401)).toMatchObject({ code: "unavailable" });
		// 400 同理:没有 code 就不能断言「后端说没开登录」。
		const bare400 = new Response(null, { status: 400 });
		expect(await classifyLoginResponse(bare400)).toMatchObject({ code: "unavailable" });
	});
});
