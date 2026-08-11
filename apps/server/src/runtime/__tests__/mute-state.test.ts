/**
 * 静音状态 —— 「到期自动恢复」的那个判定。
 *
 * 核心取舍:**读时判定,不用定时器**。定时器要处理重启(进程一死定时器就没了,静音
 * 再也解不掉)、时钟跳变、dispose 时序;而 `now < until` 这一个比较天然对以上全部
 * 免疫 —— 到期不是一个「发生」的事件,只是判定结果变了。
 *
 * 所以这里的测试全部是「把时钟拨到某处,问现在静音吗」,一个定时器都不该出现。
 */

import { describe, expect, it } from "vite-plus/test";
import { createMuteState } from "../mute-state.js";

const T0 = 1_700_000_000_000;
const HOUR = 3600_000;

/** 内存版的存放处。独立端真实实现落 globals.json。 */
function fakeStore(initial = 0) {
	let value = initial;
	const writes: number[] = [];
	return {
		read: () => value,
		write: async (v: number) => {
			value = v;
			writes.push(v);
		},
		writes,
	};
}

function setup(opts: { initial?: number; at?: number } = {}) {
	const store = fakeStore(opts.initial ?? 0);
	let now = opts.at ?? T0;
	const state = createMuteState({
		read: store.read,
		write: store.write,
		now: () => now,
	});
	return { state, store, travelTo: (t: number) => (now = t) };
}

describe("createMuteState", () => {
	it("没静音过 → 不静音", () => {
		const { state } = setup();
		expect(state.isMuted()).toBe(false);
		expect(state.mutedUntil()).toBe(0);
	});

	it("静音 3 小时 → 现在是静音的,到期时刻是 now + 3h", async () => {
		const { state } = setup();
		await state.muteFor(3 * HOUR);
		expect(state.isMuted()).toBe(true);
		expect(state.mutedUntil()).toBe(T0 + 3 * HOUR);
	});

	it("到期前一毫秒 → 还是静音的", async () => {
		const { state, travelTo } = setup();
		await state.muteFor(3 * HOUR);
		travelTo(T0 + 3 * HOUR - 1);
		expect(state.isMuted()).toBe(true);
	});

	// 边界:到期那一刻算解除,不算还在静音。差一个等号就是「说好 3 点恢复,3 点整那条
	// 推送还是被吞了」—— 而这种差一毫秒的事只会偶发,现场根本抓不到。
	it("恰好到期那一刻 → 已经不静音了", async () => {
		const { state, travelTo } = setup();
		await state.muteFor(3 * HOUR);
		travelTo(T0 + 3 * HOUR);
		expect(state.isMuted()).toBe(false);
	});

	it("过了到期时刻 → 不静音,不需要谁来「解除」", async () => {
		const { state, travelTo } = setup();
		await state.muteFor(3 * HOUR);
		travelTo(T0 + 4 * HOUR);
		expect(state.isMuted()).toBe(false);
	});

	// 容器重启是这个部署的常态。定时器方案在这里必然漏:进程一死,那个 setTimeout
	// 就没了,静音要么永远解不掉,要么启动时得重建一套恢复逻辑。读时判定零成本。
	it("重启后:存着的到期时刻还在未来 → 依然静音,无需任何恢复动作", () => {
		const { state } = setup({ initial: T0 + HOUR });
		expect(state.isMuted()).toBe(true);
	});

	it("重启后:存着的到期时刻已过 → 不静音", () => {
		const { state } = setup({ initial: T0 - HOUR });
		expect(state.isMuted()).toBe(false);
	});

	// 以最后一次为准,不取 max —— 主人敲了「静音 10 分钟」就是想把 3 小时那次缩短,
	// 取 max 会让他觉得指令没生效。
	it("再敲一次以最后一次为准,缩短也生效", async () => {
		const { state } = setup();
		await state.muteFor(3 * HOUR);
		await state.muteFor(10 * 60_000);
		expect(state.mutedUntil()).toBe(T0 + 10 * 60_000);
	});

	// `mute 0m` 就是解除 —— 读时判定下 until=now 天然不静音,不用为「解除」开一条路径。
	it("静音 0 → 解除,而且存回 0 而不是当前时刻", async () => {
		const { state, store } = setup();
		await state.muteFor(3 * HOUR);
		await state.muteFor(0);
		expect(state.isMuted()).toBe(false);
		// 存 0 是为了让 globals.json 里躺着的值一眼可读:0 = 没静音,别的 = 到期时刻。
		expect(store.writes.at(-1)).toBe(0);
	});

	it("到期时刻是写出去的,不是只留在内存里", async () => {
		const { state, store } = setup();
		await state.muteFor(HOUR);
		expect(store.writes).toEqual([T0 + HOUR]);
	});
});
