/**
 * 「这台机器上按重启,还回得来吗」的判据。
 *
 * 🔴 **判错的代价不对称**:说能、其实没人拉 = 用户按一下就把 BN 关了,而界面上只会
 * 显示连不上(他多半以为是自己网断了);说不能、其实拉得起来 = 少一个按钮而已。
 * 所以拿不准的一律算不能。
 */

import { describe, expect, it } from "vite-plus/test";
import { resolveRestartAbility } from "../restart-ability.js";

describe("能不能重启", () => {
	it("桌面外壳在盯着 → 能:它见退出码 0 就重新拉起", () => {
		expect(
			resolveRestartAbility({ parentPid: "4242", sourceRun: false, inContainer: false }),
		).toEqual({ can: true, how: "desktop" });
	});

	/** 🔴 判据是「外面有没有人拉」,不是「哪一种构建」—— dev:desktop 的 sidecar 也是壳起的。 */
	it("开发版跑在桌面壳里 → 照样能", () => {
		expect(
			resolveRestartAbility({ parentPid: "4242", sourceRun: true, inContainer: false }),
		).toEqual({ can: true, how: "desktop" });
	});

	/** `BN_PARENT_PID` 是 1 = 一出生就是孤儿,盯着它永远不会触发 —— 当没有壳(见 parent-watch)。 */
	it("父进程 pid 看不懂 → 当没人盯着,往下接着判", () => {
		expect(resolveRestartAbility({ parentPid: "1", sourceRun: false, inContainer: true })).toEqual({
			can: true,
			how: "container",
		});
	});

	it("tsx 直跑的开发版 → 不能:tsx watch 只等文件变,进程自己退了就是退了", () => {
		expect(resolveRestartAbility({ sourceRun: true, inContainer: false })).toEqual({
			can: false,
			reason: "source-run",
		});
	});

	/** 拿不准算不能:源码跑在容器里是个没人真在用的组合,不值得为它冒「把 BN 关了」的险。 */
	it("源码跑 + 在容器里 → 还是不能", () => {
		expect(resolveRestartAbility({ sourceRun: true, inContainer: true })).toEqual({
			can: false,
			reason: "source-run",
		});
	});

	it("容器里 → 能(靠 restart: 策略,那句提醒归文案)", () => {
		expect(resolveRestartAbility({ sourceRun: false, inContainer: true })).toEqual({
			can: true,
			how: "container",
		});
	});

	it("裸 node 跑构建产物 → 退了没人管,不给按钮", () => {
		expect(resolveRestartAbility({ sourceRun: false, inContainer: false })).toEqual({
			can: false,
			reason: "unsupervised",
		});
	});
});
