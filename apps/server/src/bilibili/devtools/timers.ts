import { type DevScenarioDef, need } from "../../devtools/registry.js";
import type { SubPick } from "./live.js";

/**
 * B 站的三个「现在就跑」:把定时器到点要做的事提前调一次,定时器本身不动。
 *
 * 每个调的都是引擎自己暴露的那一个口(`detectNow` / `pollNow` / `healthCheckNow`),不是另写一条路。
 * 中立场景(含直播复推)留在核心
 * `devtools/scenarios/timers.ts`。
 */
export interface BiliTimerDeps {
	subs: () => SubPick[];
	/** 下面几样都是引擎建好之后才有的,现取。 */
	dynamic: () => { detectNow(): Promise<void> } | undefined;
	fans: () => { pollNow(): Promise<boolean> } | undefined;
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
			await need(deps.dynamic(), "动态引擎").detectNow();
			return { summary: "动态检测跑完一轮。" };
		},
	};

	const fans: DevScenarioDef = {
		id: "fans.poll-now",
		group: "timer",
		title: "粉丝轮询",
		icon: "heart",
		desc: "立刻跑一轮粉丝数采样,不等 cron。上一轮还在跑就跳过。",
		params: [],
		async run() {
			const ran = await need(deps.fans(), "粉丝轮询").pollNow();
			return { summary: ran ? "粉丝轮询跑完一轮。" : "上一轮还在跑,这次跳过。" };
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
			const ran = await need(deps.healthCheck(), "登录系统").healthCheckNow();
			return { summary: ran ? "心跳查完一次,结果看顶栏。" : "没登录 / 扫码中,心跳不查。" };
		},
	};

	return [detect, fans, health];
}
