import type { ExtensionContext, FetchOptions, SourceDef } from "@bilibili-notify/extension";
import { describe, expect, it, vi } from "vite-plus/test";
import { activate } from "../index";
import { testCookieSession } from "./support/cookie-session";

function fixture(saved?: string) {
	const ops: string[] = [],
		timers: Array<() => void | Promise<void>> = [];
	const secrets = new Map<string, string>();
	if (saved) secrets.set("login.cookies", saved);
	let validationReply: object = { data: { error_code: 0 } };
	const smsRequests: { trace: string | null; code: string | null }[] = [];
	let source!: SourceDef;
	let poll = "new",
		redirect = "https://www.douyin.com/sso/callback";
	const ctx = {
		createCookieSession: testCookieSession,
		signal: new AbortController().signal,
		i18n: { t: (k: string) => k },
		settings: () => ({ get: () => ({ ok: true, settings: {} }) }),
		secrets: {
			get: (k: string) => secrets.get(k),
			set: async (k: string, v: string) => {
				secrets.set(k, v);
				return { ok: true };
			},
			delete: async (k: string) => {
				secrets.delete(k);
				return { ok: true };
			},
		},
		redact: vi.fn(),
		onDispose: vi.fn(),
		setTimeout: (fn: () => void) => {
			timers.push(fn);
			return {
				dispose() {
					const i = timers.indexOf(fn);
					if (i >= 0) timers.splice(i, 1);
				},
			};
		},
		registerSource: (s: SourceDef) => {
			source = s;
		},
		state: { get: () => undefined },
		http: {
			fetch: async (u: URL | string, o: FetchOptions) => {
				const url = new URL(u);
				ops.push(url.hostname + url.pathname);
				expect(o.bare).toBe(true);
				expect(o.maxRedirects).toBe(0);
				const h = new Headers();
				let body: object = {};
				if (url.pathname.endsWith("get_qrcode/"))
					body = {
						data: {
							token: "example-scan-token",
							qrcode_index_url: "https://www.douyin.com/scan/example",
							expire_time: Math.floor(Date.now() / 1000) + 120,
						},
					};
				if (url.pathname.endsWith("check_qrconnect/"))
					body = { data: { status: poll, redirect_url: redirect } };
				if (url.pathname.endsWith("check_qrconnect/") && poll === "sms")
					body = {
						data: {
							error_code: 2046,
							verify_ways: [{ verify_way: "assist_mobile_sms_verify" }],
							verify_ticket: "synthetic-ticket",
						},
					};
				if (url.pathname.endsWith("_code/")) {
					if (typeof o.body !== "string") throw new Error("Expected an encoded form");
					const form = new URLSearchParams(o.body);
					expect(form.get("std_verify_way")).toBe("assist_mobile_sms_verify");
					smsRequests.push({ trace: url.searchParams.get("biz_trace_id"), code: form.get("code") });
					body = url.pathname.endsWith("validate_code/")
						? validationReply
						: { data: { error_code: 0 } };
				}
				if (url.pathname === "/sso/callback")
					h.append("Set-Cookie", "sessionid=sample; Domain=.douyin.com; Path=/; Secure");
				if (url.pathname.endsWith("/info/v2/")) {
					expect(new Headers(o.headers).get("cookie")).toContain("sessionid=sample");
					body = {
						message: "success",
						data: { is_visitor_account: false, user_id_str: "12345", name: "Douyin tester" },
					};
				}
				return {
					ok: true,
					status: 200,
					isSuccess: true,
					headers: h,
					url: url.href,
					text: () => JSON.stringify(body),
					json: () => ({ ok: true, value: body }),
				};
			},
		},
	};
	activate(ctx as unknown as ExtensionContext);
	if (!source.auth?.submitVerification || !source.auth.account)
		throw new Error("Missing authentication operations");
	return {
		auth: {
			...source.auth,
			submitVerification: source.auth.submitVerification,
			account: source.auth.account,
		},
		smsRequests,
		ops,
		pollNext: async () => {
			const next = timers.shift();
			if (!next) throw new Error("Missing scheduled poll");
			await next();
		},
		secrets,
		redact: ctx.redact,
		setValidationReply: (reply: object) => {
			validationReply = reply;
		},
		setPoll: (s: string) => {
			poll = s;
		},
		setRedirect: (s: string) => {
			redirect = s;
		},
	};
}
describe("source account", () => {
	it("presents the upstream QR, confirms the account before persistence and forgets it on logout", async () => {
		const f = fixture();
		expect((await f.auth.beginLogin()).ok).toBe(true);
		expect(f.auth.state()).toMatchObject({
			status: "awaiting-scan",
			qr: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/) },
		});
		expect(f.secrets.size).toBe(0);
		f.setPoll("scanned");
		await f.pollNext();
		expect(f.auth.state().status).toBe("confirming");
		f.setPoll("confirmed");
		await f.pollNext();
		expect(f.auth.state().status).toBe("logged-in");
		expect(f.auth.account()?.name).toBe("Douyin tester");
		expect(f.secrets.size).toBe(1);
		const restored = fixture(f.secrets.get("login.cookies"));
		await vi.waitFor(() => expect(restored.auth.account()?.name).toBe("Douyin tester"));
		await f.auth.logout();
		expect(f.auth.state().status).toBe("logged-out");
		expect(f.secrets.size).toBe(0);
	});
	it("refuses a foreign SSO redirect before making a request or storing a cookie", async () => {
		const f = fixture();
		await f.auth.beginLogin();
		f.setPoll("confirmed");
		f.setRedirect("https://evil.example/");
		await f.pollNext();
		expect(f.auth.state().status).toBe("error");
		expect(f.ops.join(" ")).not.toContain("evil.example");
		expect(f.secrets.size).toBe(0);
	});
});

it("does not leave a saved but expired cookie stuck at confirming on restart", async () => {
	const f = fixture(testCookieSession().snapshot());
	await vi.waitFor(() => expect(f.auth.state().status).toBe("expired"));
	expect(f.secrets.size).toBe(0);
});
it("binds SMS answers to the QR attempt and never persists a code or verification ticket", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	f.setPoll("sms");
	await f.pollNext();
	const state = f.auth.state();
	if (state.status !== "confirming" || state.verification?.kind !== "sms")
		throw new Error("Expected SMS challenge");
	const { attemptId } = state.verification;
	expect(attemptId).toBeTruthy();
	expect(await f.auth.submitVerification("old", "123456")).toMatchObject({
		ok: false,
		code: "conflict",
	});
	f.setValidationReply({ data: { error_code: 1202 } });
	expect(await f.auth.submitVerification(attemptId, "000000")).toMatchObject({
		ok: false,
		code: "invalid",
	});
	f.setValidationReply({ data: { error_code: 0 } });
	expect((await f.auth.submitVerification(attemptId, "123456")).ok).toBe(true);
	expect(f.smsRequests).toHaveLength(3);
	expect(new Set(f.smsRequests.map((r) => r.trace)).size).toBe(1);
	expect(f.smsRequests[2].code).toBe("343736313033");
	expect(f.secrets.size).toBe(0);
	expect(f.auth.state().status).toBe("confirming");
});

it("resumes QR confirmation on an SMS ticket and saves only the verified account cookies", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	f.setPoll("sms");
	await f.pollNext();
	const state = f.auth.state();
	if (state.status !== "confirming" || state.verification?.kind !== "sms")
		throw new Error("Expected SMS challenge");
	const { attemptId } = state.verification;
	const ticket = "synthetic-validation-ticket";
	for (const reply of [
		{},
		{ data: { ticket: " " } },
		{ message: "error", data: { ticket } },
		{ message: "error", data: { error_code: 0, ticket } },
		{ error_code: 1202, data: { ticket } },
		{ error_code: 1202, data: { error_code: 0, ticket } },
		{ message: "success", data: { error_code: 1202, ticket } },
	]) {
		f.setValidationReply(reply);
		expect(await f.auth.submitVerification(attemptId, "123456")).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(f.auth.state()).toMatchObject({ verification: { attemptId } });
	}
	f.setValidationReply({ data: { ticket } });
	expect(await f.auth.submitVerification(attemptId, "123456")).toEqual({ ok: true });
	expect(f.redact).toHaveBeenCalledWith(ticket);
	expect(f.auth.state()).toMatchObject({ status: "confirming" });
	expect(JSON.stringify(f.auth.state())).not.toContain(ticket);
	expect(f.auth.account()).toBeNull();
	expect(f.secrets.size).toBe(0);
	f.setPoll("confirmed");
	await f.pollNext();
	expect(f.auth.state().status).toBe("logged-in");
	expect(f.auth.account()?.name).toBe("Douyin tester");
	expect(f.secrets.get("login.cookies")).toContain("sample");
	expect(f.secrets.get("login.cookies")).not.toContain(ticket);
});
