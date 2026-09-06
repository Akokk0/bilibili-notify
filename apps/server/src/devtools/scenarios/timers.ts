import type { MuteState } from "../../runtime/mute-state.js";
import type { DevClock } from "../clock.js";
import { DevParamError, type DevScenarioDef } from "../registry.js";
import type { SubPick } from "./live.js";

/**
 * 定时组:C1 免扰时钟(单点覆盖)+ 静音(真调);C2 / C3 五个「现在就跑」—— 把定时器到点
 * 要做的事提前调一次,定时器本身不动。
 *
 * 每个「现在就跑」调的都是引擎 / 运行时自己暴露的那一个口(`closeIdleNow` / `repushNow` /
 * `detectNow` / `pollNow` / `healthCheckNow`),不是另写一条路。
 */
export interface TimerScenarioDeps {
	clock: DevClock;
	subs: () => SubPick[];
	/** 下面几样都是引擎 / 运行时建好之后才有的,现取。 */
	mute: () => Pick<MuteState, "muteFor" | "mutedUntil" | "isMuted"> | undefined;
	puppeteer: () => { closeIdleNow(): Promise<boolean> } | null | undefined;
	live: () => { repushNow(uid: string): Promise<boolean> } | undefined;
	dynamic: () => { detectNow(): Promise<void> } | undefined;
	fans: () => { pollNow(): Promise<boolean> } | undefined;
	loginFlow: () => { healthCheckNow(): Promise<boolean> } | undefined;
}

function hhmm(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function need<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new DevParamError(`${what}还没起来`);
	return value;
}

export function timerScenarios(deps: TimerScenarioDeps): DevScenarioDef[] {
	const quietClock: DevScenarioDef = {
		id: "push.quiet-clock",
		group: "timer",
		title: "免扰时钟",
		icon: "sun",
		desc: "推送的免扰判定当作现在是这个时刻(只这一处,不是假时钟)。设成免扰时段里再造一条开播 / 动态,看它被免扰吞掉。",
		params: [{ key: "time", label: "当作现在是(HH:mm)", kind: "text", default: "03:00" }],
		run(params) {
			const m = /^(\d{1,2}):(\d{2})$/.exec(String(params.time ?? ""));
			const hour = m ? Number(m[1]) : Number.NaN;
			const minute = m ? Number(m[2]) : Number.NaN;
			if (!m || hour > 23 || minute > 59) throw new DevParamError("时间要写成 HH:mm,如 03:00");
			deps.clock.pretend(hour, minute);
			return { summary: `免扰判定现在当作是 ${deps.clock.pretended()}。` };
		},
		active() {
			const t = deps.clock.pretended();
			return t === null
				? null
				: { scenarioId: "push.quiet-clock", label: `免扰时钟 → 当作现在是 ${t}` };
		},
		reset() {
			deps.clock.clear();
		},
	};

	/**
	 * 这一条按的是**真的** /mute,写的是真配置。所以 devtools 只认自己按下的那一次:记住
	 * 它写进去的到期时刻,只有盘上还是那个数才敢在「当前生效」里认领、才敢收摊时解除。
	 * 不这样的话,主人自己从私聊 /mute 出来的静音会被面板当成注入列出来,一按「全部收摊」
	 * 就给人无声解掉 —— 收摊只收 devtools 自己造的东西,这是这套工具的规矩。
	 */
	let mutedByDevtools: number | null = null;

	const mute: DevScenarioDef = {
		id: "push.mute",
		group: "timer",
		title: "静音",
		icon: "mic",
		desc: "走真的 /mute:静音 N 分钟(写进配置的 mutedUntil),订阅推送全挡、主人私聊照发。收摊 = 解除 —— 但只解除从这儿按出来的那次;主人自己 /mute 的不碰。",
		params: [{ key: "minutes", label: "分钟", kind: "number", default: 10, min: 1, max: 1440 }],
		async run(params) {
			const state = need(deps.mute(), "推送引擎");
			const minutes = typeof params.minutes === "number" ? params.minutes : 10;
			const until = await state.muteFor(minutes * 60_000);
			mutedByDevtools = until;
			return { summary: `已静音到 ${hhmm(until)}。` };
		},
		active() {
			const state = deps.mute();
			if (!state?.isMuted()) return null;
			// 盘上的到期时刻换过了 = 这不再是我们按的那次(主人自己又 /mute 了,或者改了配置)。
			if (mutedByDevtools === null || state.mutedUntil() !== mutedByDevtools) return null;
			return { scenarioId: "push.mute", label: `静音中 → 到 ${hhmm(state.mutedUntil())}` };
		},
		async reset() {
			const state = deps.mute();
			const mine = mutedByDevtools;
			mutedByDevtools = null;
			// 没按过、或者已经不是我们那次:一个字节都不写。`patchGlobals` 没有空转短路,
			// 每次都会落盘 + 广播 config-changed。
			if (!state || mine === null || !state.isMuted() || state.mutedUntil() !== mine) return;
			await state.muteFor(0);
		},
	};

	const chromeIdle: DevScenarioDef = {
		id: "chrome.idle-now",
		group: "timer",
		title: "Chrome 空闲关闭",
		icon: "image",
		desc: "把「渲染空闲 N 秒后关 chromium」提前到现在。正在渲染或压根没起浏览器就不动。下次渲染自动重启。",
		params: [],
		async run() {
			const p = need(deps.puppeteer(), "渲染器");
			const closed = await p.closeIdleNow();
			return {
				summary: closed
					? "已关掉空闲的浏览器,下次渲染自动重启。"
					: "没有可关的:正在渲染,或浏览器本来就没起。",
			};
		},
	};

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
			const ran = await need(deps.loginFlow(), "登录流程").healthCheckNow();
			return { summary: ran ? "心跳查完一次,结果看顶栏。" : "没登录 / 扫码中,心跳不查。" };
		},
	};

	return [quietClock, mute, chromeIdle, repush, detect, fans, health];
}
