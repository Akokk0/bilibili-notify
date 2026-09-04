/**
 * 「立即重启并应用」按下去之后的那段路。
 *
 * 服务端回一句 `restarting: true` 就关自己了,页面这边从此什么都收不到:没有事件、
 * 没有回调,WS 断了重连也只补 globals / subs / targets。所以「重启完了吗、换成新版了吗」
 * 得由页面自己去问 —— 问的是 `/api/health`,认的是 `startedAt`:**只有它变了才算真的
 * 换了进程**。光「能连上」不算,那可能是旧进程还在排空在途请求(优雅停机最多等 10 秒)。
 *
 * 三种结局,一个不落:
 * - 新进程的版本正是目标 → 整页刷新。web-dist 是跟着载荷一起换的,不刷新就是旧面板在和
 *   新 API 说话;刷新之前在 sessionStorage 留个记号,刷新后据它说一句「已更新到 X」。
 * - 新进程起来了,版本却不是目标 → 载荷起不来、`boot.mjs` 已回落到镜像那版。明说。
 * - 等到截止时间都没回来 → 多半是容器没开 `restart:` 策略,进程退了没人拉。
 */

import { create } from "zustand";
import { api } from "../../services/api";
import type { NoticeView } from "../../store/notifications";

export interface RestartProbe {
	version: string;
	/** 进程启动时刻,`/api/health` 给的 ISO 串。换了进程它才会变。 */
	startedAt: string;
}

export type RestartOutcome =
	| { kind: "switched"; version: string }
	| { kind: "fell-back"; version: string }
	| { kind: "timed-out" };

export interface AwaitRestartInput {
	/** 要换掉的那个进程的 `startedAt` —— 之后只认和它不同的回答。 */
	before: string;
	/** 期望换到的版本。 */
	target: string;
	probe: () => Promise<RestartProbe>;
	intervalMs: number;
	timeoutMs: number;
	/** 注入是为了能测 —— 真实运行就是 setTimeout / Date.now。 */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function awaitRestartedServer(input: AwaitRestartInput): Promise<RestartOutcome> {
	const sleep = input.sleep ?? realSleep;
	const now = input.now ?? Date.now;
	const deadline = now() + input.timeoutMs;
	for (;;) {
		try {
			const seen = await input.probe();
			if (seen.startedAt !== input.before) {
				return seen.version === input.target
					? { kind: "switched", version: seen.version }
					: { kind: "fell-back", version: seen.version };
			}
		} catch {
			// 还没回来(连不上 / 探测超时)—— 继续等。
		}
		// 先探再看表:到点那一下也探过了才放弃,否则「刚好在截止时间回来」会被漏掉。
		if (now() >= deadline) return { kind: "timed-out" };
		await sleep(input.intervalMs);
	}
}

/**
 * 刷新前留、刷新后取的记号。走 sessionStorage:只活在这个标签页里,关了就没了 ——
 * 别的标签页、下次打开面板都不该再看到那句「已更新到」。
 */
export interface RestartMark {
	target: string;
	mode: "update" | "rollback";
}

const RESTART_MARK_KEY = "bn.update.restarted";

export function leaveRestartMark(mark: RestartMark): void {
	try {
		sessionStorage.setItem(RESTART_MARK_KEY, JSON.stringify(mark));
	} catch {
		// 隐私模式 / 存储被禁:那就少一句提示,不影响刷新本身。
	}
}

/** 取走记号(取一次就没了)。没有、或者被写坏了,一律 null。 */
export function takeRestartMark(): RestartMark | null {
	try {
		const raw = sessionStorage.getItem(RESTART_MARK_KEY);
		if (raw === null) return null;
		sessionStorage.removeItem(RESTART_MARK_KEY);
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const { target, mode } = parsed as Record<string, unknown>;
		if (typeof target !== "string") return null;
		if (mode !== "update" && mode !== "rollback") return null;
		return { target, mode };
	} catch {
		return null;
	}
}

/**
 * 刷新回来该说的那句话。只在记号里的目标就是现在跑的版本时才说 —— 对不上就不是这次
 * 重启的结果,不能拿来报喜。
 */
export function restartNotice(mark: RestartMark): NoticeView {
	return mark.mode === "rollback"
		? {
				id: `restarted:${mark.target}`,
				title: `已退回 ${mark.target}`,
				body: "重启完成,现在跑的就是这一版。想再往前走就到系统页按「检查更新」。",
			}
		: {
				id: `restarted:${mark.target}`,
				title: `已更新到 ${mark.target}`,
				body: "重启完成,现在跑的就是这一版。",
			};
}

/**
 * 整页刷新收在一个对象后面,是为了测试能拦下它 —— jsdom 的 `location.reload` 既不能
 * spy 也不能重定义,而「换成了就刷新」正是这条流程里最该被钉住的一步。
 */
export const browser = {
	reload(): void {
		window.location.reload();
	},
};

export interface RestartWait {
	intervalMs: number;
	timeoutMs: number;
}

/** 按下「立即重启并应用」那一刻记下的:要换到哪、是升是退、要换掉的进程是哪个。 */
export interface RestartIntent extends RestartMark {
	/** 被换掉的那个进程的 `startedAt` —— 之后只认和它不同的回答。 */
	before: string;
}

/**
 * 按下重启之后面板的三种样子。「换成了」不在这里:那一刻整页刷新,刷新后的那句话
 * 由打开面板那次检查来说。
 */
export type RestartView =
	| { kind: "waiting"; intent: RestartIntent }
	| { kind: "fell-back"; intent: RestartIntent; version: string }
	| { kind: "timed-out"; intent: RestartIntent };

interface RestartStore {
	view: RestartView | null;
	/** 重启指令已经发出去:开始等新进程。 */
	begin(intent: RestartIntent, wait: RestartWait): void;
	/** 「再等等」—— 只在等超时之后有意义。 */
	retry(wait: RestartWait): void;
	/** 用户去做别的了(检查 / 下载 / 回退):上一次重启留下的旁注到此为止。 */
	dismiss(): void;
}

/** 单次探测的死线。一条挂着不回的连接不该拖住整个等待 —— 按下之前那次探测也一样。 */
export const PROBE_TIMEOUT_MS = 3_000;

/**
 * 等待活在模块里,不挂在系统页那一节的 state 上:重启要十几二十秒,用户这期间点去
 * 别的页面很正常 —— 那一节一卸载等待就没了的话,换成了也不会刷新,又回到「按了没反应」。
 * 放在这里,人在哪一页都照样等、照样刷新;回到系统页看到的也是同一份进度。
 */
export const useRestartStore = create<RestartStore>((set, get) => {
	// 每开始一轮等待就换一代;旧那一代的结果一律不认(dismiss 之后才回来的探测尤其)。
	let generation = 0;

	const wait = (intent: RestartIntent, options: RestartWait): void => {
		generation += 1;
		const mine = generation;
		set({ view: { kind: "waiting", intent } });
		void awaitRestartedServer({
			before: intent.before,
			target: intent.target,
			probe: () => api.get<RestartProbe>("/api/health", { timeoutMs: PROBE_TIMEOUT_MS }),
			intervalMs: options.intervalMs,
			timeoutMs: options.timeoutMs,
		}).then((outcome) => {
			if (mine !== generation) return;
			switch (outcome.kind) {
				case "switched":
					leaveRestartMark({ target: intent.target, mode: intent.mode });
					browser.reload();
					return;
				case "fell-back":
					set({ view: { kind: "fell-back", intent, version: outcome.version } });
					return;
				case "timed-out":
					set({ view: { kind: "timed-out", intent } });
			}
		});
	};

	return {
		view: null,
		begin: wait,
		retry(options) {
			const { view } = get();
			if (view?.kind === "timed-out") wait(view.intent, options);
		},
		dismiss() {
			generation += 1;
			set({ view: null });
		},
	};
});
