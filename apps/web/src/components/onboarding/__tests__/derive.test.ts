/**
 * 新手进度卡的判据核心(2026-08-29 grilling 定案:5 步全机器判据、按结果态建模)。
 *
 * 步骤链:①B站登录 ②订阅数>0 ③适配器存在且 test 通过 ④启用的推送目标存在
 * ⑤target 测试推送成功(毕业)。可选尾巴(image/ai)不计毕业。
 *
 * 钉住的边界:
 * - adapter 步要求 **enabled 且 testStatus.ok** —— 只建不测不算(定案原文
 *   「adapter 存在且 test 通过」);disabled 的 adapter 测过也不算,它不会参与推送。
 * - target 步要求 enabled;毕业步只看「任一 target 测试成功过」不看 enabled ——
 *   测通后禁用目标,毕业不回退(毕业=证明过整条链路通,不是当前时刻的可推送性),
 *   但 target 步会退回未完成,active 指回它。
 * - `active` 是第一个未完成步,全绿则无 —— 进度卡靠它高亮「现在该做哪步」。
 */

import { describe, expect, it } from "vite-plus/test";
import { deriveOnboarding, type OnboardingInputs } from "../derive";

function inputs(partial: Partial<OnboardingInputs>): OnboardingInputs {
	return {
		biliLoggedIn: false,
		subsCount: 0,
		adapters: [],
		targets: [],
		modules: undefined,
		...partial,
	};
}

function stepMap(view: ReturnType<typeof deriveOnboarding>): Record<string, boolean> {
	return Object.fromEntries(view.steps.map((s) => [s.key, s.done]));
}

describe("deriveOnboarding 步骤判据", () => {
	it("全空输入:五步全未完成,active=login", () => {
		const v = deriveOnboarding(inputs({}));
		expect(v.steps).toHaveLength(5);
		expect(v.steps.every((s) => !s.done)).toBe(true);
		expect(v.activeKey).toBe("login");
		expect(v.allDone).toBe(false);
		expect(v.doneCount).toBe(0);
	});

	it("登录+订阅后 active 推进到 adapter", () => {
		const v = deriveOnboarding(inputs({ biliLoggedIn: true, subsCount: 2 }));
		expect(stepMap(v)).toMatchObject({ login: true, subs: true, adapter: false });
		expect(v.activeKey).toBe("adapter");
	});

	it("adapter 只建不测 → adapter 步未完成(定案:存在且 test 通过)", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				subsCount: 1,
				adapters: [{ enabled: true, testStatus: undefined }],
			}),
		);
		expect(stepMap(v).adapter).toBe(false);
	});

	it("disabled 的 adapter 测过也不算 —— 它不参与推送", () => {
		const v = deriveOnboarding(
			inputs({ adapters: [{ enabled: false, testStatus: { ok: true } }] }),
		);
		expect(stepMap(v).adapter).toBe(false);
	});

	it("adapter 测过 + 启用目标存在 → 前四步完成,active=graduate", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				subsCount: 1,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [{ enabled: true, testStatus: undefined }],
			}),
		);
		expect(v.doneCount).toBe(4);
		expect(v.activeKey).toBe("graduate");
	});

	it("target 测试成功 → 全绿毕业,无 active", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				subsCount: 1,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [{ enabled: true, testStatus: { ok: true } }],
			}),
		);
		expect(v.allDone).toBe(true);
		expect(v.activeKey).toBeNull();
	});

	it("测通后禁用目标:毕业不回退,但 target 步退回未完成并成为 active", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				subsCount: 1,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [{ enabled: false, testStatus: { ok: true } }],
			}),
		);
		const m = stepMap(v);
		expect(m.graduate).toBe(true);
		expect(m.target).toBe(false);
		expect(v.activeKey).toBe("target");
		expect(v.allDone).toBe(false);
	});

	it("test 失败(ok:false)不算毕业", () => {
		const v = deriveOnboarding(inputs({ targets: [{ enabled: true, testStatus: { ok: false } }] }));
		expect(stepMap(v).graduate).toBe(false);
	});
});

describe("deriveOnboarding 可选尾巴", () => {
	it("modules 未知(health 还没回来)→ 尾巴全未完成", () => {
		const v = deriveOnboarding(inputs({}));
		expect(v.tails).toEqual([
			{ key: "image", done: false },
			{ key: "ai", done: false },
		]);
	});

	it("modules 布尔直通;尾巴不影响 allDone", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				subsCount: 1,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [{ enabled: true, testStatus: { ok: true } }],
				modules: { image: true, ai: false },
			}),
		);
		expect(v.tails).toEqual([
			{ key: "image", done: true },
			{ key: "ai", done: false },
		]);
		expect(v.allDone).toBe(true);
	});
});
