/**
 * 新手导览的判据核心 —— 纯函数,不碰 react/query,测试在 __tests__/derive.test.ts。
 *
 * 2026-08-29 grilling 定案:5 步全机器判据、按**结果态**建模(不是操作流程):
 * ①B站登录 ②适配器存在且 test 通过 ③启用的推送目标存在 ④target 测试推送
 * 成功 ⑤订阅数>0。可选尾巴(图片渲染/AI)不计毕业。
 *
 * 顺序是五轮定稿(主人拍板):**先打通推送通道,订阅放最后** —— 订阅表单里
 * 就要勾推送目标,先订阅的话通道没就绪,回头还得重开订阅补选目标。
 *
 * test 步刻意不看 enabled:test=「证明过整条链路通」,测通后禁用目标不该把
 * 它收回去 —— 但 target 步会退回未完成,active 指回它。
 */

export type OnboardingStepKey = "login" | "adapter" | "target" | "test" | "subs";
export type OnboardingTailKey = "image" | "ai";

export interface OnboardingInputs {
	biliLoggedIn: boolean;
	subsCount: number;
	adapters: readonly { enabled: boolean; testStatus?: { ok: boolean } | undefined }[];
	targets: readonly { enabled: boolean; testStatus?: { ok: boolean } | undefined }[];
	/** `/api/health` 的 modules 快照;还没回来时 undefined → 尾巴按未完成显示。 */
	modules: { image: boolean; ai: boolean } | undefined;
}

export interface OnboardingView {
	steps: { key: OnboardingStepKey; done: boolean }[];
	tails: { key: OnboardingTailKey; done: boolean }[];
	/** 第一个未完成步;全绿为 null。导览靠它高亮「现在该做哪步」。 */
	activeKey: OnboardingStepKey | null;
	doneCount: number;
	allDone: boolean;
}

export function deriveOnboarding(inputs: OnboardingInputs): OnboardingView {
	const steps: OnboardingView["steps"] = [
		{ key: "login", done: inputs.biliLoggedIn },
		{
			key: "adapter",
			done: inputs.adapters.some((a) => a.enabled && a.testStatus?.ok === true),
		},
		{ key: "target", done: inputs.targets.some((t) => t.enabled) },
		{
			key: "test",
			done: inputs.targets.some((t) => t.testStatus?.ok === true),
		},
		{ key: "subs", done: inputs.subsCount > 0 },
	];
	const doneCount = steps.filter((s) => s.done).length;
	return {
		steps,
		tails: [
			{ key: "image", done: inputs.modules?.image === true },
			{ key: "ai", done: inputs.modules?.ai === true },
		],
		activeKey: steps.find((s) => !s.done)?.key ?? null,
		doneCount,
		allDone: doneCount === steps.length,
	};
}
