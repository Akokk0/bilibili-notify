import { type Connection, makeDefaultGlobalConfig } from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import { assembleFullBackup, openFullBackup } from "../backup/assemble.js";
import { sealSecrets } from "../backup/crypto.js";
import type { BackupEnvelope } from "../backup/envelope.js";

/**
 * 完整档组装:明文段走 redactSecretKeys(连完整档明文都零机密),真机密(apiKey /
 * cookie / adapter config)进 PIN 加密块。open 用正确 PIN 把机密并回、重建可落盘
 * 的完整配置 + cookie;错 PIN 抛错。
 */
function withDeepseekKey(g: ReturnType<typeof makeDefaultGlobalConfig>, k: string) {
	g.defaults.ai.activeProfile = "deepseek";
	g.defaults.ai.providers = {
		deepseek: {
			provider: "deepseek",
			apiFlavor: "chat",
			label: "",
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

function onebot(id: string, token: string): Connection {
	return {
		id,
		platform: "onebot",
		name: "bot",
		enabled: true,
		kind: "direct",
		connector: "ws",
		config: {
			transport: "ws",
			url: "ws://host",
			headers: {},
			accessToken: token,
			protocolVersion: "v11",
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			forwardMinTimeoutMs: 60_000,
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
				connections: [onebot("a1", "tok-SECRET")],
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
				connections: [onebot("a1", "tok-1")],
				cookies: { cookiesJson: "CJ", refreshToken: "RT" },
			},
			"123456",
			"t",
		);

		const { sections, cookies } = openFullBackup(env, "123456");
		expect(sections.globals?.defaults.ai.providers.deepseek?.apiKey).toBe("sk-1");
		expect(sections.connections?.[0]?.config).toMatchObject({ accessToken: "tok-1" });
		expect(cookies).toEqual({ cookiesJson: "CJ", refreshToken: "RT" });
	});

	it("open with the wrong PIN throws", () => {
		const env = assembleFullBackup({ globals: globalsWithApiKey("sk-1") }, "123456", "t");
		expect(() => openFullBackup(env, "0000")).toThrow();
	});

	/**
	 * 🔴 **凡是明文段被抹掉的,加密袋里都要有对应项** —— 完整档的不变式。
	 *
	 * 袋子从前是一份手抄清单(aiApiKeys / cookie / connectionConfigs),而抹的那一侧是
	 * 结构性的深度遍历,两边早就漂了:`url` / `baseUrl` 一律被换成
	 * `https://redacted.invalid/`,而袋子里一格都没有 —— 恢复之后 AI 的 baseUrl 与市场
	 * 源的地址全是占位符,DNS 永远解析不了,而恢复流程一句话都不会说。
	 */
	it("被抹成占位符的 URL 原样恢复:AI 的 baseUrl、市场源的地址", () => {
		const globals = globalsWithApiKey("sk-1");
		globals.marketplace.sources = [
			{ id: "s1", name: "阿库娅的源", url: "https://ext.example.com/index.json" },
		];
		const env = assembleFullBackup({ globals }, "123456", "t");

		// 明文段照旧一个真地址都不带。
		const plaintext = JSON.stringify(env.sections);
		expect(plaintext).not.toContain("api.deepseek.com");
		expect(plaintext).not.toContain("ext.example.com");

		const { sections } = openFullBackup(env, "123456");
		expect(sections.globals?.defaults.ai.providers.deepseek?.baseUrl).toBe(
			"https://api.deepseek.com",
		);
		expect(sections.globals?.marketplace.sources[0]?.url).toBe(
			"https://ext.example.com/index.json",
		);
	});

	/**
	 * 拓展自己那份设置(桥的接入 token 住这儿)同样在明文段被抹平 —— 袋子里没有它,
	 * 恢复之后每一条接入都连不上,主人得照着插件那边重抄一遍 token。
	 */
	it("拓展 settings 里的密钥原样恢复", () => {
		const globals = makeDefaultGlobalConfig();
		globals.extensions = {
			bridge: { enabled: true, settings: { links: [{ name: "家里那台", token: "tok-SECRET" }] } },
		};
		const env = assembleFullBackup({ globals }, "123456", "t");
		expect(JSON.stringify(env.sections)).not.toContain("tok-SECRET");

		const { sections } = openFullBackup(env, "123456");
		expect(sections.globals?.extensions.bridge?.settings).toEqual({
			links: [{ name: "家里那台", token: "tok-SECRET" }],
		});
	});

	/**
	 * 拓展没跑起来时它的 config 被整片当密钥抹掉(见 sanitize 那边的理由)——
	 * 完整档必须照样原样还回来,否则「关掉一个拓展再备份」就等于把那些连接毁了。
	 */
	it("没跑起来的拓展:整片抹掉的 config 也原样恢复", () => {
		const extension = {
			id: "c1",
			name: "阿库娅",
			enabled: true,
			kind: "extension",
			extensionId: "bridge",
			platform: "telegram",
			config: { botKey: "s3cret", note: "家里那台" },
		} as unknown as Connection;
		const env = assembleFullBackup({ connections: [extension] }, "123456", "t");
		expect(env.sections.connections?.[0]?.config).toEqual({ botKey: "", note: "" });

		const { sections } = openFullBackup(env, "123456");
		expect(sections.connections?.[0]?.config).toEqual({ botKey: "s3cret", note: "家里那台" });
	});

	it("老备份的加密袋里那格叫 adapterConfigs,也要认", () => {
		// 明文段的凭据是抹平过的,真值只在袋里 —— 认不出老键名不会报错,只会让主人
		// 恢复出一堆没有 token 的连接,而他要到发第一条推送时才发现。
		const bag = {
			connectionConfigs: undefined,
			adapterConfigs: { a1: { accessToken: "tok-old" } },
		};
		const env = assembleFullBackup(
			{ connections: [onebot("a1", "tok-1")] },
			"123456",
			"t",
		) as BackupEnvelope;
		env.secrets = sealSecrets("123456", bag);

		const { sections } = openFullBackup(env, "123456");
		expect(sections.connections?.[0]?.config).toMatchObject({ accessToken: "tok-old" });
	});
});
