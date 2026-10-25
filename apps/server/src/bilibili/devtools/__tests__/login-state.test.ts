import type { AuthState } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { overridableApi } from "../../../devtools/api-overrides.js";
import { createNodeMessageBus } from "../../../runtime/message-bus.js";
import { loginStateScenario } from "../login-state.js";
import { fakeAuth } from "./support/fake-auth.js";
import { biliRegistry } from "./support/registry.js";

/**
 * B2:登录状态的假货。面板从两处读登录态:`GET /api/sources/:sourceKey/auth`(来源的 `auth.state()` /
 * `auth.account()`)与 WS auth 频道的 `subscription-auth-changed`。注入 = 两处一起换:`state()` / `account()`
 * 盖掉 + 往总线上发一条同样的状态;收摊 = 摘掉 + 把真状态再发一遍。
 */

const REAL: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };

function setup() {
	const bus = createNodeMessageBus();
	const reports: Array<{ sourceKey: string; state: AuthState }> = [];
	bus.on("subscription-auth-changed", (changed) => reports.push(changed));
	const auth = overridableApi(fakeAuth(REAL, { name: "真的" }));
	const reg = biliRegistry([loginStateScenario({ auth: () => auth, bus })]);
	return { reg, reports, state: () => auth.api.state(), account: () => auth.api.account() };
}

describe("bilibili.auth.login-state", () => {
	it("AuthState 的六种取值都在选项里(confirming 两种情况各一项)", () => {
		const { reg } = setup();
		const p = reg.list()[0]?.params.find((x) => x.key === "status");
		expect(p?.kind === "enum" && p.options.map((o) => o.value)).toEqual([
			"logged-out",
			"awaiting-scan",
			"confirming-scan",
			"confirming-check",
			"logged-in",
			"expired",
			"error",
		]);
	});

	it("等待扫码:state() 与总线报同一份,二维码是一张能显示的图,带来源键", async () => {
		const { reg, reports, state } = setup();
		await reg.run("bilibili.auth.login-state", { status: "awaiting-scan" });
		const s = state();
		expect(s.status).toBe("awaiting-scan");
		expect(s.status === "awaiting-scan" && s.qr.dataUrl).toMatch(/^data:image\/png;base64,/);
		expect(reports).toEqual([{ sourceKey: "bilibili", state: s }]);
	});

	it("已登录:account() 是给的账号名", async () => {
		const { reg, state, account } = setup();
		await reg.run("bilibili.auth.login-state", { status: "logged-in", uname: "假账号" });
		expect(state()).toMatchObject({ status: "logged-in" });
		expect(account()).toEqual({ name: "假账号" });
	});

	it("登录失败 / 登录失效:message 是给的那句", async () => {
		const { reg, state } = setup();
		await reg.run("bilibili.auth.login-state", { status: "error", message: "二维码过期了" });
		expect(state()).toEqual({ status: "error", message: "二维码过期了" });
		await reg.run("bilibili.auth.login-state", { status: "expired", message: "失效了" });
		expect(state()).toEqual({ status: "expired", message: "失效了" });
	});

	it("正在确认的两种情况各带各的话,不带账号;未登录也没有账号", async () => {
		const { reg, state, account } = setup();
		await reg.run("bilibili.auth.login-state", { status: "confirming-scan" });
		expect(state()).toEqual({ status: "confirming", message: "已扫码，请在手机上确认" });
		await reg.run("bilibili.auth.login-state", { status: "confirming-check" });
		expect(state()).toEqual({
			status: "confirming",
			message: "正在向 B 站确认登录状态，暂时连不上的话会自动重试",
		});
		expect(account()).toBeNull();
		await reg.run("bilibili.auth.login-state", { status: "logged-out" });
		expect(state()).toEqual({ status: "logged-out" });
	});

	it("生效条与收摊:收摊后 state() / account() 回真的,总线上再报一遍真状态", async () => {
		const { reg, reports, state, account } = setup();
		await reg.run("bilibili.auth.login-state", { status: "awaiting-scan" });
		expect(reg.active()).toEqual([
			{ scenarioId: "bilibili.auth.login-state", label: "登录状态 → 等待扫码" },
		]);
		expect(await reg.reset("bilibili.auth.login-state")).toEqual([]);
		expect(state()).toBe(REAL);
		expect(account()).toEqual({ name: "真的" });
		expect(reports.at(-1)).toEqual({ sourceKey: "bilibili", state: REAL });
	});
});
