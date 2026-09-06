import { BiliLoginStatus } from "@bilibili-notify/api";
import type { LoginSnapshot } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { createNodeMessageBus } from "../../runtime/message-bus.js";
import { overridableApi } from "../api-overrides.js";
import { createDevRegistry } from "../registry.js";
import { loginStateScenario } from "../scenarios/login-state.js";

/**
 * B2:扫码登录六态。面板从两处读登录快照:`GET /api/auth/status`(authSystem.status())与
 * WS auth 频道的 `login-status-report`。注入 = 两处一起换:status() 盖掉 + 往总线上发一条
 * 同样的快照;收摊 = 摘掉 + 把真快照再发一遍。
 */

const REAL: LoginSnapshot = {
	status: BiliLoginStatus.LOGGED_IN,
	msg: "",
	data: { card: { name: "真的" } },
};

function setup() {
	const bus = createNodeMessageBus();
	const reports: LoginSnapshot[] = [];
	bus.on("login-status-report", (s) => reports.push(s));
	const auth = overridableApi({ status: () => REAL });
	const reg = createDevRegistry([loginStateScenario({ auth, bus })]);
	return { reg, reports, status: () => auth.api.status() };
}

describe("auth.login-state", () => {
	it("六态都在枚举里", () => {
		const { reg } = setup();
		const p = reg.list()[0]?.params.find((x) => x.key === "status");
		expect(p?.kind === "enum" && p.options.map((o) => o.value)).toEqual([
			"not-login",
			"loading",
			"qr",
			"logging",
			"logged-in",
			"failed",
		]);
	});

	it("等待扫码:status() 与总线报同一份,data 是一张能显示的二维码图", async () => {
		const { reg, reports, status } = setup();
		await reg.run("auth.login-state", { status: "qr" });
		const snap = status();
		expect(snap.status).toBe(BiliLoginStatus.LOGIN_QR);
		expect(typeof snap.data).toBe("string");
		expect(String(snap.data)).toMatch(/^data:image\/png;base64,/);
		expect(reports).toEqual([snap]);
	});

	it("已登录:data 带一张用户卡(名字 / 头像 / mid)", async () => {
		const { reg, status } = setup();
		await reg.run("auth.login-state", { status: "logged-in", uname: "假账号" });
		expect(status()).toMatchObject({
			status: BiliLoginStatus.LOGGED_IN,
			data: { card: { name: "假账号", face: expect.any(String), mid: expect.any(String) } },
		});
	});

	it("登录失败:msg 是给的那句", async () => {
		const { reg, status } = setup();
		await reg.run("auth.login-state", { status: "failed", message: "二维码过期了" });
		expect(status()).toMatchObject({ status: BiliLoginStatus.LOGIN_FAILED, msg: "二维码过期了" });
	});

	it("正在登录保留二维码图(与真流程一致);未登录 / 加载中不带 data", async () => {
		const { reg, status } = setup();
		await reg.run("auth.login-state", { status: "logging" });
		expect(status()).toMatchObject({ status: BiliLoginStatus.LOGGING_QR });
		expect(String(status().data)).toMatch(/^data:image/);
		await reg.run("auth.login-state", { status: "not-login" });
		expect(status()).toEqual({ status: BiliLoginStatus.NOT_LOGIN, msg: expect.any(String) });
		await reg.run("auth.login-state", { status: "loading" });
		expect(status().status).toBe(BiliLoginStatus.LOADING_LOGIN_INFO);
	});

	it("生效条与收摊:收摊后 status() 回真的,总线上再报一遍真快照", async () => {
		const { reg, reports, status } = setup();
		await reg.run("auth.login-state", { status: "qr" });
		expect(reg.active()).toEqual([
			{ scenarioId: "auth.login-state", label: "登录状态 → 等待扫码" },
		]);
		expect(await reg.reset("auth.login-state")).toEqual([]);
		expect(status()).toBe(REAL);
		expect(reports.at(-1)).toBe(REAL);
	});
});
