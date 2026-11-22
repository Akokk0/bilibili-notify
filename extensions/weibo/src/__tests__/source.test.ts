import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { host, loginReply, type Reply } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

it("honors a dated Retry-After across a restart, including before checking the saved account", async () => {
	const until = Date.UTC(2026, 10, 23, 1);
	vi.setSystemTime(until - 123000);
	const app = host(
		(url): Reply =>
			url.pathname === "/ajax/profile/info"
				? { status: 429, headers: { "Retry-After": new Date(until).toUTCString() } }
				: loginReply(url),
	);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	await app.source.searchCreators("42", new AbortController().signal);
	app.dispose();
	const restored = host(loginReply, app.secrets, undefined, app.state);
	await vi.advanceTimersByTimeAsync(119999);
	expect(restored.fetch).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(restored.auth.state().status).toBe("logged-in");
	expect(restored.fetch).toHaveBeenCalledTimes(1);
	restored.dispose();
});

it("resolves a profile link through the authenticated PC API and preserves the UID as text", async () => {
	const uid = "98765432109876543";
	const app = host((url, options) => {
		if (url.pathname !== "/ajax/profile/info") return loginReply(url);
		expect(url.origin).toBe("https://weibo.com");
		expect(url.searchParams.get("uid")).toBe(uid);
		expect(url.searchParams.get("scene")).toBe("1");
		expect(new Headers(options.headers).get("Cookie")).toBe("SUB=active");
		return {
			body: {
				ok: 1,
				data: {
					user: { idstr: uid, screen_name: "小雨", description: "天气", followers_count: 0 },
				},
			},
		};
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const signal = new AbortController().signal;
	expect(await app.source.searchCreators(`https://weibo.com/u/${uid}`, signal)).toEqual({
		ok: true,
		candidates: [{ externalId: uid, name: "小雨", bio: "天气", followers: 0 }],
	});
	const before = app.fetch.mock.calls.length;
	expect((await app.source.searchCreators("https://weibo.com.example/u/123", signal)).ok).toBe(
		false,
	);
	expect(app.fetch).toHaveBeenCalledTimes(before);
	app.dispose();
});

it("two concurrent reads with an expired session share a recovery and issue spaced reads using the renewed cookie", async () => {
	let renewed = false;
	const times: number[] = [];
	let exchanges = 0;
	const app = host((url, options): Reply => {
		if (url.pathname === "/sso/login.php") {
			exchanges++;
			return {
				status: 302,
				headers: { location: "https://passport.weibo.com/sso/crossdomain?renew=1" },
			};
		}
		if (url.searchParams.has("renew")) {
			renewed = true;
			return {
				status: 302,
				headers: {
					location: "https://weibo.com/",
					"set-cookie": "SUB=new; Domain=weibo.com; Path=/",
				},
			};
		}
		if (url.pathname !== "/ajax/profile/info") return loginReply(url);
		times.push(Date.now());
		if (!renewed) return { status: 200, body: { ok: 0, msg: "请先登录" } };
		expect(new Headers(options.headers).get("cookie")).toBe("SUB=new");
		return {
			body: {
				ok: 1,
				data: { user: { idstr: url.searchParams.get("uid"), screen_name: "已恢复" } },
			},
		};
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const signal = new AbortController().signal;
	const reads = Promise.all(["42", "43"].map((uid) => app.source.searchCreators(uid, signal)));
	await vi.advanceTimersByTimeAsync(2000);
	expect((await reads).map((x) => x.ok)).toEqual([true, true]);
	expect(exchanges).toBe(1);
	expect(times.map((t) => t - times[0])).toEqual([0, 1000, 2000]);
	app.dispose();
});

it("shares Retry-After across creator requests while keeping the account and resuming when the deadline passes", async () => {
	let reads = 0;
	const app = host((url): Reply => {
		if (url.pathname !== "/ajax/profile/info") return loginReply(url);
		if (++reads === 1) return { status: 429, headers: { "retry-after": "90" } };
		return { body: { ok: 1, data: { user: { idstr: "23", screen_name: "雨" } } } };
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const signal = new AbortController().signal;
	expect(await app.source.searchCreators("42", signal)).toMatchObject({
		ok: false,
		code: "rate_limited",
	});
	await vi.advanceTimersByTimeAsync(89999);
	expect(
		await app.source.fetchProfile?.({ sourceKey: "weibo", externalId: "23" }, signal),
	).toMatchObject({ ok: false, code: "rate_limited" });
	expect(reads).toBe(1);
	expect(app.auth.state().status).toBe("logged-in");
	await vi.advanceTimersByTimeAsync(1);
	expect(await app.source.searchCreators("23", signal)).toMatchObject({
		ok: true,
		candidates: [{ name: "雨" }],
	});
	app.dispose();
});
