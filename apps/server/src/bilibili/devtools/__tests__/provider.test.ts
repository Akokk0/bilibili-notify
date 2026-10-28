import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDevtoolsProviderRegistry } from "../../../devtools/providers.js";
import type { Api } from "../../api/index.js";
import { observeLiveConnections } from "../../live/protocol/client.js";
import { type BiliDevtoolsDeps, createBiliDevtools } from "../index.js";
import { fakeAuth } from "./support/fake-auth.js";
import { biliRegistry } from "./support/registry.js";

/**
 * B 站交给 devtools 的那一包(`DevtoolsProvider`):九个场景 + 两个定时、登录状态与两个真登录场景,
 * 汇进登记表后 id 都带 `bilibili.` 前缀。
 */

/** 来源还没造好:场景要的东西一样都取不到。 */
function deps(): BiliDevtoolsDeps {
	return { source: () => undefined };
}

afterEach(() => {
	// 工厂会装全局的直播连接观察钩子;测完摘掉,别漏给同进程里的别的测试。
	observeLiveConnections(null);
});

describe("createBiliDevtools", () => {
	it("交出 B 站那十四个场景,id 不带前缀(前缀由宿主加)", () => {
		const ids = createBiliDevtools(deps()).provider.scenarios.map((s) => s.id);
		expect(ids).toEqual([
			"live.start",
			"live.end",
			"live.danmaku",
			"live.superchat",
			"live.guard",
			"live.gift",
			"live.enter",
			"dynamic.post",
			"dynamic.fail",
			"auth.login-state",
			"auth.lost",
			"auth.recheck",
			"dynamic.detect-now",
			"auth.health-now",
		]);
	});

	it("经登记表汇总:每个 id 都是 bilibili.<原 id>,一个不带前缀的也没有", () => {
		const providers = createDevtoolsProviderRegistry();
		providers.claim("bilibili", createBiliDevtools(deps()).provider);
		const ids = providers.scenarios().map((s) => s.id);
		expect(ids).toHaveLength(14);
		expect(ids.every((id) => id.startsWith("bilibili."))).toBe(true);
		expect(ids).toContain("bilibili.live.danmaku");
	});

	// 壳现在由 B 站 devtools 自己建:来源造好登录系统后把真的递进来,换回的就是场景盖得到的那一份。
	describe("devShells · 来源造好之后才有壳,场景与来源用的是同一个", () => {
		const NOT_READY = "B 站来源还没起来，先等它起来再试";

		it("登录口:来源还没递真的进来 → 场景回「还没起来」;递进来之后换回的壳被场景盖得到,收摊即回真", async () => {
			const { provider, devShells } = createBiliDevtools(deps());
			const registry = biliRegistry(provider.scenarios);
			const run = () =>
				registry.run("bilibili.auth.login-state", { status: "logged-out", uname: "", message: "" });

			await expect(run()).resolves.toMatchObject({ summary: NOT_READY });

			const real = fakeAuth({ status: "logged-in", loggedInAt: "2026-10-11T00:00:00.000Z" });
			const shell = devShells.auth(real);
			expect(shell).not.toBe(real);
			await run();
			expect(shell.state()).toEqual({ status: "logged-out" });
			expect(real.state()).toMatchObject({ status: "logged-in" });
		});

		it("Api:递进来之后换回的壳是同一个对象,没盖的方法原样透传到真的", async () => {
			const { devShells } = createBiliDevtools(deps());
			const real = { fetchAllDynamic: async () => "real" } as unknown as Api;
			const shell = devShells.api(real);
			expect(shell).not.toBe(real);
			await expect(
				(shell as unknown as { fetchAllDynamic(): Promise<string> }).fetchAllDynamic(),
			).resolves.toBe("real");
		});
	});
});
