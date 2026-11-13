import type { ExtensionContext, FetchOptions, SourceDef } from "@bilibili-notify/extension";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { activate } from "../index";
import { testCookieSession } from "./support/cookie-session";

type Reply = { body?: unknown; status?: number; headers?: Record<string, string> };
function setup(respond: (u: URL) => Reply | Promise<Reply>, visitorCookie?: string) {
	let source!: SourceDef;
	const calls: URL[] = [];
	const requestHeaders: Headers[] = [];
	const ctx = {
		createCookieSession(snapshot?: string) {
			const jar = testCookieSession(snapshot);
			if (visitorCookie) jar.ingest("https://www.douyin.com/", visitorCookie);
			return jar;
		},
		i18n: { t: (k: string) => k },
		signal: new AbortController().signal,
		secrets: { get: () => undefined, delete: async () => ({ ok: true }) },
		onDispose: vi.fn(),
		settings: () => ({ get: () => ({ ok: true, settings: {} }) }),
		registerSource: (s: SourceDef) => {
			source = s;
		},
		redact: vi.fn(),
		fetchImage: async () => ({ ok: true, ref: "image:ref" }),
		http: {
			fetch: async (input: URL | string, options: FetchOptions) => {
				const u = new URL(input);
				calls.push(u);
				requestHeaders.push(new Headers(options.headers));
				expect(options.bare).toBe(true);
				expect(options.maxRedirects).toBe(0);
				if (u.hostname === "v.douyin.com")
					expect(new Headers(options.headers).has("cookie")).toBe(false);
				const r = await respond(u),
					status = r.status ?? 200,
					body = r.body ?? null;
				return {
					ok: true,
					status,
					isSuccess: status >= 200 && status < 300,
					headers: new Headers(r.headers),
					text: () => JSON.stringify(body),
					json: () => ({ ok: true, value: body }),
				};
			},
		},
	};
	activate(ctx as unknown as ExtensionContext);
	if (!source.auth || !source.resolveLink || !source.fetchProfile)
		throw new Error("Missing Douyin source operations");
	return {
		source: {
			...source,
			auth: source.auth,
			resolveLink: source.resolveLink,
			fetchProfile: source.fetchProfile,
		},
		calls,
		requestHeaders,
		ctx,
	};
}
const direct = "https://www.douyin.com/video/7386678901234567890";
const detail = {
	aweme_id: "7386678901234567890",
	create_time: 1700000000,
	desc: "a public video",
	author: { sec_uid: "MS4wLjABAAAAabc", nickname: "Alice" },
	video: { duration: 2000 },
};
it("uses the search endpoint's token-only policy for nickname candidates", async () => {
	// Amagi f33c1a8, endpoints/search.ts:115 declares only msToken for this endpoint.
	const { source, calls } = setup(() => ({
		body: {
			status_code: 0,
			user_list: [{ user_info: { sec_uid: "MS4wLjABAAAAfish", nickname: "小鱼" } }],
		},
	}));
	expect(await source.searchCreators("小鱼", new AbortController().signal)).toMatchObject({
		ok: true,
		candidates: [{ externalId: "MS4wLjABAAAAfish", name: "小鱼" }],
	});
	expect(calls).toHaveLength(1);
	const request = calls[0];
	if (!request) throw new Error("Missing source request");
	expect(request.pathname).toBe("/aweme/v1/web/discover/search/");
	expect(request.searchParams.get("keyword")).toBe("小鱼");
	for (const key of ["a_bogus", "X-Bogus", "x-secsdk-web-signature"])
		expect(request.searchParams.has(key)).toBe(false);
});
it.each(["UIFID", "uifid_temp"])(
	"binds %s before signing a protected detail request",
	async (name) => {
		const { source, calls, requestHeaders } = setup(
			() => ({ body: { status_code: 0, aweme_detail: detail } }),
			`${name}=synthetic-visitor; Path=/; Secure`,
		);
		expect(await source.resolveLink(direct, new AbortController().signal)).toMatchObject({
			ok: true,
		});
		const url = calls[0];
		if (!url) throw new Error("Missing detail request");
		expect(url.searchParams.get("uifid")).toBe("synthetic-visitor");
		expect(requestHeaders[0]?.get("uifid")).toBe("synthetic-visitor");
		const keys = [...url.searchParams.keys()];
		expect(keys.indexOf("uifid")).toBeLessThan(keys.indexOf("a_bogus"));
		expect(keys.indexOf("a_bogus")).toBeLessThan(keys.indexOf("timestamp"));
		expect(keys.indexOf("timestamp")).toBeLessThan(keys.indexOf("x-secsdk-web-signature"));
	},
);

it("resolves an unsubscribed video through an anonymous share redirect and signed detail request", async () => {
	const { source, calls } = setup((u) =>
		u.hostname === "v.douyin.com"
			? { status: 302, headers: { Location: direct } }
			: { body: { status_code: 0, aweme_detail: detail } },
	);
	const res = await source.resolveLink("https://v.douyin.com/abc/", new AbortController().signal);
	expect(res).toMatchObject({
		ok: true,
		postId: detail.aweme_id,
		url: direct,
		post: { creator: { name: "Alice" }, text: "a public video" },
	});
	expect(calls).toHaveLength(2);
	expect(calls[1].searchParams.get("a_bogus")).toBeTruthy();
});
it("never follows a share redirect to another domain", async () => {
	const { source, calls } = setup(() => ({
		status: 302,
		headers: { Location: "https://www.douyin.com.evil.invalid/x" },
	}));
	expect(
		(await source.resolveLink("https://v.douyin.com/abc/", new AbortController().signal)).ok,
	).toBe(false);
	expect(calls).toHaveLength(1);
});
it("shares an upstream rate limit between a group link and manual profile refresh", async () => {
	const { source, calls } = setup(() => ({ status: 429, headers: { "retry-after": "90" } })),
		s = new AbortController().signal;
	expect(await source.resolveLink(direct, s)).toMatchObject({ ok: false, code: "rate_limited" });
	expect(
		await source.fetchProfile({ sourceKey: "douyin", externalId: "MS4wLjABAAAAabc" }, s),
	).toMatchObject({ ok: false, code: "rate_limited" });
	expect(calls).toHaveLength(1);
});
it("recognizes a verification directive in the upstream data envelope, without treating it as a missing post", async () => {
	const { source } = setup(() => ({
		body: { status_code: 10000, data: { verify_center_decision_conf: '{"verify_hit":true}' } },
	}));
	expect(await source.resolveLink(direct, new AbortController().signal)).toMatchObject({
		ok: false,
		upstreamCode: "douyin.verify",
	});
});

it("does not return the previous account's preview after logout during image loading", async () => {
	let release!: () => void, started!: () => void;
	const waiting = new Promise<void>((r) => {
			release = r;
		}),
		loading = new Promise<void>((r) => {
			started = r;
		});
	const { source, ctx } = setup(() => ({
		body: {
			status_code: 0,
			aweme_detail: { ...detail, images: [{ url_list: ["https://img.example/sample.jpg"] }] },
		},
	}));
	ctx.fetchImage = async () => {
		started();
		await waiting;
		return { ok: true, ref: "image:ref" };
	};
	const preview = source.resolveLink(direct, new AbortController().signal);
	await loading;
	await source.auth.logout();
	release();
	expect((await preview).ok).toBe(false);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
const viewProfile = { sourceKey: "douyin", externalId: detail.author.sec_uid };
const profileBody = { body: { status_code: 0, user: detail.author } };
const detailBody = { body: { status_code: 0, aweme_detail: detail } };
it.each([
	["verification", { headers: { "bdturing-verify": "captcha" } }, "unavailable", 300000],
	["signature", { status: 403, body: "ArgusSecurityPlugin sign error" }, "unsupported", 600000],
	["temporary", { status: 502 }, "unavailable", 30000],
] as const)(
	"isolates a %s failure to the affected request and allows one recovery probe there",
	async (_label, fault, code, delay) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		const { promise, resolve } = deferred<Reply>();
		const probeSent = deferred<void>();
		let details = 0;
		const { source } = setup((url) => {
			if (url.pathname.includes("profile")) return profileBody;
			details++;
			if (details === 1) return fault;
			if (details === 2) {
				probeSent.resolve();
				return promise;
			}
			return detailBody;
		});
		const signal = new AbortController().signal;
		expect(await source.resolveLink(direct, signal)).toMatchObject({ ok: false, code });
		expect(await source.fetchProfile(viewProfile, signal)).toMatchObject({
			ok: true,
			name: "Alice",
		});
		expect(await source.resolveLink(direct, signal)).toMatchObject({ ok: false, code });
		vi.setSystemTime(start + delay);
		expect(await source.fetchProfile(viewProfile, signal)).toMatchObject({ ok: true });
		const probe = source.resolveLink(direct, signal);
		await probeSent.promise;
		expect(await source.resolveLink(direct, signal)).toMatchObject({ ok: false, code });
		expect(details).toBe(2);
		resolve(detailBody);
		expect(await probe).toMatchObject({ ok: true });
		expect(await source.resolveLink(direct, signal)).toMatchObject({ ok: true });
		expect(details).toBe(3);
	},
);

it("honors the longest concurrent Retry-After, permits one session-wide probe, and ignores a superseded 429", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const epoch = Date.now();
	const profile1 = deferred<Reply>(),
		late = deferred<Reply>(),
		probe = deferred<Reply>();
	const seenProfile = deferred<void>(),
		seenLate = deferred<void>(),
		seenProbe = deferred<void>();
	let profiles = 0,
		details = 0;
	const { source, calls } = setup((url) => {
		if (url.pathname.includes("profile")) {
			if (++profiles === 1) {
				seenProfile.resolve();
				return profile1.promise;
			}
			if (profiles === 2) {
				seenProbe.resolve();
				return probe.promise;
			}
			return profileBody;
		}
		if (++details === 1) {
			seenLate.resolve();
			return late.promise;
		}
		if (details === 2) return { status: 429, headers: { "retry-after": "8" } };
		return detailBody;
	});
	const signal = new AbortController().signal;
	const stale = source.resolveLink(direct, signal);
	await seenLate.promise;
	const longer = source.fetchProfile(viewProfile, signal);
	await seenProfile.promise;
	expect(await source.resolveLink(direct, signal)).toMatchObject({ code: "rate_limited" });
	profile1.resolve({ status: 429, headers: { "retry-after": "20" } });
	expect(await longer).toMatchObject({ code: "rate_limited" });
	vi.setSystemTime(epoch + 8000);
	expect(await source.resolveLink(direct, signal)).toMatchObject({ code: "rate_limited" });
	expect(calls).toHaveLength(3);
	vi.setSystemTime(epoch + 20000);
	const checking = source.fetchProfile(viewProfile, signal);
	await seenProbe.promise;
	expect(await source.resolveLink(direct, signal)).toMatchObject({ code: "rate_limited" });
	probe.resolve(profileBody);
	expect(await checking).toMatchObject({ ok: true });
	late.resolve({ status: 429, headers: { "retry-after": "90" } });
	expect(await stale).toMatchObject({ code: "rate_limited" });
	expect(await source.resolveLink(direct, signal)).toMatchObject({ ok: true });
	expect(calls).toHaveLength(5);
});

it("searches an English nickname when guest account lookup is challenged, preserving uncertainty on an empty search", async () => {
	let found = true;
	const { source, calls } = setup((url) =>
		url.pathname.includes("/user/info/")
			? {
					body: { status_code: 10000, data: { verify_center_decision_conf: { verify_hit: true } } },
				}
			: { body: { status_code: 0, user_list: found ? [{ user_info: detail.author }] : [] } },
	);
	const signal = new AbortController().signal;
	expect(await source.searchCreators("Alice", signal)).toMatchObject({
		ok: true,
		candidates: [{ name: "Alice", externalId: detail.author.sec_uid }],
	});
	found = false;
	expect(await source.searchCreators("Nobody", signal)).toMatchObject({
		ok: false,
		upstreamCode: "douyin.verify",
	});
	expect(calls.map((u) => u.pathname)).toEqual([
		"/web/api/v2/user/info/",
		"/aweme/v1/web/discover/search/",
		"/aweme/v1/web/discover/search/",
	]);
});
it.each(["rate-limit", "logout", "cancel"] as const)(
	"does not continue nickname search after %s during account lookup",
	async (mode) => {
		const started = deferred<void>(),
			reply = deferred<Reply>();
		const { source, calls } = setup(() => {
			started.resolve();
			return reply.promise;
		});
		const abort = new AbortController();
		const result = source.searchCreators("Alice", abort.signal);
		await started.promise;
		if (mode === "logout") await source.auth.logout();
		if (mode === "cancel") abort.abort();
		reply.resolve(
			mode === "rate-limit" ? { status: 429, headers: { "retry-after": "90" } } : { status: 503 },
		);
		expect(await result).toMatchObject({ ok: false });
		expect(calls).toHaveLength(1);
	},
);

it("distinguishes an explicitly private creator from a missing creator without echoing upstream text", async () => {
	const reply = { body: { status_code: 0, filter_detail: { filter_reason: "私密账号" } } };
	const { source, calls } = setup((url) =>
		url.pathname.includes("profile") && url.searchParams.get("sec_user_id") === "MS4wMissing"
			? { status: 404 }
			: reply,
	);
	const signal = new AbortController().signal;
	const hidden = {
		ok: false,
		code: "not_found",
		upstreamCode: "douyin.private",
		message: "api.private",
	};
	expect(
		await source.searchCreators(`https://www.douyin.com/user/${detail.author.sec_uid}`, signal),
	).toMatchObject(hidden);
	expect(await source.fetchProfile(viewProfile, signal)).toMatchObject(hidden);
	expect(await source.searchCreators("Alice", signal)).toMatchObject(hidden);
	expect(await source.searchCreators("MS4wMissing", signal)).toEqual({ ok: true, candidates: [] });
	expect(calls.map((u) => u.pathname)).not.toContain("/aweme/v1/web/discover/search/");
});
