import { i18n } from "../../i18n";
/**
 * 新手导览的判据核心 —— 纯函数,不碰 react/query,测试在 __tests__/derive.test.ts。
 *
 * 2026-08-29 grilling 定案:5 步全机器判据、按**结果态**建模(不是操作流程):
 * ①B站登录 ②连接存在且 test 通过 ③启用的推送目标存在 ④target 测试推送
 * 成功 ⑤订阅数>0。可选尾巴(图片渲染/AI)不计毕业。
 *
 * 顺序是五轮定稿(主人拍板):**先打通推送通道,订阅放最后** —— 订阅表单里
 * 就要勾推送目标,先订阅的话通道没就绪,回头还得重开订阅补选目标。
 *
 * test 步刻意不看 enabled:test=「证明过整条链路通」,测通后禁用目标不该把
 * 它收回去 —— 但 target 步会退回未完成,active 指回它。
 */

import type { Connection, PushTarget } from "@bilibili-notify/internal";

export type OnboardingStepKey = "login" | "connection" | "target" | "test" | "subs";
export type OnboardingTailKey = "image" | "ai";

/** 连接只读探测状态、目标只读可达性 —— 判据只认这两格。 */
type ConnectionRow = Pick<Connection, "enabled" | "probeState">;
type TargetRow = Pick<PushTarget, "enabled" | "reachability">;

/** 最近一次不通:原因,与它发生的时刻(连接取 lastCheckedAt、目标取 changedAt)。 */
interface Outcome {
	status: string;
	message?: string | undefined;
	at: string;
}

const connectionOutcome = (a: ConnectionRow): Outcome | undefined =>
	a.probeState && {
		status: a.probeState.status,
		message: a.probeState.message,
		at: a.probeState.lastCheckedAt,
	};

const targetOutcome = (t: TargetRow): Outcome | undefined =>
	t.reachability && {
		status: t.reachability.status,
		message: t.reachability.message,
		at: t.reachability.changedAt,
	};

export interface OnboardingInputs {
	biliLoggedIn: boolean;
	subsCount: number;
	connections: readonly ConnectionRow[];
	targets: readonly TargetRow[];
	/** `/api/health/details` 的 modules 快照;还没回来时 undefined → 尾巴按未完成显示。 */
	modules: { image: boolean; ai: boolean } | undefined;
}

export interface OnboardingView {
	steps: { key: OnboardingStepKey; done: boolean }[];
	tails: { key: OnboardingTailKey; done: boolean }[];
	/** 第一个未完成步;全绿为 null。导览靠它高亮「现在该做哪步」。 */
	activeKey: OnboardingStepKey | null;
	/**
	 * 建过连接(不问测没测通)。adapter 主步的**子步**判据:保存连接的那一刻
	 * 导览要从「新建」翻到「测试连通」并把灯移到测试按钮上 —— 主步 done(测通)
	 * 太晚,灯会在建完到测通之间断档(真机踩过)。
	 */
	hasConnection: boolean;
	doneCount: number;
	allDone: boolean;
	/**
	 * 当前步的最近一次测试失败(仅 adapter / test 两个带「测试」的步,且只翻**启用
	 * 中**那些的账)。成功会推进
	 * 子步、换链重置聚光灯;失败既不开弹窗也不换链 —— 「按下即退散」的灯永远回不
	 * 来,报错只在页面 toast 闪 2 秒。text 上小卡讲原因;at(lastCheckedAt)每次
	 * 尝试必变,供同因连败也能触发灯重亮。不属于当前步的旧失败保持沉默。
	 */
	failNote: { text: string; at: string } | null;
}

function failNoteFrom(outcomes: readonly (Outcome | undefined)[]): OnboardingView["failNote"] {
	const st = outcomes.find((o) => o?.status === "unreachable");
	return st
		? {
				get text() {
					return st.message || i18n.t("panelUi.components.onboarding.derive.1");
				},
				at: st.at,
			}
		: null;
}

export function deriveOnboarding(inputs: OnboardingInputs): OnboardingView {
	const steps: OnboardingView["steps"] = [
		{ key: "login", done: inputs.biliLoggedIn },
		{
			key: "connection",
			done: inputs.connections.some((a) => a.enabled && a.probeState?.status === "reachable"),
		},
		{ key: "target", done: inputs.targets.some((t) => t.enabled) },
		{
			key: "test",
			done: inputs.targets.some((t) => t.reachability?.status === "reachable"),
		},
		{ key: "subs", done: inputs.subsCount > 0 },
	];
	const doneCount = steps.filter((s) => s.done).length;
	const activeKey = steps.find((s) => !s.done)?.key ?? null;
	return {
		steps,
		// 两边都只翻**启用中**那些的账。test 步的 done 判据刻意不看 enabled(测通过
		// 就算数,事后禁用不该把它收回去),但失败是另一回事:用户此刻要测的是还
		// 启用着的目标,被禁用目标上周留下的旧账既不是他的问题也不是他改得动的东西,
		// 拿它当当前失败讲纯属误导(2026-08-31 审查)。
		failNote:
			activeKey === "connection"
				? failNoteFrom(inputs.connections.filter((a) => a.enabled).map(connectionOutcome))
				: activeKey === "test"
					? failNoteFrom(inputs.targets.filter((t) => t.enabled).map(targetOutcome))
					: null,
		tails: [
			{ key: "image", done: inputs.modules?.image === true },
			{ key: "ai", done: inputs.modules?.ai === true },
		],
		activeKey,
		hasConnection: inputs.connections.length > 0,
		doneCount,
		allDone: doneCount === steps.length,
	};
}
