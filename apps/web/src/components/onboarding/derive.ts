/**
 * 新手进度卡的判据核心 —— 纯函数,不碰 react/query,测试在 __tests__/derive.test.ts。
 *
 * 2026-08-29 grilling 定案:5 步全机器判据、按**结果态**建模(不是操作流程):
 * ①B站登录 ②订阅数>0 ③适配器存在且 test 通过 ④启用的推送目标存在
 * ⑤target 测试推送成功(毕业)。可选尾巴(图片渲染/AI)不计毕业。
 *
 * 毕业步刻意不看 enabled:毕业=「证明过整条链路通」,测通后禁用目标不该把
 * 毕业收回去 —— 但 target 步会退回未完成,active 指回它提醒用户。
 */

export type OnboardingStepKey = "login" | "subs" | "adapter" | "target" | "graduate";
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
	/** 第一个未完成步;全绿为 null。进度卡靠它高亮「现在该做哪步」。 */
	activeKey: OnboardingStepKey | null;
	doneCount: number;
	allDone: boolean;
}

export function deriveOnboarding(inputs: OnboardingInputs): OnboardingView {
	const steps: OnboardingView["steps"] = [
		{ key: "login", done: inputs.biliLoggedIn },
		{ key: "subs", done: inputs.subsCount > 0 },
		{
			key: "adapter",
			done: inputs.adapters.some((a) => a.enabled && a.testStatus?.ok === true),
		},
		{ key: "target", done: inputs.targets.some((t) => t.enabled) },
		{
			key: "graduate",
			done: inputs.targets.some((t) => t.testStatus?.ok === true),
		},
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
