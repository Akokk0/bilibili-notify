import type { AuthState } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAuthShell, loginStateScenario } from "../login-state.js";
import { fakeAuth } from "./support/fake-auth.js";
import { biliRegistry } from "./support/registry.js";

/**
 * B2:登录状态的假货。面板从两处读登录态:`GET /api/sources/:sourceKey/auth`(来源的 `auth.state()` /
 * `auth.account()`)与 WS auth 频道的 `subscription-auth-changed`。后者是宿主订了登录口的变更通知、
 * 通知来了读一遍 `state()` 发的 —— 场景拿不到总线(ADR-0031 决策 2「核心的句柄不交出去」),所以注入 =
 * `state()` / `account()` 盖掉,再替登录口喊一声「变了」;收摊 = 摘掉,再喊一声。
 *
 * 宿主订的不止总线那一条(登录问题表也订着),所以这里用一个替身宿主:订变更、来了就读一遍状态。
 */

const REAL: AuthState = { status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" };

function setup() {
	const shell = createAuthShell(fakeAuth(REAL, { name: "真的" }));
	// 宿主那头(`registerBuiltinSource`):经来源的登录口订变更,来了就读一遍状态。
	const reports: AuthState[] = [];
	const hosted = shell.api.onChange(() => reports.push(shell.api.state()));
	const reg = biliRegistry([loginStateScenario({ auth: () => shell })]);
	return {
		reg,
		reports,
		hosted,
		state: () => shell.api.state(),
		account: () => shell.api.account(),
	};
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

	it("等待扫码:state() 换了,宿主订的变更回调被叫、读到的是同一份;二维码是一张能显示的图", async () => {
		const { reg, reports, state } = setup();
		await reg.run("bilibili.auth.login-state", { status: "awaiting-scan" });
		const s = state();
		expect(s.status).toBe("awaiting-scan");
		expect(s.status === "awaiting-scan" && s.qr.dataUrl).toMatch(/^data:image\/png;base64,/);
		expect(reports).toEqual([s]);
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

	it("生效条与收摊:收摊后 state() / account() 回真的,再喊一声、宿主读到真状态", async () => {
		const { reg, reports, state, account } = setup();
		await reg.run("bilibili.auth.login-state", { status: "awaiting-scan" });
		expect(reg.active()).toEqual([
			{ scenarioId: "bilibili.auth.login-state", label: "登录状态 → 等待扫码" },
		]);
		expect(await reg.reset("bilibili.auth.login-state")).toMatchObject({ ok: true, active: [] });
		expect(state()).toBe(REAL);
		expect(account()).toEqual({ name: "真的" });
		expect(reports.at(-1)).toBe(REAL);
	});

	it("宿主撤了订阅就不再叫它", async () => {
		const { reg, reports, hosted } = setup();
		hosted.dispose();
		await reg.run("bilibili.auth.login-state", { status: "expired" });
		expect(reports).toEqual([]);
	});
});

describe("createAuthShell", () => {
	it("订变更照样订到真登录口上:真的变了照常通知;撤的时候两边一起撤", () => {
		const realDispose = vi.fn();
		const realOnChange = vi.fn(() => ({ dispose: realDispose }));
		const shell = createAuthShell({ ...fakeAuth(), onChange: realOnChange });
		const fn = vi.fn();

		const sub = shell.api.onChange(fn);
		expect(realOnChange).toHaveBeenCalledWith(fn);

		sub.dispose();
		expect(realDispose).toHaveBeenCalledOnce();
		shell.notifyChanged();
		expect(fn).not.toHaveBeenCalled();
	});

	it("摘 state 不碰订阅:摘完照样喊得到", () => {
		const shell = createAuthShell(fakeAuth(REAL));
		const fn = vi.fn();
		shell.api.onChange(fn);
		shell.override("state", () => ({ status: "logged-out" }));
		shell.clear("state");
		shell.notifyChanged();
		expect(fn).toHaveBeenCalledOnce();
		expect(shell.api.state()).toBe(REAL);
	});
});
