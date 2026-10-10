import { describe, expect, it, vi } from "vite-plus/test";
import { DevParamError } from "../../../devtools/registry.js";
import type { SubPick } from "../live.js";
import { biliTimerScenarios } from "../timers.js";
import { biliRegistry } from "./support/registry.js";

/**
 * B 站的四个「现在就跑」:复推提前到期、动态检测、粉丝轮询、登录心跳 —— 把定时器到点要做的事
 * 提前调一次,各调各的口。中立的三条(免扰时钟、静音、Chrome 空闲关)在核心的
 * `devtools/__tests__/timer-scenarios.test.ts`。
 */

const SUBS: SubPick[] = [
	{ id: "s1", uid: "100", name: "甲", enabled: true, roomId: "5050" },
	{ id: "s2", uid: "200", name: "乙", enabled: false, roomId: "6060" },
];

function setup(over: Partial<Parameters<typeof biliTimerScenarios>[0]> = {}) {
	const repushNow = vi.fn(async (uid: string) => uid === "100");
	const detectNow = vi.fn(async () => {});
	const pollNow = vi.fn(async () => true);
	const healthCheckNow = vi.fn(async () => true);
	const reg = biliRegistry(
		biliTimerScenarios({
			subs: () => SUBS,
			live: () => ({ repushNow }),
			dynamic: () => ({ detectNow }),
			fans: () => ({ pollNow }),
			loginFlow: () => ({ healthCheckNow }),
			...over,
		}),
	);
	return { reg, repushNow, detectNow, pollNow, healthCheckNow };
}

describe("B 站的现在就跑", () => {
	it("live.repush-now:按订阅 uid 调 repushNow;没在播如实说", async () => {
		const { reg, repushNow } = setup();
		expect((await reg.run("bilibili.live.repush-now", {})).summary).toMatch(/甲/);
		expect(repushNow).toHaveBeenCalledWith("100");
		expect((await reg.run("bilibili.live.repush-now", { sub: "s2" })).summary).toMatch(
			/没在播|没监听/,
		);
	});

	it("dynamic.detect-now / fans.poll-now / auth.health-now 各调各的口", async () => {
		const { reg, detectNow, pollNow, healthCheckNow } = setup();
		await reg.run("bilibili.dynamic.detect-now", {});
		await reg.run("bilibili.fans.poll-now", {});
		await reg.run("bilibili.auth.health-now", {});
		expect(detectNow).toHaveBeenCalledOnce();
		expect(pollNow).toHaveBeenCalledOnce();
		expect(healthCheckNow).toHaveBeenCalledOnce();
	});

	it("引擎还没起来 → 拒", async () => {
		const { reg } = setup({ live: () => undefined, dynamic: () => undefined });
		await expect(reg.run("bilibili.live.repush-now", {})).rejects.toBeInstanceOf(DevParamError);
		await expect(reg.run("bilibili.dynamic.detect-now", {})).rejects.toBeInstanceOf(DevParamError);
	});

	it("四个都在定时组", () => {
		const { reg } = setup();
		const timers = reg
			.list()
			.filter((d) => d.group === "timer")
			.map((d) => d.id);
		expect(timers).toEqual([
			"bilibili.live.repush-now",
			"bilibili.dynamic.detect-now",
			"bilibili.fans.poll-now",
			"bilibili.auth.health-now",
		]);
	});
});
