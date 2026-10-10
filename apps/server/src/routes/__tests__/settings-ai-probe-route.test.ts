/**
 * `PATCH /api/settings` 里 AI 探活的接线(3a-38 提交 ④:AI 设置从 `defaults.ai` 上提到顶层 `ai`)。
 *
 * `routes/settings.ts` 里 `pluck` 的路径是手写的字符串数组,类型检查拦不住漏改的那一处:
 * 漏了 `at()` 里的那一处 → 探活拿到的是空 key / 旧 key;漏了 `activeProfile` 那一处 → 换了实例却用旧实例去探。
 * 这里走整条路由、拦住出网的 `fetch`,看探活**真的打了什么**(`shouldRunAiEnableCheck` 的纯函数用例在 `settings.test.ts`)。
 */

import { type GlobalConfig, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createSettingsRoute } from "../settings.js";

function bucket(over: Record<string, unknown> = {}) {
	return {
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
		...over,
	};
}

/** AI 已启用、当前实例 deepseek;另有一份没在用的 deepseek-2(key 不同)。 */
function enabledAiGlobals(): GlobalConfig {
	const g = makeDefaultGlobalConfig();
	g.ai.enabled = true;
	g.ai.activeProfile = "deepseek";
	g.ai.providers = {
		deepseek: bucket(),
		"deepseek-2": bucket({ apiKey: "k-second", baseUrl: "https://second.example.com" }),
	} as unknown as GlobalConfig["ai"]["providers"];
	return g;
}

interface Probe {
	url: string;
	authorization: string;
}

function setup(current: GlobalConfig) {
	const probes: Probe[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		probes.push({
			url,
			authorization: String((init.headers as Record<string, string>).Authorization),
		});
		return { ok: true, status: 200, text: async () => "" } as unknown as Response;
	});
	const patchSettings = vi.fn(async () => ({ core: current, integrations: {} }));
	const store = {
		getGlobals: () => current,
		getAllIntegrationSettings: () => ({}),
		getTargets: () => [],
		getConnections: () => [],
		patchSettings,
	};
	const deps = {
		store,
		runtime: { serviceCtx: { logger: { error: () => {} } }, engines: undefined },
		puppeteer: null,
		commands: [],
	};
	const route = createSettingsRoute(deps as never);
	const patch = (body: unknown) =>
		route.request("/", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return { probes, patchSettings, patch };
}

afterEach(() => vi.unstubAllGlobals());

describe("PATCH /api/settings — AI 探活用的是新路径 { ai }", () => {
	it("换 key:探活用的是补丁里的新 key(取的是 ai.providers.<id>.apiKey 这一格)", async () => {
		const { probes, patch, patchSettings } = setup(enabledAiGlobals());
		const res = await patch({ ai: { providers: { deepseek: { apiKey: "k-new" } } } });
		expect(res.status).toBe(200);
		expect(probes).toHaveLength(1);
		expect(probes[0]?.authorization).toBe("Bearer k-new");
		expect(probes[0]?.url).toBe("https://api.example.com/chat/completions");
		expect(patchSettings).toHaveBeenCalledTimes(1);
	});

	it("换地址:探活打的是补丁里的新地址", async () => {
		const { probes, patch } = setup(enabledAiGlobals());
		await patch({ ai: { providers: { deepseek: { baseUrl: "https://new.example.com" } } } });
		expect(probes).toHaveLength(1);
		expect(probes[0]?.url).toBe("https://new.example.com/chat/completions");
		expect(probes[0]?.authorization).toBe("Bearer k");
	});

	it("换实例:探活用的是补丁指到的那份实例(activeProfile 取自 ai.activeProfile)", async () => {
		const { probes, patch } = setup(enabledAiGlobals());
		await patch({ ai: { activeProfile: "deepseek-2" } });
		expect(probes).toHaveLength(1);
		expect(probes[0]?.authorization).toBe("Bearer k-second");
		expect(probes[0]?.url).toBe("https://second.example.com/chat/completions");
	});

	it("关了再开:当前关着、补丁打开 → 探活;打的是当前实例", async () => {
		const g = enabledAiGlobals();
		g.ai.enabled = false;
		const { probes, patch } = setup(g);
		await patch({ ai: { enabled: true } });
		expect(probes).toHaveLength(1);
		expect(probes[0]?.authorization).toBe("Bearer k");
	});

	it("探活失败:补丁不落盘,回带标准码的失败", async () => {
		const { patch, patchSettings } = setup(enabledAiGlobals());
		vi.stubGlobal(
			"fetch",
			async () => ({ ok: false, status: 401, text: async () => "no" }) as unknown as Response,
		);
		const res = await patch({ ai: { providers: { deepseek: { apiKey: "bad" } } } });
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(patchSettings).not.toHaveBeenCalled();
	});

	it("只改人格:不探活,照常落盘(对照上面「该触发」的几条)", async () => {
		const { probes, patch, patchSettings } = setup(enabledAiGlobals());
		const res = await patch({ ai: { persona: { name: "恶魔兔" } } });
		expect(res.status).toBe(200);
		expect(probes).toHaveLength(0);
		expect(patchSettings).toHaveBeenCalledTimes(1);
	});

	it("老位置的补丁 { defaults: { ai } } 不再被当成 AI 补丁:不探活", async () => {
		const { probes, patch } = setup(enabledAiGlobals());
		await patch({ defaults: { ai: { providers: { deepseek: { apiKey: "k-new" } } } } });
		expect(probes).toHaveLength(0);
	});
});
