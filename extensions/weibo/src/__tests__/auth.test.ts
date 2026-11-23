import { type ExtensionContext, fail, ok } from "@bilibili-notify/extension";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { home, host, loginReply, qrReply, type Reply } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const portrait = "//tvax4.sinaimg.cn/large/portrait.jpg";
const avatarRef = `${"ab".repeat(32)}.jpg`;

function loginWithAvatar(url: URL): Reply {
	return url.href === "https://weibo.com/"
		? { body: home("12345", "阿青", portrait) }
		: loginReply(url);
}

it("publishes the verified account immediately and notifies the panel when its gallery avatar is ready", async () => {
	let finish!: () => void;
	const fetchImage = vi.fn<ExtensionContext["fetchImage"]>(
		() =>
			new Promise((resolve) => {
				finish = () => resolve(ok({ ref: avatarRef }));
			}),
	);
	const app = host(loginWithAvatar, undefined, fetchImage);
	const changed = vi.fn();
	app.auth.onChange(changed);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(app.auth.account?.()).toEqual({ name: "阿青" });
	expect(fetchImage).toHaveBeenCalledWith(`https:${portrait}`, {
		headers: { Referer: "https://weibo.com/" },
		signal: expect.any(AbortSignal),
	});
	changed.mockClear();
	finish();
	await vi.advanceTimersByTimeAsync(0);
	expect(changed).toHaveBeenCalled();
	expect(app.auth.account?.()).toEqual({ name: "阿青", avatar: avatarRef });
	app.dispose();

	const restored = host(loginWithAvatar, app.secrets, async () => ok({ ref: avatarRef }));
	await vi.advanceTimersByTimeAsync(0);
	expect(restored.auth.account?.()).toEqual({ name: "阿青", avatar: avatarRef });
	expect(restored.fetch).toHaveBeenCalledTimes(1);
	restored.dispose();
});

it("retries a failed avatar download without rechecking or signing out the account", async () => {
	const fetchImage = vi
		.fn<ExtensionContext["fetchImage"]>()
		.mockResolvedValueOnce(fail("unavailable", "offline"))
		.mockResolvedValue(ok({ ref: avatarRef }));
	const app = host(loginWithAvatar, undefined, fetchImage);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(app.auth.account?.()).toEqual({ name: "阿青" });
	const calls = app.fetch.mock.calls.length;
	await vi.advanceTimersByTimeAsync(59_999);
	expect(fetchImage).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(app.auth.account?.()).toEqual({ name: "阿青", avatar: avatarRef });
	expect(app.fetch).toHaveBeenCalledTimes(calls);
	app.dispose();
});

it("keeps the new account's portrait when an old download finishes after logout", async () => {
	let finish!: () => void;
	let switched = false;
	const nextRef = `${"cd".repeat(32)}.jpg`;
	const fetchImage = vi
		.fn<ExtensionContext["fetchImage"]>()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve(ok({ ref: avatarRef }));
				}),
		)
		.mockResolvedValue(ok({ ref: nextRef }));
	const app = host(
		(url) =>
			switched && url.href === "https://weibo.com/"
				? { body: home("987", "小叶", "//tvax4.sinaimg.cn/large/next.jpg") }
				: loginWithAvatar(url),
		undefined,
		fetchImage,
	);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	await app.auth.logout();
	switched = true;
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(app.auth.account?.()).toEqual({ name: "小叶", avatar: nextRef });
	finish();
	await vi.advanceTimersByTimeAsync(0);
	expect(app.auth.account?.()).toEqual({ name: "小叶", avatar: nextRef });
	app.dispose();
});

it("ignores a late account confirmation after logout", async () => {
	let finish!: (reply: Reply) => void;
	const delayed = new Promise<Reply>((resolve) => {
		finish = resolve;
	});
	const app = host((url) => (url.href === "https://weibo.com/" ? delayed : loginReply(url)));
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(app.auth.state().status).toBe("confirming");
	await app.auth.logout();
	finish({ body: home() });
	await vi.advanceTimersByTimeAsync(0);
	expect(app.auth.state().status).toBe("logged-out");
	expect(app.secrets.size).toBe(0);
	app.dispose();
});

it.each(["wrong cookie scope", "changed UID"])(
	"keeps the saved credential unchanged when renewal returns %s",
	async (reason) => {
		const first = host(loginReply);
		await first.auth.beginLogin();
		await vi.advanceTimersByTimeAsync(3000);
		first.dispose();
		const saved = [...first.secrets.values()];
		let pages = 0;
		const app = host((url): Reply => {
			if (url.pathname === "/" && pages++ === 0) return { status: 401 };
			if (url.pathname === "/sso/login.php")
				return { status: 302, headers: { location: "https://passport.weibo.com/sso/crossdomain" } };
			if (url.pathname === "/sso/crossdomain")
				return {
					status: 302,
					headers: {
						location: "https://weibo.com/",
						"set-cookie":
							reason === "wrong cookie scope"
								? "SUB=other; Path=/sso"
								: "SUB=new; Domain=weibo.com; Path=/",
					},
				};
			return { body: home(reason === "changed UID" ? "987" : "12345") };
		}, first.secrets);
		await vi.advanceTimersByTimeAsync(0);
		expect(app.auth.state().status).toBe("expired");
		expect([...app.secrets.values()]).toEqual(saved);
		app.dispose();
	},
);

it("stopping the source cancels account maintenance while preserving its saved login", async () => {
	const app = host(loginReply);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const count = app.fetch.mock.calls.length;
	await app.source.stop();
	await vi.advanceTimersByTimeAsync(86400000);
	expect(app.fetch).toHaveBeenCalledTimes(count);
	expect(app.secrets.size).toBe(1);
	app.dispose();
});

it("keeps a verified web login usable when daily SSO renewal needs human verification", async () => {
	let exchanges = 0;
	const app = host((url): Reply => {
		if (url.pathname === "/sso/login.php") {
			exchanges++;
			return {
				status: 403,
				body: "<html>验证码</html>",
				headers: { "set-cookie": "ALC=visitor; Path=/" },
			};
		}
		return loginReply(url);
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000 + 48 * 3600000);
	expect(exchanges).toBe(1);
	expect(app.auth.state().status).toBe("logged-in");
	expect(app.ctx.reportProblem).toHaveBeenCalledWith(
		expect.objectContaining({ code: "weibo_renewal" }),
	);
	app.dispose();
});

it.each([true, false])(
	"retries an ordinary renewal 403 with a usable web session: %s",
	async (usable) => {
		const first = host(loginReply);
		await first.auth.beginLogin();
		await vi.advanceTimersByTimeAsync(3000);
		first.dispose();
		vi.setSystemTime(Date.now() + 24 * 3600000);
		let attempts = 0;
		let renewed = false;
		const app = host((url) => {
			if (url.pathname === "/sso/login.php") {
				if (++attempts === 1) return { status: 403, body: "Forbidden" };
				return { status: 302, headers: { location: "https://passport.weibo.com/sso/crossdomain" } };
			}
			if (url.pathname === "/sso/crossdomain") renewed = true;
			if (url.pathname === "/" && !usable && !renewed) return { status: 401 };
			return loginReply(url);
		}, first.secrets);
		await vi.advanceTimersByTimeAsync(299999);
		expect(app.auth.state().status).toBe(usable ? "logged-in" : "confirming");
		expect(attempts).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(renewed).toBe(true);
		expect(app.auth.state().status).toBe("logged-in");
		app.dispose();
	},
);

it.each([200, 403])("explains a verification page during QR polling (HTTP %i)", async (status) => {
	const app = host((url) =>
		url.pathname === "/sso/v2/qrcode/check"
			? { status, body: "<html><title>安全验证</title></html>" }
			: qrReply(url),
	);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(app.auth.state()).toEqual({ status: "error", message: "auth.verify" });
	const requests = app.fetch.mock.calls.length;
	await vi.advanceTimersByTimeAsync(60000);
	expect(app.fetch).toHaveBeenCalledTimes(requests);
	app.dispose();
});

it("opens a Weibo QR challenge from the system account entry without saving an unconfirmed session", async () => {
	const app = host(qrReply);
	expect(app.auth.state()).toEqual({ status: "logged-out" });
	expect(await app.auth.beginLogin()).toEqual({ ok: true });
	expect(app.auth.state()).toMatchObject({
		status: "awaiting-scan",
		qr: { dataUrl: "data:image/png;base64,iVBORw0KGgoA" },
	});
	expect(app.secrets.size).toBe(0);
	app.dispose();
});

it("renews an expired web session with the scoped SSO cookie and checks the original UID before resuming", async () => {
	const first = host(loginReply);
	await first.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	first.dispose();
	let refreshed = false;
	const restarted = host((url, options): Reply => {
		const cookie = new Headers(options.headers).get("cookie");
		if (url.href === "https://weibo.com/") {
			if (!refreshed)
				return { status: 302, headers: { location: "https://passport.weibo.com/sso/signin" } };
			expect(cookie).toBe("SUB=renewed");
			return { body: home() };
		}
		if (url.pathname === "/sso/login.php") {
			expect(url.host).toBe("login.sina.com.cn");
			expect(cookie).toBe("ALC=long");
			return {
				body: '<meta http-equiv="refresh" content="0; url=https://passport.weibo.com/sso/crossdomain">',
			};
		}
		expect(url.href).toBe("https://passport.weibo.com/sso/crossdomain");
		refreshed = true;
		return {
			status: 302,
			headers: {
				location: "https://weibo.com/",
				"set-cookie": "SUB=renewed; Secure; Domain=weibo.com; Path=/",
			},
		};
	}, first.secrets);
	await vi.advanceTimersByTimeAsync(0);
	expect(restarted.auth.state().status).toBe("logged-in");
	expect(refreshed).toBe(true);
	restarted.dispose();
});

it("keeps saved credentials on a temporary outage and rechecks after the five-minute backoff", async () => {
	const first = host(loginReply);
	await first.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	first.dispose();
	let offline = true;
	const app = host(
		(url) => (offline ? { status: 503, body: "登录服务暂时不可用" } : loginReply(url)),
		first.secrets,
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(app.auth.state().status).toBe("confirming");
	expect(app.secrets.size).toBe(1);
	offline = false;
	await vi.advanceTimersByTimeAsync(299999);
	expect(app.fetch).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(app.auth.state().status).toBe("logged-in");
	app.dispose();
});

it("keeps the first sign-in time through a failed account check and resets it on a fresh login", async () => {
	let unavailable = false;
	const app = host((url) => {
		if (url.pathname === "/ajax/profile/info") return { status: 401 };
		if (unavailable && url.pathname === "/") return { status: 503 };
		return loginReply(url);
	});
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	const first = app.auth.state();
	expect(first.status).toBe("logged-in");
	unavailable = true;
	await app.source.searchCreators("42", new AbortController().signal);
	expect(app.auth.state().status).toBe("confirming");
	unavailable = false;
	await vi.advanceTimersByTimeAsync(300000);
	expect(app.auth.state()).toEqual(first);
	await app.auth.logout();
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(app.auth.state()).toEqual({ status: "logged-in", loggedInAt: new Date().toISOString() });
	app.dispose();
});

it("confirms the homepage UID after mobile confirmation and restores the same scoped session after restart", async () => {
	const app = host(loginReply);
	await app.auth.beginLogin();
	await vi.advanceTimersByTimeAsync(3000);
	expect(app.auth.state().status).toBe("logged-in");
	expect(app.auth.account?.()).toEqual({ name: "阿青" });
	app.dispose();
	const restarted = host((url, options) => {
		expect(url.href).toBe("https://weibo.com/");
		expect(new Headers(options.headers).get("cookie")).toBe("SUB=active");
		return loginReply(url);
	}, app.secrets);
	await vi.advanceTimersByTimeAsync(0);
	expect(restarted.auth.state().status).toBe("logged-in");
	expect(restarted.auth.account?.()).toEqual({ name: "阿青" });
	expect(await restarted.auth.logout()).toEqual({ ok: true });
	expect(restarted.secrets.size).toBe(0);
	restarted.dispose();
});
