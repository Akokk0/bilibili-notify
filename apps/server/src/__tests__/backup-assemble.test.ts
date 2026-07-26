import { makeDefaultGlobalConfig, type PushAdapter } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { assembleFullBackup, openFullBackup } from "../backup/assemble.js";

/**
 * 完整档组装:明文段走 redactSecretKeys(连完整档明文都零机密),真机密(apiKey /
 * cookie / adapter config)进 PIN 加密块。open 用正确 PIN 把机密并回、重建可落盘
 * 的完整配置 + cookie;错 PIN 抛错。
 */
function withDeepseekKey(g: ReturnType<typeof makeDefaultGlobalConfig>, k: string) {
	g.defaults.ai.provider = "deepseek";
	g.defaults.ai.providers = {
		deepseek: {
			apiKey: k,
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-pro",
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

function globalsWithApiKey(k: string) {
	// 密钥现在住在服务商桶里(各家一套配置);这里固定用 deepseek 桶做样本。
	return withDeepseekKey(makeDefaultGlobalConfig(), k);
}

function onebot(id: string, token: string): PushAdapter {
	return {
		id,
		platform: "onebot",
		name: "bot",
		enabled: true,
		config: {
			transport: "ws",
			url: "ws://host",
			headers: {},
			accessToken: token,
			protocolVersion: "v11",
			timeoutMs: 15_000,
			retryTimes: 0,
			retryIntervalMs: 1_000,
		},
	};
}

describe("full backup assemble/open", () => {
	it("plaintext sections carry NO secret; secrets ride the encrypted block", () => {
		const env = assembleFullBackup(
			{
				globals: globalsWithApiKey("sk-SECRET"),
				adapters: [onebot("a1", "tok-SECRET")],
				cookies: { cookiesJson: '{"SESSDATA":"cookie-SECRET"}', refreshToken: "rt-SECRET" },
			},
			"123456",
			"2026-07-10T00:00:00.000Z",
		);

		expect(env.kind).toBe("full");
		expect(env.secrets).toBeTruthy();
		const plaintext = JSON.stringify(env.sections);
		for (const leaked of ["sk-SECRET", "tok-SECRET", "cookie-SECRET", "rt-SECRET"]) {
			expect(plaintext).not.toContain(leaked);
		}
	});

	it("open with the correct PIN reconstructs the full config + cookies", () => {
		const env = assembleFullBackup(
			{
				globals: globalsWithApiKey("sk-1"),
				adapters: [onebot("a1", "tok-1")],
				cookies: { cookiesJson: "CJ", refreshToken: "RT" },
			},
			"123456",
			"t",
		);

		const { sections, cookies } = openFullBackup(env, "123456");
		expect(sections.globals?.defaults.ai.providers.deepseek?.apiKey).toBe("sk-1");
		expect(sections.adapters?.[0]?.config).toMatchObject({ accessToken: "tok-1" });
		expect(cookies).toEqual({ cookiesJson: "CJ", refreshToken: "RT" });
	});

	it("open with the wrong PIN throws", () => {
		const env = assembleFullBackup({ globals: globalsWithApiKey("sk-1") }, "123456", "t");
		expect(() => openFullBackup(env, "0000")).toThrow();
	});
});
