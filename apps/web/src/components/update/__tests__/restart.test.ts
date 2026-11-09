// @vitest-environment jsdom
/**
 * 「立即重启并应用」按下去之后,页面自己去确认服务换没换成。
 *
 * 守的是三件事:只认 `startedAt` 变了的回答(旧进程还在排空时也能连上,那不算重启);
 * 起来了但版本不对要如实说是回落了;等到截止时间就放弃 —— 按时间算,不按次数。
 */

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../i18n";
import {
	awaitRestartedServer,
	leaveRestartMark,
	type RestartMark,
	restartNotice,
	takeRestartMark,
} from "../restart";
import { healthScript, NEW, OLD } from "./health-script";

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

describe("awaitRestartedServer", () => {
	it("旧进程排空期间的回答不算数:startedAt 没变就继续等,变了且版本对上 → switched", async () => {
		const clock = fakeClock();
		const health = healthScript("offline", OLD, "offline", NEW);

		const outcome = await awaitRestartedServer({
			before: OLD.startedAt,
			target: "0.9.0",
			probe: health.next,
			intervalMs: 1_000,
			timeoutMs: 90_000,
			...clock,
		});

		expect(outcome).toEqual({ kind: "switched", version: "0.9.0" });
		// 第二次那个「连上了」的回答是旧进程,必须被跳过 —— 否则第 2 次就停了。
		expect(health.calls()).toBe(4);
	});

	it("新进程起来了但版本不是目标 → fell-back,带着实际跑起来的版本", async () => {
		const clock = fakeClock();
		const health = healthScript("offline", { version: "0.8.0", startedAt: NEW.startedAt });

		const outcome = await awaitRestartedServer({
			before: OLD.startedAt,
			target: "0.9.0",
			probe: health.next,
			intervalMs: 1_000,
			timeoutMs: 90_000,
			...clock,
		});

		expect(outcome).toEqual({ kind: "fell-back", version: "0.8.0" });
	});

	it("到截止时间还没回来 → timed-out;按时间算,不按次数", async () => {
		const clock = fakeClock();
		const health = healthScript("offline");

		const outcome = await awaitRestartedServer({
			before: OLD.startedAt,
			target: "0.9.0",
			probe: health.next,
			intervalMs: 1_000,
			timeoutMs: 3_500,
			...clock,
		});

		expect(outcome).toEqual({ kind: "timed-out" });
		// t = 0 / 1000 / 2000 / 3000 各探一次都没到点,4000 那次探完才过线:5 次。
		expect(health.calls()).toBe(5);
		expect(clock.now()).toBe(4_000);
	});
});

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

describe("重启记号", () => {
	it.each([
		[
			"ja",
			"ご主人様、BNが戻りましたよ。引き続き0.9.0で動いています。",
			"ご主人様、再起動が完了し、このバージョンで動いていますよ。再び更新したいときは「システム」で「更新を確認」を選んでくださいね。",
		],
		[
			"zh-TW",
			"主人，BN 回來了，仍使用 0.9.0 版喔。",
			"主人，重新啟動完成，目前使用的就是這個版本喔。想再次更新時，請到「系統」點選「檢查更新」。",
		],
	] as const)("%s 女仆重启通知不把原版本说成更新", (locale, restartBody, rollbackBody) => {
		i18n.set({ locale, voice: "maid" });
		expect(restartNotice({ target: "0.9.0", mode: "restart" })).toMatchObject({
			id: "restarted:0.9.0",
			body: restartBody,
		});
		expect(restartNotice({ target: "0.9.0", mode: "rollback" })).toMatchObject({
			id: "restarted:0.9.0",
			body: rollbackBody,
		});
	});

	it.each([
		[
			"en",
			["Restarted", "Rolled back to 0.9.0", "Updated to 0.9.0"],
			[
				"BN is back, still running version 0.9.0.",
				"Restart complete. This version is now running. To update again, choose “Check for updates” in System.",
				"Restart complete. This version is now running.",
			],
		],
		[
			"ja",
			["再起動しました", "0.9.0にロールバックしました", "0.9.0に更新しました"],
			[
				"BNが再起動しました。引き続きバージョン0.9.0で動作しています。",
				"再起動が完了し、このバージョンで動作しています。再び更新するには、「システム」で「更新を確認」を選んでください。",
				"再起動が完了し、このバージョンで動作しています。",
			],
		],
		[
			"zh-TW",
			["已重新啟動", "已回復至 0.9.0", "已更新至 0.9.0"],
			[
				"BN 已重新啟動，仍使用 0.9.0 版。",
				"重新啟動完成，目前使用這個版本。若要再次更新，請到「系統」選擇「檢查更新」。",
				"重新啟動完成，目前使用這個版本。",
			],
		],
	] as const)(
		"%s distinguishes restart, rollback and update without changing notice identities",
		(locale, titles, bodies) => {
			i18n.set({ locale, voice: "plain" });
			for (const [index, mode] of (["restart", "rollback", "update"] as const).entries()) {
				expect(restartNotice({ target: "0.9.0", mode })).toEqual({
					id: "restarted:0.9.0",
					title: titles[index],
					body: bodies[index],
				});
			}
		},
	);
	afterEach(() => {
		sessionStorage.clear();
	});

	it("留下的记号只能取一次 —— 刷新后说一句就够了,再刷新不该又说一遍", () => {
		leaveRestartMark({ target: "0.9.0", mode: "update" });
		expect(takeRestartMark()).toEqual({ target: "0.9.0", mode: "update" });
		expect(takeRestartMark()).toBeNull();
	});

	/**
	 * 🔴 系统页「重启一下」按出来的那次**什么都没换**。刷新回来照旧说「已更新到 0.10.1」
	 * 的话,用户会以为自己刚升过级 —— 而 CHANGELOG 里那一版他早就跑着了。
	 */
	it("纯重启回来说的是「已重启」,不是「已更新到」", () => {
		leaveRestartMark({ target: "0.10.1", mode: "restart" });
		const mark = takeRestartMark();
		expect(mark).toEqual({ target: "0.10.1", mode: "restart" });
		expect(restartNotice(mark as RestartMark).title).toBe("已重启");
	});

	it("记号被写坏了就当没有,别让一条坏字符串把整个面板炸掉", () => {
		sessionStorage.setItem("bn.update.restarted", "{not json");
		expect(takeRestartMark()).toBeNull();
		sessionStorage.setItem("bn.update.restarted", JSON.stringify({ target: 1, mode: "x" }));
		expect(takeRestartMark()).toBeNull();
	});
});
