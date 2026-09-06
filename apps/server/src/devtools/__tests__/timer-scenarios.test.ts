import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDevClock } from "../clock.js";
import { createDevRegistry, DevParamError } from "../registry.js";
import type { SubPick } from "../scenarios/live.js";
import { timerScenarios } from "../scenarios/timers.js";

/**
 * C1–C3:免扰时钟(单点覆盖「当作现在是 hh:mm」)、静音(真调 muteFor)、五个「现在就跑」
 * (Chrome 空闲关、复推、动态检测、粉丝轮询、登录心跳)。这些都不是假时钟:只覆盖一处判定,
 * 或者把定时器到点要做的事提前调一次。
 */

const SUBS: SubPick[] = [
	{ id: "s1", uid: "100", name: "甲", enabled: true, roomId: "5050" },
	{ id: "s2", uid: "200", name: "乙", enabled: false, roomId: "6060" },
];

function setup(over: Partial<Parameters<typeof timerScenarios>[0]> = {}) {
	const clock = createDevClock();
	let mutedUntil = 0;
	const mute = {
		mutedUntil: () => mutedUntil,
		isMuted: () => Date.now() < mutedUntil,
		muteFor: vi.fn(async (ms: number) => {
			mutedUntil = ms > 0 ? Date.now() + ms : 0;
			return mutedUntil;
		}),
	};
	const closeIdleNow = vi.fn(async () => true);
	const repushNow = vi.fn(async (uid: string) => uid === "100");
	const detectNow = vi.fn(async () => {});
	const pollNow = vi.fn(async () => true);
	const healthCheckNow = vi.fn(async () => true);
	const reg = createDevRegistry(
		timerScenarios({
			clock,
			subs: () => SUBS,
			mute: () => mute,
			puppeteer: () => ({ closeIdleNow }),
			live: () => ({ repushNow }),
			dynamic: () => ({ detectNow }),
			fans: () => ({ pollNow }),
			loginFlow: () => ({ healthCheckNow }),
			...over,
		}),
	);
	return { reg, clock, mute, closeIdleNow, repushNow, detectNow, pollNow, healthCheckNow };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 6, 15, 30, 0));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("push.quiet-clock", () => {
	it("默认真时钟;当作 03:15 之后 now() 的时分换掉、日期不变;收摊回真", async () => {
		const { reg, clock } = setup();
		expect(clock.now().getHours()).toBe(15);

		const res = await reg.run("push.quiet-clock", { time: "03:15" });
		const at = clock.now();
		expect([at.getHours(), at.getMinutes()]).toEqual([3, 15]);
		expect(at.getDate()).toBe(6);
		expect(res.active).toEqual([
			{ scenarioId: "push.quiet-clock", label: "免扰时钟 → 当作现在是 03:15" },
		]);

		reg.reset("push.quiet-clock");
		expect(clock.now().getHours()).toBe(15);
	});

	it("时间格式不对就拒", async () => {
		const { reg } = setup();
		await expect(reg.run("push.quiet-clock", { time: "3点" })).rejects.toBeInstanceOf(
			DevParamError,
		);
		await expect(reg.run("push.quiet-clock", { time: "25:00" })).rejects.toBeInstanceOf(
			DevParamError,
		);
	});
});

describe("push.mute", () => {
	it("静音 N 分钟走真的 muteFor;生效条报到期时刻;收摊 = muteFor(0)", async () => {
		const { reg, mute } = setup();
		const res = await reg.run("push.mute", { minutes: 10 });
		expect(mute.muteFor).toHaveBeenCalledWith(600_000);
		expect(res.active).toEqual([{ scenarioId: "push.mute", label: "静音中 → 到 15:40" }]);

		await reg.reset("push.mute");
		expect(mute.muteFor).toHaveBeenLastCalledWith(0);
		expect(reg.active()).toEqual([]);
	});

	it("主人自己 /mute 出来的静音:不认领、不解除 —— 收摊只收 devtools 自己造的", async () => {
		// 这一条按的是真开关、写的是真配置,所以它必须记账。否则面板会把主人从私聊按出来的
		// 静音列进「当前生效」,而「全部收摊」是任何一次注入之后都会顺手按的动作 —— 一按
		// 就把人家的静音无声解掉了。
		const { reg, mute } = setup();
		await mute.muteFor(30 * 60_000); // 主人自己按的,不经 devtools
		mute.muteFor.mockClear();

		expect(reg.active()).toEqual([]);
		await reg.reset();
		expect(mute.muteFor).not.toHaveBeenCalled();
		expect(mute.isMuted()).toBe(true);
	});

	it("按过之后盘上的静音又被换掉:不再认领,收摊也不碰", async () => {
		const { reg, mute } = setup();
		await reg.run("push.mute", { minutes: 10 });
		await mute.muteFor(60 * 60_000); // 主人接着自己又 /mute 了一次,盖掉了我们那次
		mute.muteFor.mockClear();

		expect(reg.active()).toEqual([]);
		await reg.reset("push.mute");
		expect(mute.muteFor).not.toHaveBeenCalled();
		expect(mute.isMuted()).toBe(true);
	});

	it("没按过静音时收摊:一个字节都不写 —— patchGlobals 没有空转短路,写了就落盘 + 广播", async () => {
		const { reg, mute } = setup();
		await reg.reset();
		expect(mute.muteFor).not.toHaveBeenCalled();
	});

	it("引擎还没起来 → 拒", async () => {
		const { reg } = setup({ mute: () => undefined });
		await expect(reg.run("push.mute", {})).rejects.toBeInstanceOf(DevParamError);
	});
});

describe("现在就跑", () => {
	it("chrome.idle-now:关了 / 没得关 两种回执", async () => {
		const { reg, closeIdleNow } = setup();
		expect((await reg.run("chrome.idle-now", {})).summary).toMatch(/已关/);
		closeIdleNow.mockResolvedValueOnce(false);
		expect((await reg.run("chrome.idle-now", {})).summary).toMatch(/没有|不动/);
		const off = setup({ puppeteer: () => null });
		await expect(off.reg.run("chrome.idle-now", {})).rejects.toBeInstanceOf(DevParamError);
	});

	it("live.repush-now:按订阅 uid 调 repushNow;没在播如实说", async () => {
		const { reg, repushNow } = setup();
		expect((await reg.run("live.repush-now", {})).summary).toMatch(/甲/);
		expect(repushNow).toHaveBeenCalledWith("100");
		expect((await reg.run("live.repush-now", { sub: "s2" })).summary).toMatch(/没在播|没监听/);
	});

	it("dynamic.detect-now / fans.poll-now / auth.health-now 各调各的口", async () => {
		const { reg, detectNow, pollNow, healthCheckNow } = setup();
		await reg.run("dynamic.detect-now", {});
		await reg.run("fans.poll-now", {});
		await reg.run("auth.health-now", {});
		expect(detectNow).toHaveBeenCalledOnce();
		expect(pollNow).toHaveBeenCalledOnce();
		expect(healthCheckNow).toHaveBeenCalledOnce();
	});

	it("七个都在定时组", () => {
		const { reg } = setup();
		const timers = reg
			.list()
			.filter((d) => d.group === "timer")
			.map((d) => d.id);
		expect(timers).toEqual([
			"push.quiet-clock",
			"push.mute",
			"chrome.idle-now",
			"live.repush-now",
			"dynamic.detect-now",
			"fans.poll-now",
			"auth.health-now",
		]);
	});
});
