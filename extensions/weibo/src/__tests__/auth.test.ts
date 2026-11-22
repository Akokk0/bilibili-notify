import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { home, host, loginReply, qrReply, type Reply } from "./host";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
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
