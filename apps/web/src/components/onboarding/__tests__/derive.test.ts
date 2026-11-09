/**
 * 新手导览的判据核心(2026-08-29 grilling 定案:5 步全机器判据、按结果态建模)。
 *
 * 步骤链(五轮定稿顺序:先打通推送通道,订阅放最后 —— 订阅表单要勾推送目标,
 * 先订阅的话通道没就绪还得回头重编辑):①B站登录 ②连接存在且 test 通过
 * ③启用的推送目标存在 ④target 测试推送成功 ⑤订阅数>0。可选尾巴(image/ai)
 * 不计毕业。
 *
 * 钉住的边界:
 * - adapter 步要求 **enabled 且 probeState.status 为 reachable** —— 只建不测不算(定案原文
 *   「adapter 存在且 test 通过」);disabled 的 adapter 测过也不算,它不会参与推送。
 * - target 步要求 enabled;test 步只看「任一 target 测试成功过」不看 enabled ——
 *   测通后禁用目标,test 不回退(test=证明过整条链路通,不是当前时刻的可推送性),
 *   但 target 步会退回未完成,active 指回它。
 * - `active` 是第一个未完成步,全绿则无 —— 导览靠它高亮「现在该做哪步」。
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { i18n } from "../../../i18n";
import { deriveOnboarding, type OnboardingInputs } from "../derive";

function inputs(partial: Partial<OnboardingInputs>): OnboardingInputs {
	return {
		accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: false }],
		subsCount: 0,
		connections: [],
		targets: [],
		modules: undefined,
		...partial,
	};
}

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

it.each([
	["en", "Test failed"],
	["ja", "テストに失敗しました"],
	["zh-TW", "測試未通過"],
] as const)(
	"%s translates a missing test reason while preserving original diagnostics and progress",
	(locale, fallback) => {
		i18n.set({ locale, voice: "plain" });
		const base = inputs({
			accounts: [{ sourceKey: "original.source", label: "Original source 原文", loggedIn: true }],
			connections: [
				{ enabled: true, probeState: { status: "unreachable", lastCheckedAt: "original-at" } },
			],
		});
		const missing = deriveOnboarding(base);
		expect(missing.failNote).toEqual({ text: fallback, at: "original-at" });
		expect(missing.activeKey).toBe("connection");
		expect(missing.steps[0]).toEqual({
			key: "login",
			sourceKey: "original.source",
			label: "Original source 原文",
			done: true,
		});
		const raw = deriveOnboarding({
			...base,
			connections: [
				{
					enabled: true,
					probeState: {
						status: "unreachable",
						message: "Original diagnostic 原文",
						lastCheckedAt: "raw-at",
					},
				},
			],
		});
		expect(raw.failNote).toEqual({ text: "Original diagnostic 原文", at: "raw-at" });
		i18n.set({ locale: "zh-CN", voice: "plain" });
		expect(missing.failNote?.text).toBe("测试未通过");
		expect(raw.failNote?.text).toBe("Original diagnostic 原文");
	},
);

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
		const v = deriveOnboarding(
			inputs({ accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }] }),
		);
		expect(stepMap(v)).toMatchObject({ login: true, connection: false, subs: false });
		expect(v.activeKey).toBe("connection");
	});

	it("adapter 只建不测 → adapter 步未完成(定案:存在且 test 通过)", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				connections: [{ enabled: true, probeState: undefined }],
			}),
		);
		expect(stepMap(v).connection).toBe(false);
		// 但 hasConnection 已亮 —— 导览靠它把子步从「新建」翻到「测试连通」,灯不断档
		expect(v.hasConnection).toBe(true);
	});

	it("hasConnection:没建过任何连接时为 false", () => {
		expect(deriveOnboarding(inputs({})).hasConnection).toBe(false);
	});

	it("disabled 的 adapter 测过也不算 —— 它不参与推送", () => {
		const v = deriveOnboarding(
			inputs({
				connections: [{ enabled: false, probeState: { status: "reachable", lastCheckedAt: "t" } }],
			}),
		);
		expect(stepMap(v).connection).toBe(false);
	});

	it("adapter 测过 + 启用目标存在 → active=test", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				connections: [{ enabled: true, probeState: { status: "reachable", lastCheckedAt: "t" } }],
				targets: [{ enabled: true, reachability: undefined }],
			}),
		);
		expect(v.doneCount).toBe(3);
		expect(v.activeKey).toBe("test");
	});

	it("测试推送成功但还没订阅 → 通道全通,active=subs 收尾", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				connections: [{ enabled: true, probeState: { status: "reachable", lastCheckedAt: "t" } }],
				targets: [{ enabled: true, reachability: { status: "reachable", changedAt: "t" } }],
			}),
		);
		expect(v.doneCount).toBe(4);
		expect(v.activeKey).toBe("subs");
		expect(v.allDone).toBe(false);
	});

	it("订阅补上 → 全绿毕业,无 active", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				subsCount: 1,
				connections: [{ enabled: true, probeState: { status: "reachable", lastCheckedAt: "t" } }],
				targets: [{ enabled: true, reachability: { status: "reachable", changedAt: "t" } }],
			}),
		);
		expect(v.allDone).toBe(true);
		expect(v.activeKey).toBeNull();
	});

	it("测通后禁用目标:test 不回退,但 target 步退回未完成并成为 active", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				subsCount: 1,
				connections: [{ enabled: true, probeState: { status: "reachable", lastCheckedAt: "t" } }],
				targets: [{ enabled: false, reachability: { status: "reachable", changedAt: "t" } }],
			}),
		);
		const m = stepMap(v);
		expect(m.test).toBe(true);
		expect(m.target).toBe(false);
		expect(v.activeKey).toBe("target");
		expect(v.allDone).toBe(false);
	});

	it("测试失败(ok:false)→ test 步未完成", () => {
		const v = deriveOnboarding(
			inputs({
				targets: [{ enabled: true, reachability: { status: "unreachable", changedAt: "t" } }],
			}),
		);
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
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				subsCount: 1,
				connections: [{ enabled: true, probeState: { status: "reachable", lastCheckedAt: "t" } }],
				targets: [{ enabled: true, reachability: { status: "reachable", changedAt: "t" } }],
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
	it("adapter 步失败 → 带出启用连接的 err 与 lastCheckedAt", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				connections: [
					{
						enabled: true,
						probeState: { status: "unreachable", message: "连接被拒绝", lastCheckedAt: "t1" },
					},
				],
			}),
		);
		expect(v.activeKey).toBe("connection");
		expect(v.failNote).toEqual({ text: "连接被拒绝", at: "t1" });
	});

	it("err 缺失回落「测试未通过」;disabled 连接的失败不算", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				connections: [
					{
						enabled: false,
						probeState: { status: "unreachable", message: "旧账", lastCheckedAt: "t0" },
					},
					{ enabled: true, probeState: { status: "unreachable", lastCheckedAt: "t1" } },
				],
			}),
		);
		expect(v.failNote).toEqual({ text: "测试未通过", at: "t1" });
	});

	it("test 步失败 → 从 targets 带出", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				connections: [{ enabled: true, probeState: { status: "reachable", lastCheckedAt: "t" } }],
				targets: [
					{
						enabled: true,
						reachability: { status: "unreachable", message: "发送超时", changedAt: "t2" },
					},
				],
			}),
		);
		expect(v.activeKey).toBe("test");
		expect(v.failNote).toEqual({ text: "发送超时", at: "t2" });
	});

	/**
	 * 与上面那条 adapter 的镜像。test 步的 **done** 判据刻意不看 enabled(测通过
	 * 就算数,事后禁用不该把它收回去)—— 但**失败**是另一回事:用户此刻要测的是
	 * 那些还启用着的目标,被禁用目标上周留下的旧账既不是他的问题,也不是他改得动
	 * 的东西。不过滤的话小卡会拿旧账当当前失败讲(2026-08-31 审查)。
	 */
	it("test 步:disabled 目标的旧失败不算 —— 讲的必须是用户此刻要测的那条", () => {
		const v = deriveOnboarding(
			inputs({
				accounts: [{ sourceKey: "demo", label: "演示来源", loggedIn: true }],
				connections: [{ enabled: true, probeState: { status: "reachable", lastCheckedAt: "t" } }],
				targets: [
					{
						enabled: false,
						reachability: { status: "unreachable", message: "上周的旧账", changedAt: "t0" },
					},
					{ enabled: true },
				],
			}),
		);
		expect(v.activeKey).toBe("test");
		expect(v.failNote).toBeNull();
	});

	it("失败不属于当前步就沉默 —— login 未完成时不翻连接的旧账", () => {
		const v = deriveOnboarding(
			inputs({
				connections: [
					{
						enabled: true,
						probeState: { status: "unreachable", message: "x", lastCheckedAt: "t" },
					},
				],
			}),
		);
		expect(v.activeKey).toBe("login");
		expect(v.failNote).toBeNull();
	});
});

it("每个来源各有登录步骤，零来源直接从连接开始", () => {
	const common = { subsCount: 0, connections: [], targets: [], modules: undefined };
	const accounts = [
		{ sourceKey: "library", label: "书库", loggedIn: true },
		{ sourceKey: "radio", label: "电台", loggedIn: false },
	];
	const view = deriveOnboarding({ ...common, accounts });
	expect(
		view.steps
			.filter((step) => step.key === "login")
			.map((step) => ({ sourceKey: step.sourceKey, done: step.done })),
	).toEqual([
		{ sourceKey: "library", done: true },
		{ sourceKey: "radio", done: false },
	]);
	expect(view.activeSource).toEqual({ sourceKey: "radio", label: "电台", loggedIn: false });
	expect(view.doneCount).toBe(1);
	const empty = deriveOnboarding({ ...common, accounts: [] });
	expect(empty.steps.map((step) => step.key)).toEqual(["connection", "target", "test", "subs"]);
	expect(empty.activeKey).toBe("connection");
});
