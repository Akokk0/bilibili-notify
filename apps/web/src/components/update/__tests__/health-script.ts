import type { RestartProbe } from "../restart";

export type HealthStep = RestartProbe | "offline";

/**
 * `/api/health` 的剧本:按顺序回放,走完最后一步就一直重复它。重启那段流程靠它
 * 演「旧进程还在 → 断了 → 新进程起来了」。`next` 不用 this,可以直接当 probe 传。
 */
export function healthScript(...steps: HealthStep[]) {
	let i = 0;
	return {
		calls: () => i,
		set(...next: HealthStep[]) {
			steps = next;
			i = 0;
		},
		async next(): Promise<RestartProbe> {
			const step = steps[Math.min(i, steps.length - 1)];
			i += 1;
			if (step === "offline") throw new Error("连接中断");
			return step;
		},
	};
}

export const OLD: RestartProbe = { version: "0.8.0", startedAt: "2026-09-03T00:00:00.000Z" };
export const NEW: RestartProbe = { version: "0.9.0", startedAt: "2026-09-03T00:01:00.000Z" };
