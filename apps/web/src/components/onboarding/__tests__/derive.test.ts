/**
 * 新手导览的判据核心(2026-08-29 grilling 定案:5 步全机器判据、按结果态建模)。
 *
 * 步骤链(五轮定稿顺序:先打通推送通道,订阅放最后 —— 订阅表单要勾推送目标,
 * 先订阅的话通道没就绪还得回头重编辑):①B站登录 ②适配器存在且 test 通过
 * ③启用的推送目标存在 ④target 测试推送成功 ⑤订阅数>0。可选尾巴(image/ai)
 * 不计毕业。
 *
 * 钉住的边界:
 * - adapter 步要求 **enabled 且 testStatus.ok** —— 只建不测不算(定案原文
 *   「adapter 存在且 test 通过」);disabled 的 adapter 测过也不算,它不会参与推送。
 * - target 步要求 enabled;test 步只看「任一 target 测试成功过」不看 enabled ——
 *   测通后禁用目标,test 不回退(test=证明过整条链路通,不是当前时刻的可推送性),
 *   但 target 步会退回未完成,active 指回它。
 * - `active` 是第一个未完成步,全绿则无 —— 导览靠它高亮「现在该做哪步」。
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

	it("登录后 active 直接推进到 adapter —— 订阅在最后,不挡通道配置", () => {
		const v = deriveOnboarding(inputs({ biliLoggedIn: true }));
		expect(stepMap(v)).toMatchObject({ login: true, adapter: false, subs: false });
		expect(v.activeKey).toBe("adapter");
	});

	it("adapter 只建不测 → adapter 步未完成(定案:存在且 test 通过)", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				adapters: [{ enabled: true, testStatus: undefined }],
			}),
		);
		expect(stepMap(v).adapter).toBe(false);
		// 但 hasAdapter 已亮 —— 导览靠它把子步从「新建」翻到「测试连通」,灯不断档
		expect(v.hasAdapter).toBe(true);
	});

	it("hasAdapter:没建过任何适配器时为 false", () => {
		expect(deriveOnboarding(inputs({})).hasAdapter).toBe(false);
	});

	it("disabled 的 adapter 测过也不算 —— 它不参与推送", () => {
		const v = deriveOnboarding(
			inputs({ adapters: [{ enabled: false, testStatus: { ok: true } }] }),
		);
		expect(stepMap(v).adapter).toBe(false);
	});

	it("adapter 测过 + 启用目标存在 → active=test", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [{ enabled: true, testStatus: undefined }],
			}),
		);
		expect(v.doneCount).toBe(3);
		expect(v.activeKey).toBe("test");
	});

	it("测试推送成功但还没订阅 → 通道全通,active=subs 收尾", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [{ enabled: true, testStatus: { ok: true } }],
			}),
		);
		expect(v.doneCount).toBe(4);
		expect(v.activeKey).toBe("subs");
		expect(v.allDone).toBe(false);
	});

	it("订阅补上 → 全绿毕业,无 active", () => {
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

	it("测通后禁用目标:test 不回退,但 target 步退回未完成并成为 active", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				subsCount: 1,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [{ enabled: false, testStatus: { ok: true } }],
			}),
		);
		const m = stepMap(v);
		expect(m.test).toBe(true);
		expect(m.target).toBe(false);
		expect(v.activeKey).toBe("target");
		expect(v.allDone).toBe(false);
	});

	it("测试失败(ok:false)→ test 步未完成", () => {
		const v = deriveOnboarding(inputs({ targets: [{ enabled: true, testStatus: { ok: false } }] }));
		expect(stepMap(v).test).toBe(false);
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

/**
 * failNote —— 当前步的最近一次测试失败(2026-08-30 真机反馈补的兜底)。
 *
 * 失败不换链、不开弹窗:聚光灯「按下即退散」永远不复原,报错只在页面 toast
 * 闪 2 秒 —— 导览侧对失败完全无感。failNote 把 err 带上小卡、at(lastCheckedAt)
 * 供每次尝试都触发灯重亮(同一原因连败两次,err 文本不变,at 一定变)。
 */
describe("deriveOnboarding failNote", () => {
	it("adapter 步失败 → 带出启用适配器的 err 与 lastCheckedAt", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				adapters: [
					{ enabled: true, testStatus: { ok: false, err: "连接被拒绝", lastCheckedAt: "t1" } },
				],
			}),
		);
		expect(v.activeKey).toBe("adapter");
		expect(v.failNote).toEqual({ text: "连接被拒绝", at: "t1" });
	});

	it("err 缺失回落「测试未通过」;disabled 适配器的失败不算", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				adapters: [
					{ enabled: false, testStatus: { ok: false, err: "旧账", lastCheckedAt: "t0" } },
					{ enabled: true, testStatus: { ok: false, lastCheckedAt: "t1" } },
				],
			}),
		);
		expect(v.failNote).toEqual({ text: "测试未通过", at: "t1" });
	});

	it("test 步失败 → 从 targets 带出", () => {
		const v = deriveOnboarding(
			inputs({
				biliLoggedIn: true,
				adapters: [{ enabled: true, testStatus: { ok: true } }],
				targets: [
					{ enabled: true, testStatus: { ok: false, err: "发送超时", lastCheckedAt: "t2" } },
				],
			}),
		);
		expect(v.activeKey).toBe("test");
		expect(v.failNote).toEqual({ text: "发送超时", at: "t2" });
	});

	it("失败不属于当前步就沉默 —— login 未完成时不翻适配器的旧账", () => {
		const v = deriveOnboarding(
			inputs({
				adapters: [{ enabled: true, testStatus: { ok: false, err: "x", lastCheckedAt: "t" } }],
			}),
		);
		expect(v.activeKey).toBe("login");
		expect(v.failNote).toBeNull();
	});
});
