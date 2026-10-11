import { DevParamError, type DevScenarioDef, need } from "../../devtools/registry.js";
import type { SubPick } from "./live.js";

/**
 * B 站的四个「现在就跑」:把定时器到点要做的事提前调一次,定时器本身不动。
 *
 * 每个调的都是引擎自己暴露的那一个口(`repushNow` / `detectNow` / `pollNow` /
 * `healthCheckNow`),不是另写一条路。中立的三条(免扰时钟、静音、Chrome 空闲关)留在核心
 * `devtools/scenarios/timers.ts`。
 */
export interface BiliTimerDeps {
	subs: () => SubPick[];
	/** 下面几样都是引擎建好之后才有的,现取。 */
	live: () => { repushNow(uid: string): Promise<boolean> } | undefined;
	dynamic: () => { detectNow(): Promise<void> } | undefined;
	fans: () => { pollNow(): Promise<boolean> } | undefined;
	healthCheck: () => { healthCheckNow(): Promise<boolean> } | undefined;
}

export function biliTimerScenarios(deps: BiliTimerDeps): DevScenarioDef[] {
	const repush: DevScenarioDef = {
		id: "live.repush-now",
		group: "timer",
		title: "复推提前到期",
		icon: "refresh",
		desc: "把这位 UP「正在直播」的周期复推提前到现在(走的就是定时器到点那一次)。得在(假)直播中。",
		params: [{ key: "sub", label: "订阅", kind: "sub" }],
		async run(params) {
			const engine = need(deps.live(), "直播引擎");
			const subs = deps.subs();
			const wanted = params.sub;
			const sub =
				wanted === undefined
					? subs.find((s) => s.enabled)
					: subs.find((s) => s.id === String(wanted));
			if (!sub) {
				throw new DevParamError(wanted === undefined ? "没有启用的订阅" : `没有这个订阅:${wanted}`);
			}
			const ran = await engine.repushNow(sub.uid);
			return {
				summary: ran
					? `已替 ${sub.name} 复推了一次「正在直播」。`
					: `${sub.name} 没在播(或没监听),复推没跑。`,
			};
		},
	};

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

	return [repush, detect, fans, health];
}
