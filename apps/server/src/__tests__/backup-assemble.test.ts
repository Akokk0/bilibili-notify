import {
	type Connection,
	makeDefaultGlobalConfig,
	OnebotConnectionSettingsSchema,
	QQOfficialConnectionSettingsSchema,
	WebhookConnectionSettingsSchema,
} from "@bilibili-notify/internal";
import { describe, expect, it } from "vite-plus/test";
import type { ZodType } from "zod";
import { assembleFullBackup, openFullBackup } from "../backup/assemble.js";
import {
	BackupPinError,
	type BackupSecretBag,
	type EncryptedSecrets,
	openSecrets,
	sealSecrets,
} from "../backup/crypto.js";
import { buildBackup } from "../backup/envelope.js";
import { BackupRejectedError } from "../backup/rejected-error.js";
import type { SecretCellsReader } from "../push/connection-settings.js";
import { snapshotFor } from "./support/connection-snapshot.js";

/**
 * 完整档组装:明文段走 redactSecretKeys(连完整档明文都零机密),真机密(apiKey /
 * cookie / adapter config)进 PIN 加密块。open 用正确 PIN 把机密并回、重建可落盘
 * 的完整配置 + cookie;错 PIN 抛错。
 */
function withDeepseekKey(g: ReturnType<typeof makeDefaultGlobalConfig>, k: string) {
	g.ai.activeProfile = "deepseek";
	g.ai.providers = {
		deepseek: {
			provider: "deepseek",
			apiFlavor: "chat",
			label: "",
			apiKey: k,
			baseUrl: "https://api.deepseek.com",
			model: "deepseek-v4-pro",
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

/** 内置三个适配器在场(各回自己的真 schema)、没有拓展声明 —— 即生产里一个拓展都没装时的查表。 */
const SCHEMAS = new Map<string, ZodType>([
	["onebot", OnebotConnectionSettingsSchema],
	["qq-official", QQOfficialConnectionSettingsSchema],
	["webhook", WebhookConnectionSettingsSchema],
]);
const BUILTINS: SecretCellsReader = {
	settingsSchemaOf: (key) => SCHEMAS.get(key),
	declaredSecretKeysOf: () => undefined,
};

function onebot(id: string, token: string): Connection {
	return {
		id,
		platform: "onebot",
		name: "bot",
		enabled: true,
		adapterKey: "onebot",
		platformSnapshot: snapshotFor("onebot"),
		settings: {
			transport: "ws",
			url: "ws://host",
			headers: {},
			accessToken: token,
			protocolVersion: "v11",
			timeoutMs: 15_000,
			imageMinTimeoutMs: 30_000,
			mergeForwardMinTimeoutMs: 60_000,
			maxRetries: 0,
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
				integrationSecrets: {
					bilibili: {
						"http.cookies": '[{"name":"SESSDATA","value":"cookie-SECRET"}]',
						refreshToken: "rt-SECRET",
					},
				},
			},
			"123456",
			"2026-07-10T00:00:00.000Z",
			BUILTINS,
		);

		expect(env.kind).toBe("full");
		expect(env.secrets).toBeTruthy();
		const plaintext = JSON.stringify(env.sections);
		for (const leaked of ["sk-SECRET", "tok-SECRET", "cookie-SECRET", "rt-SECRET"]) {
			expect(plaintext).not.toContain(leaked);
		}
	});

	it("open with the correct PIN reconstructs the full config + every integration's secrets bag", () => {
		const integrationSecrets = {
			bilibili: { "http.cookies": "CJ", refreshToken: "RT" },
			onebot: { token: { nested: [1, true, null] } },
		};
		const env = assembleFullBackup(
			{
				globals: globalsWithApiKey("sk-1"),
				connections: [onebot("a1", "tok-1")],
				integrationSecrets,
			},
			"123456",
			"t",
			BUILTINS,
		);

		const opened = openFullBackup(env, "123456");
		expect(opened.sections.globals?.ai.providers.deepseek?.apiKey).toBe("sk-1");
		expect(opened.sections.connections?.[0]?.settings).toMatchObject({ accessToken: "tok-1" });
		expect(opened.integrationSecrets).toEqual(integrationSecrets);
	});

	it("没有任何集成密钥(或全是空的)→ 袋里不放这一格,开袋得到 {}", () => {
		for (const integrationSecrets of [undefined, {}]) {
			const env = assembleFullBackup(
				{ globals: globalsWithApiKey("sk-1"), integrationSecrets },
				"123456",
				"t",
			);
			const bag = openSecrets("123456", env.secrets as EncryptedSecrets);
			expect(bag.integrationSecrets).toBeUndefined();
			expect(openFullBackup(env, "123456").integrationSecrets).toEqual({});
		}
	});

	describe("开袋核密钥格的形状:不对的整份拒收(invalid)", () => {
		function envWithBag(bag: unknown) {
			return buildBackup({
				kind: "full",
				createdAt: "t",
				sections: {},
				secrets: sealSecrets("123456", bag as BackupSecretBag),
			});
		}

		it.each([
			["integrationSecrets 不是对象", { integrationSecrets: "oops" }],
			["integrationSecrets 是数组", { integrationSecrets: [] }],
			["某个集成那一格是字符串", { integrationSecrets: { bilibili: "oops" } }],
			["某个集成那一格是数组", { integrationSecrets: { bilibili: { a: 1 }, onebot: [] } }],
			["某个集成那一格是 null", { integrationSecrets: { bilibili: null } }],
		])("%s", (_name, bag) => {
			let thrown: unknown;
			try {
				openFullBackup(envWithBag(bag), "123456");
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(BackupRejectedError);
			expect(thrown).toMatchObject({ code: "invalid" });
			expect((thrown as Error).message).toMatch(/密钥/);
		});
	});

	it("open with the wrong PIN throws BackupPinError (invalid,中文原因)", () => {
		const env = assembleFullBackup({ globals: globalsWithApiKey("sk-1") }, "123456", "t");
		expect(() => openFullBackup(env, "0000")).toThrow(BackupPinError);
		expect(() => openFullBackup(env, "0000")).toThrow(/PIN/);
	});

	it("a full backup with its secrets block stripped is rejected as invalid (not a raw Error)", () => {
		const env = assembleFullBackup({ globals: globalsWithApiKey("sk-1") }, "123456", "t");
		const { secrets: _secrets, ...stripped } = env;
		let thrown: unknown;
		try {
			openFullBackup(stripped as typeof env, "123456");
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(BackupRejectedError);
		expect(thrown).toMatchObject({ code: "invalid" });
		expect((thrown as Error).message).toMatch(/密钥/);
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
		expect(sections.globals?.ai.providers.deepseek?.baseUrl).toBe("https://api.deepseek.com");
		expect(sections.globals?.marketplace.sources[0]?.url).toBe(
			"https://ext.example.com/index.json",
		);
	});

	/**
	 * 拓展自己那份设置(桥的接入 token 住这儿,备份里是 `extensionSettings` 一节)同样在明文段被抹平 ——
	 * 袋子里没有它,恢复之后每一条接入都连不上,主人得照着插件那边重抄一遍 token。开关(`globals.extensions`)
	 * 不在这一节里,明文与恢复都原样。
	 */
	it("拓展 settings 里的密钥原样恢复", () => {
		const globals = makeDefaultGlobalConfig();
		globals.extensions = { bridge: { enabled: true } };
		const env = assembleFullBackup(
			{
				globals,
				extensionSettings: { bridge: { links: [{ name: "家里那台", token: "tok-SECRET" }] } },
			},
			"123456",
			"t",
		);
		expect(JSON.stringify(env.sections)).not.toContain("tok-SECRET");
		expect(env.sections.globals?.extensions.bridge).toEqual({ enabled: true });

		const { sections } = openFullBackup(env, "123456");
		expect(sections.extensionSettings?.bridge).toEqual({
			links: [{ name: "家里那台", token: "tok-SECRET" }],
		});
		expect(sections.globals?.extensions.bridge).toEqual({ enabled: true });
	});

	/**
	 * 拓展没跑起来时它的连接 settings 被整片当密钥抹掉(见 sanitize 那边的理由)——
	 * 完整档必须照样原样还回来,否则「关掉一个拓展再备份」就等于把那些连接毁了。
	 */
	it("没跑起来的拓展:整片抹掉的 settings 也原样恢复", () => {
		const extension: Connection = {
			id: "c1",
			name: "阿库娅",
			enabled: true,
			adapterKey: "bridge",
			platform: "telegram",
			settings: { botKey: "s3cret", note: "家里那台" },
			platformSnapshot: snapshotFor("telegram"),
		};
		const env = assembleFullBackup({ connections: [extension] }, "123456", "t", BUILTINS);
		expect(env.sections.connections?.[0]?.settings).toEqual({ botKey: "", note: "" });

		const { sections } = openFullBackup(env, "123456");
		expect(sections.connections?.[0]?.settings).toEqual({ botKey: "s3cret", note: "家里那台" });
	});

	/**
	 * 适配器不在场(或根本没给查表)= 问不出哪一格是密钥 → 整片抹空;完整档的袋子里有原值,恢复逐格相等。
	 */
	it("适配器不在场:内置连接的 settings 整片抹空,完整档恢复后逐格相等", () => {
		const conn = onebot("a1", "tok-SECRET");
		const env = assembleFullBackup({ connections: [conn] }, "123456", "t");
		const plain = env.sections.connections?.[0]?.settings as Record<string, unknown>;
		expect(plain.accessToken).toBe("");
		expect(plain.url).toBe("");
		expect(JSON.stringify(env.sections)).not.toContain("tok-SECRET");

		const { sections } = openFullBackup(env, "123456");
		expect(sections.connections).toEqual([conn]);
	});

	/**
	 * 被隔离的连接(适配器在场、settings 过不了它的规则)从严:明文段整片抹空,不留任何一个字面值;
	 * 完整档袋子里有盘上原文,恢复回来仍是那份不合法的原文(仍被隔离,主人看得见)。
	 */
	it("被隔离的连接:整片抹空、不留明文,完整档照样原样恢复", () => {
		const conn: Connection = {
			...onebot("a1", "tok-SECRET"),
			// 缺 transport:过不了 OneBot 的规则;里面任何一个字面值都不许进明文
			settings: {
				baseUrl: "http://127.0.0.1:3000",
				accessToken: "tok-SECRET",
				note: "不合法的原文",
			},
		};
		const env = assembleFullBackup({ connections: [conn] }, "123456", "t", BUILTINS);
		expect(env.sections.connections?.[0]?.settings).toEqual({
			baseUrl: "",
			accessToken: "",
			note: "",
		});
		expect(JSON.stringify(env.sections)).not.toContain("tok-SECRET");

		const { sections } = openFullBackup(env, "123456");
		expect(sections.connections).toEqual([conn]);
	});

	/** 脱敏档与完整档的明文段 `JSON.stringify` 后不含任何一个密钥原值(含拓展声明的键)。 */
	it("朴素兜底:明文段序列化后不含任何密钥原值", () => {
		const lookup: SecretCellsReader = {
			settingsSchemaOf: (key) => SCHEMAS.get(key),
			declaredSecretKeysOf: (key) => (key === "bridge" ? ["botKey"] : undefined),
		};
		const extension: Connection = {
			id: "c1",
			name: "阿库娅",
			enabled: true,
			adapterKey: "bridge",
			platform: "telegram",
			settings: { botKey: "bot-SECRET", note: "家里那台" },
			platformSnapshot: snapshotFor("telegram"),
		};
		const env = assembleFullBackup(
			{ connections: [onebot("a1", "tok-SECRET"), extension] },
			"123456",
			"t",
			lookup,
		);
		const plaintext = JSON.stringify(env.sections);
		for (const leaked of ["tok-SECRET", "bot-SECRET"]) expect(plaintext).not.toContain(leaked);
		// 声明的键以外的格照旧
		expect(env.sections.connections?.[1]?.settings).toEqual({ botKey: "", note: "家里那台" });
	});
});
