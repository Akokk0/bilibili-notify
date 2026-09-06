/**
 * 前端半边的场景 —— 只存在于面板里的状态,服务端造不出来:涌 toast、不可达壳、灵动岛的
 * 几个态、新手指引的每一步。跑在浏览器里,不打服务端。
 */

import type { OnboardingInputs, OnboardingStepKey } from "../components/onboarding/derive";
import { useOnboardingInputsOverride } from "../components/onboarding/inputs-override";
import { HEALTH_QUERY_KEY } from "../hooks/useBackendReachable";
import { type DraftUiState, useDraftStore } from "../store/draft";
import { useToastStore } from "../store/notifications";
import type { WebDevScenario, WebRunContext } from "./registry";

const toastFlood: WebDevScenario = {
	id: "web.toast-flood",
	group: "web",
	title: "涌 toast",
	icon: "bell",
	desc: "右下角一口气来 N 张通知卡,看超过上限时最旧的那张怎么被挤掉、以及叠起来的间距。",
	quick: true,
	params: [{ key: "count", label: "几张", kind: "number", default: 6, min: 1, max: 20 }],
	run(params) {
		const count = typeof params.count === "number" ? params.count : 6;
		const notify = useToastStore.getState().notify;
		const stamp = Date.now();
		for (let i = 0; i < count; i++) {
			notify({
				id: `dev-toast-${stamp}-${i}`,
				title: `devtools 第 ${i + 1} 张`,
				body: "涌出来看看叠放、上限与自动消失。",
				action: i === 0 ? { label: "去系统页", to: "/system" } : undefined,
			});
		}
		return `涌了 ${count} 张。`;
	},
};

const backendUnreachable: WebDevScenario = {
	id: "web.backend-unreachable",
	group: "web",
	title: "后端不可达壳",
	icon: "warning",
	desc: "把健康探测那条查询直接置成失败,整页切到「连不上服务端」的壳。下一次探测(几秒后)成功就自动恢复 —— 看一眼够了。",
	params: [],
	run(_params, ctx: WebRunContext) {
		const query = ctx.qc.getQueryCache().find({ queryKey: HEALTH_QUERY_KEY });
		if (!query) return "健康探测还没建起来,壳没得切。";
		query.setState({
			status: "error",
			error: new Error("devtools 装的:服务端不可达"),
			data: undefined,
			dataUpdatedAt: 0,
			errorUpdatedAt: Date.now(),
			fetchStatus: "idle",
		});
		return "壳已切到不可达;下一次健康探测成功就恢复。";
	},
};

const DRAFT_STATES: ReadonlyArray<{ value: DraftUiState; label: string }> = [
	{ value: "dirty", label: "有改动待保存" },
	{ value: "saving", label: "保存中" },
	{ value: "saved", label: "已保存" },
	{ value: "error", label: "保存失败" },
];

const draftIsland: WebDevScenario = {
	id: "web.draft-island",
	group: "web",
	title: "灵动岛",
	icon: "edit",
	desc: "往灵动岛塞一份假草稿并切到指定态。岛上的「丢弃」会把它撤掉;收摊同样。",
	params: [
		{ key: "state", label: "状态", kind: "enum", options: DRAFT_STATES, default: "saving" },
		{ key: "message", label: "失败原因(失败时)", kind: "text", default: "devtools:假装保存失败了" },
	],
	run(params) {
		const state = String(params.state ?? "saving") as DraftUiState;
		const store = useDraftStore.getState();
		store.register({
			pageKey: "devtools",
			pageLabel: "devtools 假草稿",
			diff: [
				{ code: "app.logLevel", oldValue: "info", newValue: "debug" },
				{ code: "defaults.schedule.pushTime", oldValue: 30, newValue: 15 },
			],
			onSave: () => {
				useDraftStore.getState().setUiState("saving");
				setTimeout(() => useDraftStore.getState().setUiState("saved"), 800);
			},
			onDiscard: () => useDraftStore.getState().unregister(),
		});
		store.setUiState(state, state === "error" ? String(params.message ?? "") : null);
		return `灵动岛 → ${DRAFT_STATES.find((s) => s.value === state)?.label ?? state}。`;
	},
	active() {
		const s = useDraftStore.getState();
		return s.current?.pageKey === "devtools"
			? { scenarioId: "web.draft-island", label: `灵动岛 → ${s.uiState}` }
			: null;
	},
	reset() {
		if (useDraftStore.getState().current?.pageKey === "devtools")
			useDraftStore.getState().unregister();
	},
	subscribe: (onChange) => useDraftStore.subscribe(onChange),
};

const STEPS: ReadonlyArray<{ value: OnboardingStepKey | "done"; label: string }> = [
	{ value: "login", label: "① 还没登录 B 站" },
	{ value: "adapter", label: "② 该建适配器了" },
	{ value: "target", label: "③ 该建推送目标了" },
	{ value: "test", label: "④ 该测一次推送了" },
	{ value: "subs", label: "⑤ 该订阅 UP 了" },
	{ value: "done", label: "全部完成" },
];

/** 把「现在该做第几步」翻成一份判据输入:前面的步全完成,这一步及之后未完成。 */
export function onboardingInputsFor(step: OnboardingStepKey | "done"): OnboardingInputs {
	const order: (OnboardingStepKey | "done")[] = [
		"login",
		"adapter",
		"target",
		"test",
		"subs",
		"done",
	];
	const at = order.indexOf(step);
	const done = (key: OnboardingStepKey) => order.indexOf(key) < at;
	const ok = { ok: true, lastCheckedAt: "2026-09-06T00:00:00.000Z" };
	return {
		biliLoggedIn: done("login"),
		adapters: done("adapter") ? [{ enabled: true, testStatus: ok }] : [],
		targets: done("target") ? [{ enabled: true, testStatus: done("test") ? ok : undefined }] : [],
		subsCount: done("subs") ? 1 : 0,
		modules: { image: true, ai: true },
	};
}

const onboardingStep: WebDevScenario = {
	id: "web.onboarding-step",
	group: "web",
	title: "新手指引停在第几步",
	icon: "list",
	desc: "把新手指引的判据输入换成「前面几步都完成了、现在该做这一步」,导览卡与聚光灯照真算。导览本身得是开着的(系统页 · 新手指引 · 重新开始)。",
	params: [{ key: "step", label: "停在", kind: "enum", options: STEPS, default: "adapter" }],
	run(params) {
		const step = String(params.step ?? "adapter") as OnboardingStepKey | "done";
		useOnboardingInputsOverride.getState().set(onboardingInputsFor(step));
		return `新手指引现在停在:${STEPS.find((s) => s.value === step)?.label ?? step}。`;
	},
	active() {
		const inputs = useOnboardingInputsOverride.getState().inputs;
		if (!inputs) return null;
		return { scenarioId: "web.onboarding-step", label: "新手指引 → 假判据" };
	},
	reset() {
		useOnboardingInputsOverride.getState().set(null);
	},
	subscribe: (onChange) => useOnboardingInputsOverride.subscribe(onChange),
};

export const WEB_SCENARIOS: readonly WebDevScenario[] = [
	toastFlood,
	backendUnreachable,
	draftIsland,
	onboardingStep,
];
