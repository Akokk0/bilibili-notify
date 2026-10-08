import { describe, expect, it } from "vite-plus/test";
import { interpretQQSend, qqFilesPath, qqRestHeaders } from "../qq-official";

describe("qqRestHeaders — REST 鉴权头", () => {
	it("Authorization: QQBot {token} + X-Union-Appid: {appId}", () => {
		expect(qqRestHeaders("TKN", "app1")).toEqual({
			authorization: "QQBot TKN",
			"x-union-appid": "app1",
		});
	});
});

describe("qqFilesPath — 群/C2C 富媒体上传路径", () => {
	it("group → /v2/groups/{openid}/files", () => {
		expect(qqFilesPath("group", "G1")).toBe("/v2/groups/G1/files");
	});
	it("private → /v2/users/{openid}/files", () => {
		expect(qqFilesPath("private", "U1")).toBe("/v2/users/U1/files");
	});
});

describe("interpretQQSend — A+ 投递语义(提交即成功)", () => {
	it("200 + id → 已发(ok + id)", () => {
		expect(interpretQQSend(200, { id: "MSG1", timestamp: "..." })).toEqual({
			ok: true,
			id: "MSG1",
		});
	});

	it("202 + code 304023 + audit_id → 已提交·审核中(算 ok)", () => {
		expect(
			interpretQQSend(202, {
				code: 304023,
				message: "push message is waiting for audit now",
				data: { message_audit: { audit_id: "AUDIT1" } },
			}),
		).toEqual({ ok: true, pendingAudit: true, auditId: "AUDIT1" });
	});

	it("200 + 顶层 message_audit.audit_id → 审核中", () => {
		expect(interpretQQSend(200, { message_audit: { audit_id: "AUDIT2" } })).toEqual({
			ok: true,
			pendingAudit: true,
			auditId: "AUDIT2",
		});
	});

	it("2xx 但带非零业务 code(无 id/audit)→ unknown,QQ 的码放 upstreamCode", () => {
		expect(interpretQQSend(200, { code: 40034, message: "rich media type error" })).toEqual({
			ok: false,
			code: "unknown",
			message: "code 40034: rich media type error",
			upstreamCode: 40034,
		});
	});

	it("4xx → 标准码按 HTTP 状态取,QQ 的码放 upstreamCode", () => {
		expect(interpretQQSend(400, { code: 11293, message: "bad request" })).toEqual({
			ok: false,
			code: "invalid",
			message: "code 11293: bad request",
			upstreamCode: 11293,
		});
	});

	it("非 2xx 的状态码对照:401/403 unauthorized、404/410 not_found、429 rate_limited、其余 4xx invalid、5xx unavailable", () => {
		const cases: Array<[number, string]> = [
			[401, "unauthorized"],
			[403, "unauthorized"],
			[404, "not_found"],
			[410, "not_found"],
			[429, "rate_limited"],
			[422, "invalid"],
			[502, "unavailable"],
		];
		for (const [status, code] of cases) {
			expect(interpretQQSend(status, { code: 22009, message: "x" }), `HTTP ${status}`).toEqual({
				ok: false,
				code,
				message: "code 22009: x",
				upstreamCode: 22009,
			});
		}
	});

	it("非 2xx 且无 body message → 回退 HTTP {status};没有 QQ 的码就把 HTTP 状态写成 http:<status>", () => {
		expect(interpretQQSend(500, {})).toEqual({
			ok: false,
			code: "unavailable",
			message: "HTTP 500",
			upstreamCode: "http:500",
		});
	});

	it("非 2xx 的错误体即便带 audit_id 也是失败", () => {
		expect(
			interpretQQSend(403, { code: 304023, data: { message_audit: { audit_id: "A" } } }),
		).toMatchObject({ ok: false, code: "unauthorized", upstreamCode: 304023 });
	});
});
