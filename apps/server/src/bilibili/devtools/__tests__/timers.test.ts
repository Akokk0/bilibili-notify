import { describe, expect, it, vi } from "vite-plus/test";
import { DevParamError } from "../../../devtools/registry.js";
import type { SubPick } from "../live.js";
import { biliTimerScenarios } from "../timers.js";
import { biliRegistry } from "./support/registry.js";

/**
 * B 站的两个「现在就跑」:动态检测、登录心跳。资料刷新与直播复推在核心定时组。
 */

const SUBS: SubPick[] = [
	{ id: "s1", uid: "100", name: "甲", enabled: true },
	{ id: "s2", uid: "200", name: "乙", enabled: false },
];

function setup(over: Partial<Parameters<typeof biliTimerScenarios>[0]> = {}) {
	const detectNow = vi.fn(async () => {});
	const healthCheckNow = vi.fn(async () => true);
	const reg = biliRegistry(
		biliTimerScenarios({
			subs: () => SUBS,
			dynamic: () => ({ detectNow }),
			healthCheck: () => ({ healthCheckNow }),
			...over,
		}),
	);
	return { reg, detectNow, healthCheckNow };
}

describe("B 站的现在就跑", () => {
	it("dynamic.detect-now / auth.health-now 各调各的口", async () => {
		const { reg, detectNow, healthCheckNow } = setup();
		await reg.run("bilibili.dynamic.detect-now", {});
		await reg.run("bilibili.auth.health-now", {});
		expect(detectNow).toHaveBeenCalledOnce();
		expect(healthCheckNow).toHaveBeenCalledOnce();
	});

	it("引擎还没起来 → 拒", async () => {
		const { reg } = setup({ dynamic: () => undefined });
		await expect(reg.run("bilibili.dynamic.detect-now", {})).rejects.toBeInstanceOf(DevParamError);
	});

	it("两个都在定时组", () => {
		const { reg } = setup();
		const timers = reg
			.list()
			.filter((d) => d.group === "timer")
			.map((d) => d.id);
		expect(timers).toEqual(["bilibili.dynamic.detect-now", "bilibili.auth.health-now"]);
	});
});
