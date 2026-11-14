import { createHash } from "node:crypto";
import type { ExtensionContext, FetchOptions, SourceDef } from "@bilibili-notify/extension";
import { describe, expect, it, vi } from "vite-plus/test";
import { activate } from "../index";
import { testCookieSession } from "./support/cookie-session";

function fixture(
	saved?: string,
	accountData: object = { is_visitor_account: false, user_id_str: "12345", name: "Douyin tester" },
) {
	const requests: { url: URL; headers: Headers; method?: string; body?: unknown }[] = [];
	const ops: string[] = [],
		timers: Array<() => void | Promise<void>> = [];
	const secrets = new Map<string, string>();
	if (saved) secrets.set("login.cookies", saved);
	let pollReply: object | undefined;
	let unreadableAccountReplies = 0;
	let homeStatus = 200;
	let homeRetryStatus: number | undefined;
	let landingPageBytes = 0;
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
				requests.push({ url, headers: new Headers(o.headers), method: o.method, body: o.body });
				expect(o.bare).toBe(true);
				expect(o.maxRedirects).toBe(0);
				const h = new Headers();
				let body: object = {};
				if (url.href === "https://www.douyin.com/") {
					h.append("Set-Cookie", "__ac_nonce=synthetic-nonce; Path=/; Secure");
					h.append(
						"Set-Cookie",
						"passport_csrf_token=synthetic-csrf; Domain=douyin.com; Path=/; Secure",
					);
					if (new Headers(o.headers).get("cookie")?.includes("__ac_signature="))
						h.append(
							"Set-Cookie",
							"UIFID_TEMP=synthetic-visitor; Domain=douyin.com; Path=/; Secure",
						);
				}
				if (url.pathname.endsWith("get_qrcode/"))
					body = {
						data: {
							token: "example-scan-token",
							qrcode_index_url: "https://www.douyin.com/scan/example",
							expire_time: Math.floor(Date.now() / 1000) + 120,
						},
					};
				if (url.pathname.endsWith("check_qrconnect/"))
					body = pollReply ?? { data: { status: poll, redirect_url: redirect } };
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
				if (url.pathname.endsWith("/get_qrcode/")) h.set("x-ms-token", "synthetic-ms-token");
				if (url.pathname === "/sso/callback") {
					h.append("Set-Cookie", "sessionid=sample; Domain=.douyin.com; Path=/; Secure");
					if (landingPageBytes) h.set("location", "https://www.douyin.com/");
				}
				if (url.pathname.endsWith("/info/v2/")) {
					expect(new Headers(o.headers).get("cookie")).toContain("sessionid=sample");
					body = { message: "success", data: accountData };
				}
				const status =
					url.href === "https://www.douyin.com/"
						? new Headers(o.headers).get("cookie")?.includes("__ac_signature=")
							? (homeRetryStatus ?? homeStatus)
							: homeStatus
						: url.pathname === "/sso/callback" && landingPageBytes
							? 302
							: 200;
				const text =
					url.href === "https://www.douyin.com/" &&
					new Headers(o.headers).get("cookie")?.includes("sessionid=")
						? "<html>".padEnd(landingPageBytes, " ")
						: JSON.stringify(body);
				if (o.maxBodyBytes !== undefined && Buffer.byteLength(text) > o.maxBodyBytes)
					return { ok: false, code: "invalid", message: "Synthetic response exceeds body limit" };
				return {
					ok: true,
					status,
					isSuccess: status >= 200 && status < 300,
					headers: h,
					url: url.href,
					text: () => text,
					json: () => {
						if (url.pathname.endsWith("/info/v2/") && unreadableAccountReplies > 0) {
							unreadableAccountReplies--;
							return { ok: false };
						}
						return { ok: true, value: body };
					},
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
		requests,
		setHomeStatus: (status: number) => {
			homeStatus = status;
		},
		setHomeRetryStatus: (status: number) => {
			homeRetryStatus = status;
		},
		setLandingPageBytes: (bytes: number) => {
			landingPageBytes = bytes;
		},
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
		failAccountReads: (count: number) => {
			unreadableAccountReplies = count;
		},
		setPollReply: (reply: object) => {
			pollReply = reply;
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
	it.each([
		{ id: "9876543210123456789", name: undefined, displayed: "9876543210123456789" },
		{ id: 42, name: undefined, displayed: "42" },
		{ id: 2 ** 60, name: "Douyin tester", displayed: "Douyin tester" },
		{ id: 2 ** 60, name: undefined, displayed: undefined },
	])(
		"confirms non-guest user_id $id without displaying a rounded ID",
		async ({ id, name, displayed }) => {
			const f = fixture(undefined, { is_visitor_account: false, user_id: id, name });
			await f.auth.beginLogin();
			f.setPoll("confirmed");
			await f.pollNext();
			expect(f.auth.state().status).toBe("logged-in");
			expect(f.auth.account()?.name).toBe(displayed);
			expect(f.secrets.size).toBe(1);
		},
	);
	it.each([
		{ is_visitor_account: true, user_id: "98765" },
		{ user_id: "98765" },
		{ is_visitor_account: false, user_id: " " },
		{ is_visitor_account: false, user_id: "0" },
		{ is_visitor_account: false, user_id: 0 },
	])("keeps unconfirmed account data out of storage: %o", async (data) => {
		const f = fixture(undefined, data);
		await f.auth.beginLogin();
		f.setPoll("confirmed");
		await f.pollNext();
		expect(f.auth.state().status).not.toBe("logged-in");
		expect(f.secrets.size).toBe(0);
	});
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
	it("completes phone-confirmed login when SSO lands on a full HTML homepage", async () => {
		const f = fixture();
		await f.auth.beginLogin();
		f.setLandingPageBytes(2 * 1024 * 1024);
		f.setPoll("confirmed");
		await f.pollNext();
		expect(f.auth.state().status).toBe("logged-in");
		expect(f.auth.account()?.name).toBe("Douyin tester");
		expect(f.secrets.size).toBe(1);
	});
	it("keeps oversized SSO pages from completing login or persisting credentials", async () => {
		const f = fixture();
		await f.auth.beginLogin();
		f.setLandingPageBytes(4 * 1024 * 1024 + 1);
		f.setPoll("confirmed");
		await f.pollNext();
		expect(f.auth.state().status).toBe("error");
		expect(f.auth.account()).toBeNull();
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

it.each([2156, 4031])(
	"explains an upstream scan security rejection (%i) without exposing its payload",
	async (code) => {
		const f = fixture();
		await f.auth.beginLogin();
		f.setPollReply({
			data: { status: "confirming", error_code: code, description: "sensitive details" },
		});
		await f.pollNext();
		expect(f.auth.state()).toEqual({ status: "error", message: "auth.risk" });
		expect(f.auth.account()).toBeNull();
		expect(f.secrets.size).toBe(0);
	},
);

it("keeps waiting for phone confirmation and distinguishes unknown upstream scan failures", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	f.setPollReply({ data: { status: "confirming", error_code: 0 } });
	await f.pollNext();
	expect(f.auth.state()).toEqual({ status: "confirming", message: "auth.scanned" });
	f.setPollReply({ data: { status: "new", error_code: 3201 } });
	await f.pollNext();
	expect(f.auth.state()).toEqual({ status: "error", message: "auth.pollCode" });
	expect(f.secrets.size).toBe(0);
});

it("rechecks the same confirmed session when account details are briefly unreadable", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	f.setPoll("confirmed");
	f.failAccountReads(1);
	await f.pollNext();
	expect(f.auth.state()).toEqual({ status: "confirming", message: "auth.accountChecking" });
	expect(f.secrets.size).toBe(0);
	await f.pollNext();
	expect(f.auth.state().status).toBe("logged-in");
	expect(f.ops.filter((path) => path.endsWith("/info/v2/"))).toHaveLength(2);
	expect(f.ops.filter((path) => path.endsWith("/sso/callback"))).toHaveLength(1);
	expect(f.ops.filter((path) => path.endsWith("/check_qrconnect/"))).toHaveLength(1);
});

it("ends an inconclusive account check after bounded retries without persisting the session", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	f.setPoll("confirmed");
	f.failAccountReads(5);
	for (let i = 0; i < 3; i++) await f.pollNext();
	expect(f.auth.state()).toEqual({ status: "error", message: "auth.accountFailed" });
	expect(f.secrets.size).toBe(0);
});

it("cancels the pending account check when signing out", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	f.setPoll("confirmed");
	f.failAccountReads(1);
	await f.pollNext();
	expect(f.auth.state().status).toBe("confirming");
	await f.auth.logout();
	expect(f.auth.state().status).toBe("logged-out");
	expect(f.ops.filter((path) => path.endsWith("/info/v2/"))).toHaveLength(1);
	expect(f.secrets.size).toBe(0);
});

it("initializes a fresh login session on Douyin before requesting a QR and respects cookie scope", async () => {
	const f = fixture();
	expect(await f.auth.beginLogin()).toEqual({ ok: true });
	expect(f.requests[0].url.href).toBe("https://www.douyin.com/");
	const request = f.requests.find(({ url }) => url.pathname.endsWith("/get_qrcode/"));
	if (!request) throw new Error("Missing QR request");
	expect(request.headers.get("cookie")).toContain("passport_csrf_token=synthetic-csrf");
	expect(request.headers.get("cookie")).toContain("synthetic-nonce");
	expect(request.headers.get("x-tt-passport-csrf-token")).toBe("synthetic-csrf");
	expect(f.secrets.size).toBe(0);
});

it("negotiates the homepage nonce before QR creation using the same session", async () => {
	const clock = vi.spyOn(Date, "now").mockReturnValue(1700000000000);
	try {
		const f = fixture();
		expect(await f.auth.beginLogin()).toEqual({ ok: true });
		const home = f.requests.filter(({ url }) => url.href === "https://www.douyin.com/");
		expect(home).toHaveLength(2);
		const expected = "_02B4Z6wo00f01HR4CBQAAIDDi4f36wqaOvx0WgyAAHhV16";
		// Frozen official challenge script, synthetic nonce, Chrome 150/macOS, 1700000000000ms.
		expect(home[1]?.headers.get("cookie")).toContain(`__ac_signature=${expected}`);
		expect(home[1]?.headers.get("cookie")).toContain("__ac_nonce=synthetic-nonce");
		const qr = f.requests.find(({ url }) => url.pathname.endsWith("/get_qrcode/"));
		expect(qr?.headers.get("cookie")).toContain("UIFID_TEMP=synthetic-visitor");
		expect(f.secrets.size).toBe(0);
	} finally {
		clock.mockRestore();
	}
});

it("stops QR creation when the homepage negotiation is rejected and permits a fresh attempt", async () => {
	const f = fixture();
	f.setHomeRetryStatus(503);
	expect(await f.auth.beginLogin()).toMatchObject({ ok: false, message: "auth.prepareFailed" });
	expect(f.requests.every(({ url }) => url.pathname === "/")).toBe(true);
	expect(f.secrets.size).toBe(0);
	f.setHomeRetryStatus(200);
	expect(await f.auth.beginLogin()).toEqual({ ok: true });
	expect(f.auth.state().status).toBe("awaiting-scan");
});

it("carries the refreshed login token into QR polling without saving an unverified login", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	await f.pollNext();
	const request = f.requests.find(({ url }) => url.pathname.endsWith("/check_qrconnect/"));
	if (!request) throw new Error("Missing QR poll");
	expect(request.headers.get("cookie")).toContain("msToken=synthetic-ms-token");
	expect(request.url.searchParams.get("msToken")).toBe("synthetic-ms-token");
	expect(f.redact).toHaveBeenCalledWith("synthetic-ms-token");
	expect(f.auth.state().status).toBe("awaiting-scan");
	expect(f.secrets.size).toBe(0);
});

it("stops before creating a QR when login initialization fails and allows a fresh attempt", async () => {
	const f = fixture();
	f.setHomeStatus(403);
	expect(await f.auth.beginLogin()).toMatchObject({ ok: false, message: "auth.prepareFailed" });
	expect(f.auth.state()).toEqual({ status: "error", message: "auth.prepareFailed" });
	expect(f.requests.map(({ url }) => url.pathname)).toEqual(["/"]);
	expect(f.secrets.size).toBe(0);
	f.setHomeStatus(200);
	expect(await f.auth.beginLogin()).toEqual({ ok: true });
	expect(f.auth.state().status).toBe("awaiting-scan");
});

// Decode the page field on the HTTP boundary independently of the signing library.
// Passport uses page 7571, while the main site's data requests use page 6241.
// Protocol layout reference: docs/1.0/douyin-source-research.md (Amagi Passport).
function signedPage(value: string) {
	const alphabet = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
	const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const encoded = [...value].map((c) => (c === "=" ? c : standard[alphabet.indexOf(c)])).join("");
	const encrypted = Buffer.from(encoded, "base64").subarray(4);
	const box = Array.from({ length: 256 }, (_, i) => 255 - i);
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j * box[i] + j + 211) % 256;
		[box[i], box[j]] = [box[j], box[i]];
	}
	let i = 0;
	j = 0;
	const plain = [...encrypted]
		.map((byte) => {
			i = (i + 1) % 256;
			j = (j + box[i]) % 256;
			[box[i], box[j]] = [box[j], box[i]];
			return byte ^ box[(box[i] + box[j]) % 256];
		})
		.slice(8);
	const fields: number[] = [];
	for (let k = 0; k + 3 < plain.length; k += 4) {
		fields.push(
			(plain[k] & 110) | (plain[k + 3] & 145),
			(plain[k + 1] & 189) | (plain[k + 3] & 66),
			(plain[k + 2] & 211) | (plain[k + 3] & 44),
		);
	}
	return fields[37] + fields[13] * 256 + fields[23] * 65536 + fields[6] * 16777216;
}
it("signs QR creation and polling for the Passport page", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	await f.pollNext();
	const requests = f.requests.filter(({ url }) =>
		/\/passport\/web\/(get_qrcode|check_qrconnect)\//.test(url.pathname),
	);
	expect(requests).toHaveLength(2);
	for (const { url } of requests) {
		const signature = url.searchParams.get("a_bogus");
		if (!signature) throw new Error("Missing request signature");
		expect(signedPage(signature)).toBe(7571);
	}
});

it("polls the QR through the current website POST form without placing the token in its URL", async () => {
	const f = fixture();
	await f.auth.beginLogin();
	await f.pollNext();
	const request = f.requests.find(({ url }) => url.pathname.endsWith("/check_qrconnect/"));
	if (!request) throw new Error("Missing QR poll");
	expect(request.url.origin).toBe("https://www.douyin.com");
	expect(request.method).toBe("POST");
	expect(request.url.searchParams.has("token")).toBe(false);
	expect(request.url.searchParams.has("next")).toBe(false);
	expect(typeof request.body).toBe("string");
	const form = new URLSearchParams(request.body as string);
	expect(form.get("token")).toBe("example-scan-token");
	expect(form.get("next")).toBe("https://www.douyin.com/");
	expect(form.get("is_frontier")).toBe("true");
	expect(form.get("is_new_login")).toBe("1");
	const query =
		"account_app_language=zh-CN&account_sdk_source=web&aid=6383&biz_trace_id=" +
		request.url.searchParams.get("biz_trace_id") +
		"&device_platform=web_app&is_from_iesaccountsaas=1&is_from_ttaccountsdk=1&language=zh&p_bd=1.0.1.19-fix.01&p_ca=4.0.17";
	const signedBody =
		"is_frontier=true&is_new_login=1&need_logo=false&need_short_url=true&next=https://www.douyin.com/&token=example-scan-token";
	// The website SDK signs the sorted, unescaped field values before form encoding.
	const expected = createHash("sha256")
		.update(`${query}&${signedBody}&app_key=163e7ce78d58971a41f5b969996d85c2`)
		.digest("hex");
	expect(request.url.searchParams.get("sign")).toBe(expected);
	expect(request.headers.get("origin")).toBe("https://www.douyin.com");
	expect(f.secrets.size).toBe(0);
});
