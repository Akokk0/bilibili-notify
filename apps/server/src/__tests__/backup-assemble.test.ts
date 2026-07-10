import { makeDefaultGlobalConfig, type PushAdapter } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { assembleFullBackup, openFullBackup } from "../backup/assemble.js";

/**
 * 完整档组装:明文段走 redactSecretKeys(连完整档明文都零机密),真机密(apiKey /
 * cookie / adapter config)进 PIN 加密块。open 用正确 PIN 把机密并回、重建可落盘
 * 的完整配置 + cookie;错 PIN 抛错。
 */
function globalsWithApiKey(k: string) {
	const g = makeDefaultGlobalConfig();
	g.defaults.ai.apiKey = k;
	return g;
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
			"1234",
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
			"1234",
			"t",
		);

		const { sections, cookies } = openFullBackup(env, "1234");
		expect(sections.globals?.defaults.ai.apiKey).toBe("sk-1");
		expect(sections.adapters?.[0]?.config).toMatchObject({ accessToken: "tok-1" });
		expect(cookies).toEqual({ cookiesJson: "CJ", refreshToken: "RT" });
	});

	it("open with the wrong PIN throws", () => {
		const env = assembleFullBackup({ globals: globalsWithApiKey("sk-1") }, "1234", "t");
		expect(() => openFullBackup(env, "0000")).toThrow();
	});
});
