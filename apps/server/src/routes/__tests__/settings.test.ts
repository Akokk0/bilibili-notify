import { type ConnectionCapabilities, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { checkApprovalEnable, shouldRunAiEnableCheck } from "../settings.js";

/** 默认 globals + AI 启用 + 连接字段齐备。 */
function enabledAiGlobals() {
	const g = makeDefaultGlobalConfig();
	g.ai.enabled = true;
	// 连接字段住在服务商桶里(各家一套配置)。
	g.ai.activeProfile = "deepseek";
	g.ai.providers = {
		deepseek: {
			provider: "deepseek",
			apiFlavor: "chat",
			label: "",
			apiKey: "k",
			baseUrl: "https://api.example.com",
			model: "gpt-4o-mini",
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
	return { ai: { providers: { [id]: bucket } } };
}

describe("shouldRunAiEnableCheck", () => {
	it("改 persona 不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { ai: { persona: { name: "恶魔兔" } } })).toBe(false);
	});

	it("改 prompt 不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { ai: { dynamicPrompt: "x" } })).toBe(false);
	});

	// 「不触发」的用例换了路径就什么都取不到、自然不触发 —— 这条是对照:同一份当前配置,
	// 新路径上改连接字段**会**触发,老路径(`defaults.ai`)上的补丁什么都不是。
	it("对照:新路径 { ai } 上改 key 会触发;老路径 { defaults: { ai } } 上的同一发不再触发", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { ai: { providers: { deepseek: { apiKey: "k2" } } } })).toBe(
			true,
		);
		expect(
			shouldRunAiEnableCheck(cur, {
				defaults: { ai: { providers: { deepseek: { apiKey: "k2" } } } },
			}),
		).toBe(false);
	});

	it("改连接字段 apiKey / baseUrl / model 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }))).toBe(true);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ baseUrl: "https://x" }))).toBe(true);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ model: "m2" }))).toBe(true);
	});

	it("换实例就触发探活 —— 换实例等于换连接,新那份的 key 还没验过", () => {
		const cur = enabledAiGlobals(); // 当前是 deepseek
		expect(shouldRunAiEnableCheck(cur, { ai: { activeProfile: "openrouter" } })).toBe(true);
	});

	it("同一家的另一份实例也算换 —— 两个 DeepSeek 号各有各的 key", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { ai: { activeProfile: "deepseek-2" } })).toBe(true);
	});

	it("改的是**别家**桶里的连接字段 → 不触发探活(那家现在没在用)", () => {
		// 探活会真打一次请求。为一个不生效的桶去打,既慢又可能报出让人困惑的错。
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }, "openrouter"))).toBe(false);
	});

	it("enabled 由 false→true 触发探活(即使本次没带连接字段)", () => {
		const cur = enabledAiGlobals();
		cur.ai.enabled = false;
		expect(shouldRunAiEnableCheck(cur, { ai: { enabled: true } })).toBe(true);
	});

	it("关了再开:当前已启用 → 补丁关掉不探活;当前关着 → 补丁再开触发(新路径)", () => {
		const on = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(on, { ai: { enabled: false } })).toBe(false);
		const off = enabledAiGlobals();
		off.ai.enabled = false;
		expect(shouldRunAiEnableCheck(off, { ai: { enabled: true } })).toBe(true);
	});

	it("AI 最终为禁用态:改任何字段都不探活", () => {
		const cur = makeDefaultGlobalConfig(); // disabled
		expect(shouldRunAiEnableCheck(cur, { ai: { persona: { name: "x" } } })).toBe(false);
		expect(shouldRunAiEnableCheck(cur, aiPatch({ apiKey: "k2" }))).toBe(false);
	});

	it("已启用态重复保存 persona(enabled 维持 true)不触发探活", () => {
		const cur = enabledAiGlobals();
		expect(shouldRunAiEnableCheck(cur, { ai: { enabled: true, persona: { name: "x" } } })).toBe(
			false,
		);
	});

	it("patch 含连接字段但值跟 current 相同 → 不触发探活(前端整段 patch 兼容)", () => {
		const cur = enabledAiGlobals();
		// 模拟 Ai.tsx 现状:用户只改 persona,但前端把整段 ai 送上,
		// baseUrl/model 跟 current 完全一致(没动的 apiKey 面板不发)。
		const p = cur.ai.providers.deepseek;
		expect(
			shouldRunAiEnableCheck(cur, {
				ai: {
					providers: { deepseek: { baseUrl: p?.baseUrl, model: p?.model } },
					persona: { name: "恶魔兔" },
				},
			}),
		).toBe(false);
	});

	it("patch 含连接字段且 baseUrl 真改了 → 触发探活", () => {
		const cur = enabledAiGlobals();
		expect(
			shouldRunAiEnableCheck(cur, {
				ai: {
					providers: {
						deepseek: {
							baseUrl: "https://api.example.com/v2", // changed
							model: cur.ai.providers.deepseek?.model, // unchanged
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
				ai: {
					providers: {
						deepseek: {
							baseUrl: cur.ai.providers.deepseek?.baseUrl, // unchanged
							model: "gpt-4o", // changed
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
	// biome-ignore lint/suspicious/noExplicitAny: 同上
	type Connections = any;

	function withApproval(on: boolean) {
		const g = makeDefaultGlobalConfig();
		g.roastSchedule = { ...g.roastSchedule, approval: on };
		return g;
	}
	const patchOn = { roastSchedule: { approval: true } };
	// 目标自己没有平台这一格,它挂在连接 c1 上;能不能收到回复问 c1 的 inbound 能力。
	const target = { id: "m1", connectionId: "c1" };
	const conns = [{ id: "c1" }] as Connections;
	const unknown = { state: "unknown" } as const;
	const inbound = (i: ConnectionCapabilities["inbound"]) => (id: string) =>
		id === "c1" ? { atAll: unknown, inbound: i, miniAppCard: unknown } : undefined;
	const receives = inbound({ state: "supported", checkedAt: 1 });
	const noReturnPath = inbound({
		state: "unsupported",
		reason: "webhook 只是一个出站 HTTP 请求、没有回程，主人没法在上面回话",
		checkedAt: 1,
	});
	const notKnown = inbound({ state: "unknown" });

	it("master 私聊走 onebot（收得到回复）→ 放行", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		expect(checkApprovalEnable(g, patchOn, [target] as Targets, conns, receives).ok).toBe(true);
	});

	it("master 私聊走 webhook（收不到回复）→ 拦下并说明原因", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(g, patchOn, [target] as Targets, conns, noReturnPath);
		expect(r.ok).toBe(false);
		// 光说「不能开」没用,得让主人知道该去改什么。
		expect(r.ok === false && r.message).toMatch(/webhook|回复|收不到/);
	});

	it("master 私聊那条连接的 inbound 是支持（比如 qq-official 的 C2C 入站已接）→ 放行", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(g, patchOn, [target] as Targets, conns, receives);
		expect(r.ok).toBe(true);
	});

	it("inbound 还不知道 → 拦下，但理由是「还不知道」而不是「通道收不到」", () => {
		const g = withApproval(false);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(g, patchOn, [target] as Targets, conns, notKnown);
		expect(r.ok).toBe(false);
		// 还不知道不是平台的毛病,说成「只能发不能收」主人会去查自己的配置
		// (qq-official 就是这么被主人当场抓到的)。
		expect(r.ok === false && r.message).not.toMatch(/只能发不能收/);
		expect(r.ok === false && r.message).toMatch(/还不知道/);
	});

	it("压根没配 master 私聊目标 → 拦下（没人可审）", () => {
		const g = withApproval(false);
		g.master.targetId = undefined;
		expect(checkApprovalEnable(g, patchOn, [], [], receives).ok).toBe(false);
	});

	it("这次 patch 没碰 roastSchedule → 不检查（存别的 tab 不该被它拦住）", () => {
		const g = withApproval(true);
		g.master.targetId = "m1";
		const r = checkApprovalEnable(
			g,
			{ defaults: { cards: {} } },
			[target] as Targets,
			conns,
			noReturnPath,
		);
		expect(r.ok).toBe(true);
	});

	it("审批保持关着 → 不检查", () => {
		const g = withApproval(false);
		const r = checkApprovalEnable(
			g,
			{ roastSchedule: { cron: "0 9 * * 1" } },
			[target] as Targets,
			conns,
			noReturnPath,
		);
		expect(r.ok).toBe(true);
	});
});

describe("checkAiEnable — 探活打的端点要跟实例的接口风味走", () => {
	const okJson = () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response;

	it("chat 风味(默认)→ 打 /chat/completions", async () => {
		const { checkAiEnable } = await import("../settings.js");
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

	// temperature 已整个退役、真聊天路径一律不发;探活要是还带着,Claude Opus 4.7 起的
	// 模型与 OpenAI 推理模型会 400 拒掉这一发,主人就被探活挡在门外,而真聊天本来能通。
	it("chat 风味的 ping 同样不带 temperature —— 探活不能比真聊天多踩一颗雷", async () => {
		const { checkAiEnable } = await import("../settings.js");
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init.body)) });
			return okJson();
		});
		try {
			const r = await checkAiEnable({
				apiKey: "k",
				baseUrl: "https://api.example.com",
				model: "claude-opus-4-7",
				apiFlavor: "chat",
			});
			expect(r.ok).toBe(true);
			expect(calls[0]?.url).toBe("https://api.example.com/chat/completions");
			expect("temperature" in (calls[0]?.body ?? {})).toBe(false);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// responses-only 的模型(o1-pro 这类)在 /chat/completions 上是 404 ——
	// 探活打错端点,用户就被自己的探活永久挡在门外,而真聊天路径本来能通。
	it("responses 风味 → 打 /responses,body 是 input 形状且不带 temperature", async () => {
		const { checkAiEnable } = await import("../settings.js");
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

/**
 * 启用前的探活没过,回的是带标准码的失败(ADR-0026):要主人回去改配置的 `not_configured`,
 * 对端暂时不行的 `unavailable`,限速 `rate_limited`,超时 `timeout`。平台自己的 HTTP 状态放
 * `upstreamCode`,不占 `code`。
 */
describe("checkAiEnable — 没过的带标准码", () => {
	const fields = { apiKey: "k", baseUrl: "https://api.example.com", model: "m", apiFlavor: "chat" };

	function stubFetch(handler: () => Promise<Response>): void {
		vi.stubGlobal("fetch", handler);
	}
	const httpResponse = (status: number, text = "boom") =>
		({ ok: false, status, text: async () => text }) as unknown as Response;

	it.each(["apiKey", "baseUrl", "model"] as const)("%s 是空的 → not_configured", async (field) => {
		const { checkAiEnable } = await import("../settings.js");
		const r = await checkAiEnable({ ...fields, [field]: "" });
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
		expect(r.ok === false && r.message).toContain(field);
	});

	it.each([
		[401, "not_configured"],
		[403, "not_configured"],
		[404, "not_configured"],
		[429, "rate_limited"],
		[500, "unavailable"],
		[503, "unavailable"],
		[400, "unavailable"],
	] as const)("HTTP %i → %s,状态码放 upstreamCode", async (status, code) => {
		const { checkAiEnable } = await import("../settings.js");
		stubFetch(async () => httpResponse(status));
		try {
			const r = await checkAiEnable(fields);
			expect(r).toMatchObject({ ok: false, code, upstreamCode: status });
			expect(r.ok === false && r.message).toContain(`HTTP ${status}`);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("连不上 → unavailable,话里带底层的原因", async () => {
		const { checkAiEnable } = await import("../settings.js");
		stubFetch(async () => {
			throw new TypeError("fetch failed");
		});
		try {
			const r = await checkAiEnable(fields);
			expect(r).toMatchObject({ ok: false, code: "unavailable" });
			expect(r.ok === false && r.message).toContain("fetch failed");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("超时 → timeout", async () => {
		const { checkAiEnable } = await import("../settings.js");
		stubFetch(async () => {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		});
		try {
			const r = await checkAiEnable(fields);
			expect(r).toMatchObject({ ok: false, code: "timeout" });
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("checkApprovalEnable — 拦下的一律是 not_configured", () => {
	function withApproval(on: boolean) {
		const g = makeDefaultGlobalConfig();
		g.roastSchedule = { ...g.roastSchedule, approval: on };
		return g;
	}
	const patchOn = { roastSchedule: { approval: true } };

	const noReturnPath = (id: string): ConnectionCapabilities | undefined =>
		id === "c1"
			? {
					atAll: { state: "unknown" },
					inbound: { state: "unsupported", reason: "没有回程", checkedAt: 1 },
					miniAppCard: { state: "unknown" },
				}
			: undefined;

	it.each([
		["没配主人私聊目标", undefined, [], []],
		["主人私聊目标已经不存在了", "gone", [], []],
		[
			"主人私聊目标那条连接的 inbound 不支持(没有回程)",
			"m1",
			[{ id: "m1", connectionId: "c1" }],
			[{ id: "c1" }],
		],
		["主人私聊目标挂的连接已经不在了", "m1", [{ id: "m1", connectionId: "c1" }], []],
	] as const)("%s → not_configured", (_what, masterTargetId, targets, connections) => {
		const g = withApproval(false);
		g.master.targetId = masterTargetId;
		const r = checkApprovalEnable(g, patchOn, targets as never, connections as never, noReturnPath);
		expect(r).toMatchObject({ ok: false, code: "not_configured" });
	});
});
