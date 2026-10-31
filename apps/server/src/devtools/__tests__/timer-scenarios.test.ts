import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createDevClock } from "../clock.js";
import { timerScenarios } from "../scenarios/timers.js";
import { coreDevRegistry } from "./support/core-registry.js";

/**
 * 免扰时钟(单点覆盖「当作现在是 hh:mm」)、静音(真调 muteFor)、Chrome 空闲关、直播复推。这些都不是
 * 假时钟:只覆盖一处判定,或者把定时器到点要做的事提前调一次。B 站其余「现在就跑」在
 * `bilibili/devtools/__tests__/timers.test.ts`。
 */

function setup(over: Partial<Parameters<typeof timerScenarios>[0]> = {}) {
	const timezone = over.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
	const clock = createDevClock(timezone);
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
	const pollNow = vi.fn(async () => true);
	const tickNow = vi.fn(async (subscriptionId: string) => subscriptionId === "s1");
	const reg = coreDevRegistry(
		timerScenarios({
			clock,
			timezone,
			mute: () => mute,
			puppeteer: () => ({ closeIdleNow }),
			profileRefresh: () => ({ pollNow }),
			subscriptions: () => [
				{ id: "s1", enabled: true, name: "甲" },
				{ id: "s2", enabled: false, name: "乙" },
			],
			session: () => ({ tickNow }),
			...over,
		}),
	);
	return { reg, clock, mute, closeIdleNow, pollNow, tickNow };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(2026, 8, 6, 15, 30, 0));
});
afterEach(() => {
	vi.useRealTimers();
});

describe("core.push.quiet-clock", () => {
	it("默认真时钟;当作 03:15 之后 now() 的时分换掉、日期不变;收摊回真", async () => {
		const { reg, clock } = setup();
		expect(clock.now().getHours()).toBe(15);

		const res = await reg.run("core.push.quiet-clock", { time: "03:15" });
		const at = clock.now();
		expect([at.getHours(), at.getMinutes()]).toEqual([3, 15]);
		expect(at.getDate()).toBe(6);
		expect(res).toMatchObject({
			ok: true,
			active: [
				{
					scenarioId: "core.push.quiet-clock",
					label: expect.stringContaining("免扰时钟 → 请求 03:15；实际 2026-09-06 03:15"),
				},
			],
		});

		reg.reset("core.push.quiet-clock");
		expect(clock.now().getHours()).toBe(15);
	});

	it("时间格式不对就拒", async () => {
		const { reg } = setup();
		await expect(reg.run("core.push.quiet-clock", { time: "3点" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: "时间要写成 HH:mm,如 03:00",
		});
		await expect(reg.run("core.push.quiet-clock", { time: "25:00" })).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: "时间要写成 HH:mm,如 03:00",
		});
	});
});

describe("core.push.mute", () => {
	it("静音 N 分钟走真的 muteFor;生效条报到期时刻;收摊 = muteFor(0)", async () => {
		const { reg, mute } = setup();
		const res = await reg.run("core.push.mute", { minutes: 10 });
		expect(mute.muteFor).toHaveBeenCalledWith(600_000);
		expect(res).toMatchObject({
			ok: true,
			active: [
				{
					scenarioId: "core.push.mute",
					label: expect.stringContaining("静音中 → 到 2026-09-06 15:40"),
				},
			],
		});

		await reg.reset("core.push.mute");
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
		await reg.run("core.push.mute", { minutes: 10 });
		await mute.muteFor(60 * 60_000); // 主人接着自己又 /mute 了一次,盖掉了我们那次
		mute.muteFor.mockClear();

		expect(reg.active()).toEqual([]);
		await reg.reset("core.push.mute");
		expect(mute.muteFor).not.toHaveBeenCalled();
		expect(mute.isMuted()).toBe(true);
	});

	it("没按过静音时收摊:一个字节都不写 —— patchGlobals 没有空转短路,写了就落盘 + 广播", async () => {
		const { reg, mute } = setup();
		await reg.reset();
		expect(mute.muteFor).not.toHaveBeenCalled();
	});

	it("推送链路还没起来 → 拒", async () => {
		const { reg } = setup({ mute: () => undefined });
		await expect(reg.run("core.push.mute", {})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
			message: "推送链路还没起来",
		});
	});
});

describe("现在就跑", () => {
	it("chrome.idle-now:关了 / 没得关 两种回执", async () => {
		const { reg, closeIdleNow } = setup();
		expect(await reg.run("core.chrome.idle-now", {})).toMatchObject({
			ok: true,
			summary: expect.stringMatching(/已关/),
		});
		closeIdleNow.mockResolvedValueOnce(false);
		expect(await reg.run("core.chrome.idle-now", {})).toMatchObject({
			ok: true,
			summary: expect.stringMatching(/没有|不动/),
		});
		const off = setup({ puppeteer: () => null });
		await expect(off.reg.run("core.chrome.idle-now", {})).resolves.toMatchObject({
			ok: false,
			code: "invalid",
		});
	});

	it("live.repush-now:按订阅 id 调场次的 tickNow", async () => {
		const { reg, tickNow } = setup();
		expect(await reg.run("core.live.repush-now", {})).toMatchObject({
			ok: true,
			summary: expect.stringMatching(/甲/),
		});
		expect(tickNow).toHaveBeenCalledWith("s1");
		expect(await reg.run("core.live.repush-now", { sub: "s2" })).toMatchObject({
			ok: true,
			summary: expect.stringMatching(/没在播|没监听/),
		});
	});

	it("profiles.refresh-now:调资料刷新把手的 pollNow", async () => {
		const { reg, pollNow } = setup();
		await reg.run("core.profiles.refresh-now", {});
		expect(pollNow).toHaveBeenCalledOnce();
	});

	it("五个都在定时组", () => {
		const { reg } = setup();
		const timers = reg
			.list()
			.filter((d) => d.group === "timer")
			.map((d) => d.id);
		expect(timers).toEqual([
			"core.push.quiet-clock",
			"core.push.mute",
			"core.chrome.idle-now",
			"core.live.repush-now",
			"core.profiles.refresh-now",
		]);
	});
});

describe("configured dev clock wall time", () => {
	it("shows the requested and normalized actual time in a DST gap", async () => {
		vi.setSystemTime(new Date("2026-03-08T05:30:00Z"));
		const { reg, clock } = setup({ timezone: () => "America/New_York" });
		const result = await reg.run("core.push.quiet-clock", { time: "02:30" });
		expect(clock.now().toISOString()).toBe("2026-03-08T07:30:00.000Z");
		expect(clock.pretended()).toBe("02:30");
		expect(result).toMatchObject({
			summary: "请求 02:30；实际 2026-03-08 03:30（America/New_York UTC-04:00）",
		});
		expect(reg.active()[0]?.label).toContain("2026-03-08 03:30（America/New_York UTC-04:00）");
		await reg.reset();
		expect(clock.now().toISOString()).toBe("2026-03-08T05:30:00.000Z");
	});
	it("selects the overlapping instance from the current offset and re-reads timezone", async () => {
		vi.setSystemTime(new Date("2026-11-01T04:30:00Z"));
		let timezone = "America/New_York";
		const { reg, clock } = setup({ timezone: () => timezone });
		await reg.run("core.push.quiet-clock", { time: "01:30" });
		expect(clock.now().toISOString()).toBe("2026-11-01T05:30:00.000Z");
		vi.setSystemTime(new Date("2026-11-01T07:30:00Z"));
		expect(clock.now().toISOString()).toBe("2026-11-01T06:30:00.000Z");
		expect(reg.active()[0]?.label).toContain("UTC-05:00");
		timezone = "Asia/Kathmandu";
		expect(clock.now().toISOString()).toBe("2026-10-31T19:45:00.000Z");
		expect(reg.active()[0]?.label).toContain("Asia/Kathmandu UTC+05:45");
		vi.setSystemTime(new Date("2026-11-02T07:30:00Z"));
		expect(clock.now().toISOString()).toBe("2026-11-01T19:45:00.000Z");
	});
});
