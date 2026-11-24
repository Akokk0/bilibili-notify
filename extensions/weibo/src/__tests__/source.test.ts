import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { host, loginReply, type Reply } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

it.each([
	["Forbidden", "logged-in"],
	["<html>验证码</html>", "error"],
])("handles a 403 with %s without exchanging or erasing the session", async (body, status) => {
	const app = host((url) =>
		url.pathname === "/ajax/profile/info" ? { status: 403, body } : loginReply(url),
	);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const saved = [...app.secrets.values()];
	const before = app.fetch.mock.calls.length;
	expect(await app.source.searchCreators("42", new AbortController().signal)).toMatchObject({
		ok: false,
		code: "unavailable",
	});
	expect(app.auth.state().status).toBe(status);
	expect(app.fetch).toHaveBeenCalledTimes(before + 1);
	expect([...app.secrets.values()]).toEqual(saved);
	app.dispose();
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

it.each([0, 13000])(
	"delivers the verified creator before a slow avatar when profile lookup took %i ms",
	async (delay) => {
		const app = host(
			async (url) => {
				if (url.pathname !== "/ajax/profile/info") return loginReply(url);
				if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
				return {
					body: {
						ok: 1,
						data: {
							user: {
								idstr: "42",
								screen_name: "小雨",
								following: true,
								followers_count: 0,
								avatar_large: "https://tvax4.sinaimg.cn/large/slow.jpg",
							},
						},
					},
				};
			},
			undefined,
			() => new Promise(() => {}),
		);
		await app.auth.beginLogin();
		await vi.advanceTimersByTimeAsync(3000);
		const received = vi.fn();
		void app.source.searchCreators("@小雨", new AbortController().signal).then(received);
		await vi.advanceTimersByTimeAsync(delay || 3000);
		expect(received).toHaveBeenCalledWith({
			ok: true,
			candidates: [{ externalId: "42", name: "小雨", followers: 0 }],
		});
		app.dispose();
	},
);

it.each(["虎牙楚河", "@虎牙楚河", "https://weibo.com/n/%E8%99%8E%E7%89%99%E6%A5%9A%E6%B2%B3"])(
	"resolves a nickname to the creator's stable UID: %s",
	async (input) => {
		const app = host((url) => {
			if (url.pathname !== "/ajax/profile/info") return loginReply(url);
			expect(url.searchParams.get("screen_name")).toBe("虎牙楚河");
			expect(url.searchParams.has("uid")).toBe(false);
			return {
				body: {
					ok: 1,
					data: { user: { idstr: "5710620661", screen_name: "虎牙楚河", following: true } },
				},
			};
		});
		await app.auth.beginLogin();
		await vi.advanceTimersByTimeAsync(3000);
		expect(await app.source.searchCreators(input, new AbortController().signal)).toEqual({
			ok: true,
			candidates: [{ externalId: "5710620661", name: "虎牙楚河" }],
		});
		app.dispose();
	},
);

it("returns an empty list for an unused nickname even when Weibo reports a successful request", async () => {
	const app = host((url) =>
		url.pathname === "/ajax/profile/info"
			? { body: { ok: 1, msg: "该昵称当前没有人使用" } }
			: loginReply(url),
	);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(await app.source.searchCreators("无人使用", new AbortController().signal)).toEqual({
		ok: true,
		candidates: [],
	});
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
