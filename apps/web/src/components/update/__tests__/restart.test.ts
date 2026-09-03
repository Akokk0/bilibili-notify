// @vitest-environment jsdom
/**
 * 「立即重启并应用」按下去之后,页面自己去确认服务换没换成。
 *
 * 守的是三件事:只认 `startedAt` 变了的回答(旧进程还在排空时也能连上,那不算重启);
 * 起来了但版本不对要如实说是回落了;等到截止时间就放弃 —— 按时间算,不按次数。
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	awaitRestartedServer,
	leaveRestartMark,
	type RestartProbe,
	takeRestartMark,
} from "../restart";

/** 假时钟:sleep 直接把表往前拨,now 读表。不碰真 timer。 */
function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

type Step = RestartProbe | "offline";

/** 依次回放的探测结果;走完最后一步就一直重复它。 */
function script(...steps: Step[]) {
	let i = 0;
	const probe = vi.fn(async (): Promise<RestartProbe> => {
		const step = steps[Math.min(i, steps.length - 1)];
		i += 1;
		if (step === "offline") throw new Error("连接中断");
		return step;
	});
	return probe;
}

const OLD: RestartProbe = { version: "0.8.0", startedAt: "2026-09-03T00:00:00.000Z" };
const NEW: RestartProbe = { version: "0.9.0", startedAt: "2026-09-03T00:01:00.000Z" };

describe("awaitRestartedServer", () => {
	it("旧进程排空期间的回答不算数:startedAt 没变就继续等,变了且版本对上 → switched", async () => {
		const clock = fakeClock();
		const probe = script("offline", OLD, "offline", NEW);

		const outcome = await awaitRestartedServer({
			before: OLD.startedAt,
			target: "0.9.0",
			probe,
			intervalMs: 1_000,
			timeoutMs: 90_000,
			...clock,
		});

		expect(outcome).toEqual({ kind: "switched", version: "0.9.0" });
		// 第二次那个「连上了」的回答是旧进程,必须被跳过 —— 否则第 2 次就停了。
		expect(probe).toHaveBeenCalledTimes(4);
	});

	it("新进程起来了但版本不是目标 → fell-back,带着实际跑起来的版本", async () => {
		const clock = fakeClock();
		const probe = script("offline", { version: "0.8.0", startedAt: NEW.startedAt });

		const outcome = await awaitRestartedServer({
			before: OLD.startedAt,
			target: "0.9.0",
			probe,
			intervalMs: 1_000,
			timeoutMs: 90_000,
			...clock,
		});

		expect(outcome).toEqual({ kind: "fell-back", version: "0.8.0" });
	});

	it("到截止时间还没回来 → timed-out;按时间算,不按次数", async () => {
		const clock = fakeClock();
		const probe = script("offline");

		const outcome = await awaitRestartedServer({
			before: OLD.startedAt,
			target: "0.9.0",
			probe,
			intervalMs: 1_000,
			timeoutMs: 3_500,
			...clock,
		});

		expect(outcome).toEqual({ kind: "timed-out" });
		// t = 0 / 1000 / 2000 / 3000 各探一次都没到点,4000 那次探完才过线:5 次。
		expect(probe).toHaveBeenCalledTimes(5);
		expect(clock.now()).toBe(4_000);
	});
});

describe("重启记号", () => {
	afterEach(() => {
		sessionStorage.clear();
	});

	it("留下的记号只能取一次 —— 刷新后说一句就够了,再刷新不该又说一遍", () => {
		leaveRestartMark({ target: "0.9.0", mode: "update" });
		expect(takeRestartMark()).toEqual({ target: "0.9.0", mode: "update" });
		expect(takeRestartMark()).toBeNull();
	});

	it("记号被写坏了就当没有,别让一条坏字符串把整个面板炸掉", () => {
		sessionStorage.setItem("bn.update.restarted", "{not json");
		expect(takeRestartMark()).toBeNull();
		sessionStorage.setItem("bn.update.restarted", JSON.stringify({ target: 1, mode: "x" }));
		expect(takeRestartMark()).toBeNull();
	});
});
