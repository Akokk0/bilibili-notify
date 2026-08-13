import { makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { checkApprovalEnable, shouldRunAiEnableCheck } from "../globals.js";

/** 默认 globals + AI 启用 + 连接字段齐备。 */
function enabledAiGlobals() {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.enabled = true;
	// 连接字段住在服务商桶里(各家一套配置)。
	g.defaults.ai.activeProfile = "deepseek";
	g.defaults.ai.providers = {
		deepseek: {
			provider: "deepseek",
			apiFlavor: "chat",
			label: "",
			apiKey: "k",
			baseUrl: "https://api.example.com",
			model: "gpt-4o-mini",
			temperature: 0.7,
			enableThinking: false,
			thinkingLevel: "medium",
			extraParams: "",
			enableVision: false,
			vision: { baseUrl: "", apiKey: "", model: "" },
		},
	};
	return g;
}

/** 把桶内字段包成 patch 形状。 */
function aiPatch(bucket: Record<string, unknown>, id = "deepseek") {
	return { defaults: { ai: { providers: { [id]: bucket } } } };
}

describe("shouldRunAiEnableCheck", () => {
	it("改 persona 不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { persona: { name: "恶魔兔" } } } })).toBe(
			false,
		);
	});

	it("改 temperature / prompt 不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { temperature: 0.9 } } })).toBe(false);
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { dynamicPrompt: "x" } } })).toBe(false);
	});

	it("改连接字段 apiKey / baseUrl / model 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }))).toBe(true);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ baseUrl: "https://x" }))).toBe(true);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ model: "m2" }))).toBe(true);
	});

	it("换实例就触发探活 —— 换实例等于换连接,新那份的 key 还没验过", () => {
		const cur = enabledAiGlobals(); // 当前是 deepseek
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { activeProfile: "openrouter" } } })).toBe(
			true,
		);
	});

	it("同一家的另一份实例也算换 —— 两个 DeepSeek 号各有各的 key", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { activeProfile: "deepseek-2" } } })).toBe(
			true,
		);
	});

	it("改的是**别家**桶里的连接字段 → 不触发探活(那家现在没在用)", () => {
		// 探活会真打一次请求。为一个不生效的桶去打,既慢又可能报出让人困惑的错。
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }, "openrouter"))).toBe(false);
	});

	it("enabled 由 false→true 触发探活(即使本次没带连接字段)", () => {
		const cur = enabledAiGlobals();
		cur.defaults.ai.enabled = false;
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { enabled: true } } })).toBe(true);
	});

	it("AI 最终为禁用态:改任何字段都不探活", () => {
		const cur = makeDefaultGlobalConfig(); // disabled
		expect(shouldRunAiEnableCheck(cur, { defaults: { ai: { persona: { name: "x" } } } })).toBe(
			false,
		);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }))).toBe(false);
	});

	it("已启用态重复保存 persona(enabled 维持 true)不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(
			shouldRunAiEnableCheck(cur, { defaults: { ai: { enabled: true, persona: { name: "x" } } } }),
		).toBe(false);
	});

	it("patch 含连接字段但值跟 current 相同 → 不触发探活(前端整段 patch 兼容)", () => {
		const cur = enabledAiGlobals();
		// 模拟 Ai.tsx 现状:用户只改 persona,但前端把整段 defaults.ai 送上,
		// baseUrl/model 跟 current 完全一致(apiKey 经 stripRedactedSecrets 已剔除)。
		const p = cur.defaults.ai.providers.deepseek;
		expect(
			shouldRunAiEnableCheck(cur, {
				defaults: {
					ai: {
						providers: { deepseek: { baseUrl: p?.baseUrl, model: p?.model } },
						persona: { name: "恶魔兔" },
					},
				},
			}),
		).toBe(false);
	});

	it("patch 含连接字段且 baseUrl 真改了 → 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(
			shouldRunAiEnableCheck(cur, {
				defaults: {
					ai: {
						providers: {
							deepseek: {
								baseUrl: "https://api.example.com/v2", // changed
								model: cur.defaults.ai.providers.deepseek?.model, // unchanged
							},
						},
					},
				},
			}),
		).toBe(true);
	});

	it("patch 含连接字段且 model 真改了 → 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(
			shouldRunAiEnableCheck(cur, {
				defaults: {
					ai: {
						providers: {
							deepseek: {
								baseUrl: cur.defaults.ai.providers.deepseek?.baseUrl, // unchanged
								model: "gpt-4o", // changed
							},
						},
					},
				},
			}),
		).toBe(true);
	});
});

/**
 * 审批开关的前置检查。
 *
 * 审批靠主人在 IM 里回一句 y 才走得下去,而独立端的推送通道**大多是只出不进**的
 * —— webhook 更是天生没有回程。在一个收不到回复的通道上把审批打开,结果是每期
 * 周报都生成、都私聊、然后 48 小时后全部超时作废,一份也发不出去,而配置页上
 * 看着一切正常。所以宁可不给开,并说清为什么。
 */
describe("checkApprovalEnable", () => {
	/** 这条检查只读 id / platform 两个字段,不为测试再造一遍完整的 PushTarget。 */
	// biome-ignore lint/suspicious/noExplicitAny: 见上
	type Targets = any;

	function withApproval(on: boolean) {
		const g = makeDefaultGlobalConfig();
		g.roastSchedule = { ...g.roastSchedule, approval: on };
		return g;
	}
	const patchOn = { roastSchedule: { approval: true } };
	const onebotTarget = { id: "m1", platform: "onebot" };
	const webhookTarget = { id: "m1", platform: "webhook" };

	it("master 私聊走 onebot（收得到回复）→ 放行", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		expect(checkApprovalEnable(g, patchOn, [onebotTarget] as Targets).ok).toBe(true);
	});

	it("master 私聊走 webhook（收不到回复）→ 拦下并说明原因", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(g, patchOn, [webhookTarget] as Targets);
		expect(r.ok).toBe(false);
		// 光说「不能开」没用,得让主人知道该去改什么。
		expect(r.ok === false && r.message).toMatch(/webhook|回复|收不到/);
	});

	it("master 私聊走 qq-official（C2C 入站已接）→ 放行", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(g, patchOn, [{ id: "m1", platform: "qq-official" }] as Targets);
		expect(r.ok).toBe(true);
	});

	it("还没接入站的平台 → 拦下，但理由是「还没接」而不是「通道收不到」", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(g, patchOn, [{ id: "m1", platform: "koishi-bot" }] as Targets);
		expect(r.ok).toBe(false);
		// 这些平台协议上都收得到,差的是我们没接。说成平台的毛病,主人会去查自己
		// 的配置(qq-official 就是这么被主人当场抓到的)。
		expect(r.ok === false && r.message).not.toMatch(/只能发不能收/);
		expect(r.ok === false && r.message).toMatch(/还没/);
	});

	it("压根没配 master 私聊目标 → 拦下（没人可审）", () => {
		const g = withApproval(false);
		g.master.targetId = undefined;
		expect(checkApprovalEnable(g, patchOn, []).ok).toBe(false);
	});

	it("这次 patch 没碰 roastSchedule → 不检查（存别的 tab 不该被它拦住）", () => {
		const g = withApproval(true);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(g, { defaults: { cardStyle: {} } }, [webhookTarget] as Targets);
		expect(r.ok).toBe(true);
	});

	it("审批保持关着 → 不检查", () => {
		const g = withApproval(false);
		const r = checkApprovalEnable(g, { roastSchedule: { cron: "0 9 * * 1" } }, [
			webhookTarget,
		] as Targets);
		expect(r.ok).toBe(true);
	});
});

describe("checkAiEnable — 探活打的端点要跟实例的接口风味走", () => {
	const okJson = () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response;

	it("chat 风味(默认)→ 打 /chat/completions", async () => {
		const { checkAiEnable } = await import("../globals.js");
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init.body)) });
			return okJson();
		});
		try {
			const r = await checkAiEnable({
				apiKey: "k",
				baseUrl: "https://api.example.com/",
				model: "m",
				apiFlavor: "chat",
			});
			expect(r.ok).toBe(true);
			expect(calls[0]?.url).toBe("https://api.example.com/chat/completions");
			expect(calls[0]?.body.messages).toBeDefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// responses-only 的模型(o1-pro 这类)在 /chat/completions 上是 404 ——
	// 探活打错端点,用户就被自己的探活永久挡在门外,而真聊天路径本来能通。
	it("responses 风味 → 打 /responses,body 是 input 形状且不带 temperature", async () => {
		const { checkAiEnable } = await import("../globals.js");
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init.body)) });
			return okJson();
		});
		try {
			const r = await checkAiEnable({
				apiKey: "k",
				baseUrl: "https://api.example.com",
				model: "o1-pro",
				apiFlavor: "responses",
			});
			expect(r.ok).toBe(true);
			expect(calls[0]?.url).toBe("https://api.example.com/responses");
			expect(calls[0]?.body.input).toBeDefined();
			expect(calls[0]?.body.messages).toBeUndefined();
			// o 系推理模型会 400 拒掉 temperature —— 探活自己不能先踩雷
			expect("temperature" in (calls[0]?.body ?? {})).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
