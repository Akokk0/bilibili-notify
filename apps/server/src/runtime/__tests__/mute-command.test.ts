/**
 * `/mute` —— 指令这一层:改状态,然后告诉主人几点恢复。
 *
 * 回复里**必须有恢复时刻**。只回一句「好的」的话,静音是个无声的状态:主人过一会儿
 * 发现没推送,分不清是自己静音了还是系统挂了 —— 而这两件事的处理方式完全相反。
 *
 * 时区:这个文件把 TZ 钉成 UTC 再跑,断言才有确定答案。测试机 / CI 的本地时区不该
 * 决定断言能不能过。
 */

process.env.TZ = "UTC";

import { describe, expect, it } from "vite-plus/test";
import { recordingCtx } from "../../__tests__/support/command-ctx.js";
import { i18n } from "../../i18n/index.js";
import { createMuteCommand } from "../mute-command.js";
import { createMuteState } from "../mute-state.js";

/** 2026-08-11T18:00:00Z。+3h 还在同一天,+10h 跨到次日。 */
const T0 = Date.UTC(2026, 7, 11, 18, 0, 0);
const HOUR = 3600_000;

function setup() {
	let stored = 0;
	let now = T0;
	let timezone = "UTC";
	const replies: string[] = [];
	const ctx = recordingCtx(replies);
	const state = createMuteState({
		read: () => stored,
		write: async (v) => {
			stored = v;
		},
		now: () => now,
	});
	const spec = createMuteCommand({
		muteState: state,
		timezone: () => timezone,
		now: () => now,
	});
	return {
		spec,
		state,
		replies,
		travelTo: (t: number) => (now = t),
		setTimezone: (value: string) => {
			timezone = value;
		},
		mute: (ms: number) => spec.run({ duration: ms } as never, ctx),
	};
}

describe("mute 指令", () => {
	it("主名是英文,中文走别名", () => {
		const { spec } = setup();
		expect(spec.name).toBe("mute");
		expect(spec.aliases).toContain("静音");
		expect(spec.aliases).toContain("免打扰");
	});

	it("敲了就真的静音了", async () => {
		const { state, mute } = setup();
		await mute(3 * HOUR);
		expect(state.isMuted()).toBe(true);
	});

	// 只回「好的」的话,主人过会儿发现没推送,分不清是自己静音了还是系统挂了。
	it("回复里带恢复时刻", async () => {
		const { replies, mute } = setup();
		await mute(3 * HOUR);
		expect(replies).toHaveLength(1);
		expect(replies[0]).toContain("21:00");
	});

	// 跨天时只说「04:00 恢复」会被读成今天凌晨 4 点 —— 那是**已经过去**的时刻。
	it("跨到第二天 → 把日期也说出来", async () => {
		const { replies, mute } = setup();
		await mute(10 * HOUR);
		expect(replies[0]).toContain("8 月 12 日");
		expect(replies[0]).toContain("04:00");
	});

	it("同一天内不啰嗦日期", async () => {
		const { replies, mute } = setup();
		await mute(3 * HOUR);
		expect(replies[0]).not.toContain("月");
	});

	// 静音期间照样会收到运行错误告警(那条路径不归静音管)。不提一句的话,主人收到
	// 报错会以为静音坏了。
	it("说清楚出错还是会叫他", async () => {
		const { replies, mute } = setup();
		await mute(3 * HOUR);
		expect(replies[0]).toContain("出错");
	});

	it("静音 0 → 解除,回复也换成解除的说法", async () => {
		const { state, replies, mute } = setup();
		await mute(3 * HOUR);
		await mute(0);
		expect(state.isMuted()).toBe(false);
		expect(replies[1]).toContain("恢复");
		// 解除时没有「恢复时刻」可言,别把 1970 年那个时刻印出来。
		expect(replies[1]).not.toContain("1970");
		expect(replies[1]).not.toContain("00:00");
	});

	it("再敲一次以最后一次为准,回复的是新的恢复时刻", async () => {
		const { replies, mute } = setup();
		await mute(10 * HOUR);
		await mute(3 * HOUR);
		expect(replies[1]).toContain("21:00");
		expect(replies[1]).not.toContain("月");
	});
});

it("reads timezone when replying and compares local calendar days", async () => {
	const s = setup();
	s.travelTo(Date.parse("2026-08-11T15:00:00Z"));
	await s.mute(3 * HOUR);
	expect(s.replies[0]).toContain("18:00");
	s.setTimezone("Asia/Shanghai");
	await s.mute(3 * HOUR);
	expect(s.replies[1]).toContain("8 月 12 日 02:00");
});

it("takes descriptions and replies from the current plain or maid layer", async () => {
	const previous = i18n.state();
	const s = setup();
	try {
		i18n.set({ locale: "zh-CN", voice: "plain" });
		expect(s.spec.description).toBe("暂时停止订阅推送，到期自动恢复");
		await s.mute(3 * HOUR);
		expect(s.replies[0]).toBe("21:00 前暂停订阅推送；错误通知仍会发送。");
		i18n.set({ locale: "zh-CN", voice: "maid" });
		expect(s.spec.description).toBe("安静一会儿，到点自动恢复");
		await s.mute(3 * HOUR);
		expect(s.replies[1]).toBe("好的主人，21:00 之前不打扰你～（出错了还是会叫你的）");
	} finally {
		i18n.set(previous);
	}
});

it("keeps all built-in input aliases while changing only displayed aliases", () => {
	const { spec } = setup();
	const state = i18n.state();
	try {
		for (const locale of ["zh-CN", "zh-TW", "en", "ja"] as const) {
			i18n.set({ locale });
			expect(spec.aliases).toEqual(
				expect.arrayContaining(["静音", "免打扰", "靜音", "勿擾", "ミュート"]),
			);
		}
		expect(spec.displayAliases).toEqual(["ミュート"]);
		expect(spec.signature).toBe("<duration:duration>");
	} finally {
		i18n.set({ locale: state.locale, voice: state.voice });
	}
});
