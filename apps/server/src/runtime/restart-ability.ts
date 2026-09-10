/**
 * 按下「重启」之后,还回得来吗。
 *
 * 重启这件事本身只有一步:**优雅停机 + 退 0**(与应用更新完全同一条路,见 index.ts)。
 * 把它拉起来的从来是外面那位 —— 桌面外壳、容器的 `restart:` 策略、或者没有。所以这个
 * 判据问的不是「BN 会不会关」(一定会),而是「关了之后有没有人管」。
 *
 * 🔴 **判错的代价不对称**:说能、其实没人拉 = 用户按一下就把 BN 关了,而界面上只会显示
 * 连不上;说不能、其实拉得起来 = 少一个按钮。所以拿不准的一律算不能。
 */

import { existsSync } from "node:fs";
import type { RestartAbility } from "@bilibili-notify/contract";
import { resolveExpectedParent } from "./parent-watch.js";

export interface RestartAbilityInput {
	/** 桌面外壳传的 `BN_PARENT_PID` —— 有个看得懂的值就说明壳在盯着这个 sidecar。 */
	parentPid?: string;
	/** tsx 直跑源码(开发版)。判据与 devtools 那道门同一个:入口是不是 `.ts`。 */
	sourceRun: boolean;
	/** 在容器里。 */
	inContainer: boolean;
}

export function resolveRestartAbility(input: RestartAbilityInput): RestartAbility {
	// 壳优先:它是唯一一个**明确承诺**见 0 就拉起的(apps/desktop 的 sidecar_exit_disposition),
	// 而且开发版也可能跑在壳里(dev:desktop)—— 判的是有没有人拉,不是哪种构建。
	if (resolveExpectedParent(input.parentPid) !== null) return { can: true, how: "desktop" };
	// tsx watch 见子进程退出只会停在那儿等文件变(2026-09-10 实测)。
	if (input.sourceRun) return { can: false, reason: "source-run" };
	if (input.inContainer) return { can: true, how: "container" };
	return { can: false, reason: "unsupervised" };
}

/**
 * 在容器里吗。`/.dockerenv` 是 Docker 自己放的标记文件,不需要读 cgroup 也不需要环境变量
 * (环境变量得改 Dockerfile,而老镜像上的用户永远不会有那一格)。
 *
 * ⚠️ 它答的是「在不在容器里」,**不是「配没配 `restart:` 策略」** —— 那一格从进程里看不见,
 * 所以按钮旁边那句提醒不能省。
 */
export function runningInContainer(): boolean {
	return existsSync("/.dockerenv");
}
