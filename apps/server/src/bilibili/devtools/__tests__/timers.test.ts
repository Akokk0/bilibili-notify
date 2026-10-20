import { describe, expect, it, vi } from "vite-plus/test";
import { DevParamError } from "../../../devtools/registry.js";
import type { SubPick } from "../live.js";
import { biliTimerScenarios } from "../timers.js";
import { biliRegistry } from "./support/registry.js";

/**
 * B 站的三个「现在就跑」:动态检测、粉丝轮询、登录心跳。直播复推已搬进核心定时组。
 */

const SUBS: SubPick[] = [
	{ id: "s1", uid: "100", name: "甲", enabled: true, roomId: "5050" },
	{ id: "s2", uid: "200", name: "乙", enabled: false, roomId: "6060" },
];

function setup(over: Partial<Parameters<typeof biliTimerScenarios>[0]> = {}) {
	const detectNow = vi.fn(async () => {});
	const pollNow = vi.fn(async () => true);
	const healthCheckNow = vi.fn(async () => true);
	const reg = biliRegistry(
		biliTimerScenarios({
			subs: () => SUBS,
			dynamic: () => ({ detectNow }),
			fans: () => ({ pollNow }),
			healthCheck: () => ({ healthCheckNow }),
			...over,
		}),
	);
	return { reg, detectNow, pollNow, healthCheckNow };
}

describe("B 站的现在就跑", () => {
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
		const { reg } = setup({ dynamic: () => undefined });
		await expect(reg.run("bilibili.dynamic.detect-now", {})).rejects.toBeInstanceOf(DevParamError);
	});

	it("三个都在定时组", () => {
		const { reg } = setup();
		const timers = reg
			.list()
			.filter((d) => d.group === "timer")
			.map((d) => d.id);
		expect(timers).toEqual([
			"bilibili.dynamic.detect-now",
			"bilibili.fans.poll-now",
			"bilibili.auth.health-now",
		]);
	});
});
