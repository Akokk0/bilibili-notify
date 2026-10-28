import { ok } from "@bilibili-notify/internal";
import { type DevScenarioDef, notReady } from "../../devtools/registry.js";

/**
 * B 站的两个「现在就跑」:把定时器到点要做的事提前调一次,定时器本身不动。
 *
 * 每个调的都是动态轮询自己暴露的那一个口(`detectNow` / `healthCheckNow`),不是另写一条路。
 * 中立场景(含资料刷新与直播复推)留在核心
 * `devtools/scenarios/timers.ts`。
 */
export interface BiliTimerDeps {
	/** 下面几样都是动态轮询建好之后才有的,现取。 */
	dynamic: () => { detectNow(): Promise<void> } | undefined;
	healthCheck: () => { healthCheckNow(): Promise<boolean> } | undefined;
}

export function biliTimerScenarios(deps: BiliTimerDeps): DevScenarioDef[] {
	const detect: DevScenarioDef = {
		id: "dynamic.detect-now",
		group: "timer",
		title: "动态检测",
		icon: "dyn",
		desc: "立刻跑一轮动态检测(拉真 feed),不等 cron。",
		params: [],
		async run() {
			const dynamic = deps.dynamic();
			if (!dynamic) return notReady("动态轮询");
			await dynamic.detectNow();
			return ok({ summary: "动态检测跑完一轮。" });
		},
	};

	const health: DevScenarioDef = {
		id: "auth.health-now",
		group: "timer",
		title: "登录心跳",
		icon: "check",
		desc: "立刻查一次登录是否还有效(真打 getMyselfInfo),不等定时器。没登录就跳过。",
		params: [],
		async run() {
			const healthCheck = deps.healthCheck();
			if (!healthCheck) return notReady("登录系统");
			const ran = await healthCheck.healthCheckNow();
			return ok({ summary: ran ? "心跳查完一次,结果看顶栏。" : "没登录 / 扫码中,心跳不查。" });
		},
	};

	return [detect, health];
}
