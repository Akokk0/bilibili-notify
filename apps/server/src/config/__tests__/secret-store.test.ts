/**
 * 单元测试 — `createSecretStore` + ConfigStore apiKey 拆分集成。
 *
 * 守护契约(SecretStore):
 *   - save→load round-trip;缺文件→{};换 key→{}+warn;落盘是 GCM blob 非明文
 * 守护契约(ConfigStore + secretStore):
 *   - 一次性 lift:磁盘明文 apiKey → getGlobals 仍可读(注水),globals.json 抹掉,secret 文件持有
 *   - patchGlobals 改 apiKey → 新值生效;globals.json 始终无 apiKey;新实例同 key 可重新注水
 *   - 清空 apiKey → bag 清除
 *   - 无 secretStore(legacy)→ apiKey 仍留在 globals.json(未破坏旧路径)
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BiliEvents,
	type Disposable,
	type MessageBus,
	makeDefaultGlobalConfig,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { createKeyProvider } from "@bilibili-notify/storage";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BootstrapConfig } from "../schema.js";
import { createSecretStore, type SecretStore } from "../secret-store.js";
import { type ConfigStore, createConfigStore } from "../store.js";

function makeBus(): MessageBus {
	const listeners = new Map<keyof BiliEvents, Set<(...a: unknown[]) => void>>();
	return {
		emit(event, ...args) {
			for (const h of [...(listeners.get(event) ?? [])]) (h as (...a: unknown[]) => void)(...args);
		},
		on(event, handler): Disposable {
			let s = listeners.get(event);
			if (!s) {
				s = new Set();
				listeners.set(event, s);
			}
			const w = (...a: unknown[]) => (handler as (...x: unknown[]) => void)(...a);
			s.add(w);
			return { dispose: () => listeners.get(event)?.delete(w) };
		},
	};
}

function makeCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
	};
}

function bootstrap(dataDir: string): BootstrapConfig {
	return { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "info" };
}

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-secret-"));
});

function mkSecretStore(): SecretStore {
	const keyProvider = createKeyProvider({
		keyPath: join(dataDir, "secrets", "master.key"),
		saltPath: join(dataDir, "secrets", "kdf.salt"),
		logger: makeCtx().logger,
	});
	return createSecretStore({
		filePath: join(dataDir, "secrets", "config-secrets.enc"),
		keyProvider,
		logger: makeCtx().logger,
	});
}

describe("createSecretStore", () => {
	it("save→load round-trip;缺文件→{}", async () => {
		const s = mkSecretStore();
		expect(await s.load()).toEqual({});
		await s.save({ aiApiKey: "sk-secret" });
		expect(await s.load()).toEqual({ aiApiKey: "sk-secret" });
	});

	it("落盘是 GCM blob,不含明文 key", async () => {
		const s = mkSecretStore();
		await s.save({ aiApiKey: "sk-PLAINTEXT-LEAK" });
		const raw = await readFile(join(dataDir, "secrets", "config-secrets.enc"), "utf8");
		expect(JSON.parse(raw).v).toBe(2);
		expect(raw).not.toContain("sk-PLAINTEXT-LEAK");
	});

	it("文件存在但读不了(EISDIR,非 ENOENT)→ load() 抛,绝不退化为 {}", async () => {
		// 数据丢失防护:若静默返 {},随后任一 writeGlobals→save() 会用空 bag
		// 原子覆盖,永久销毁已存 aiApiKey。
		const encPath = join(dataDir, "secrets", "config-secrets.enc");
		await mkdir(encPath, { recursive: true }); // 占位成目录 → readFile EISDIR
		const s = mkSecretStore();
		await expect(s.load()).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("换 key → load 退化为 {} 且 warn", async () => {
		const s1 = mkSecretStore();
		await s1.save({ aiApiKey: "sk-1" });
		const logger = makeCtx().logger;
		const wrong = createSecretStore({
			filePath: join(dataDir, "secrets", "config-secrets.enc"),
			keyProvider: createKeyProvider({
				passphrase: "different",
				keyPath: join(dataDir, "x.key"),
				saltPath: join(dataDir, "x.salt"),
				logger,
			}),
			logger,
		});
		expect(await wrong.load()).toEqual({});
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("无法解密"));
	});
});

describe("ConfigStore + secretStore — apiKey 拆分", () => {
	/**
	 * 写一份**上一版形状**的 globals.json:AI 连接是一套扁平字段,密钥明文在盘上。
	 * 这是升级路径的起点 —— schema 迁移会把它整份搬进 `providers.custom`,
	 * 密钥则该被抬进加密袋的 `custom` 槽。刻意绕过类型:新 schema 已经没有这些字段了。
	 */
	async function seedLegacyPlaintextGlobals(apiKey: string) {
		const g = makeDefaultGlobalConfig() as unknown as Record<string, unknown>;
		const defaults = g.defaults as Record<string, unknown>;
		const ai = { ...(defaults.ai as Record<string, unknown>) };
		delete ai.providers;
		ai.apiKey = apiKey;
		ai.baseUrl = "https://api.deepseek.com";
		ai.model = "deepseek-v4-pro";
		defaults.ai = ai;
		await mkdir(join(dataDir, "state"), { recursive: true });
		await writeFile(join(dataDir, "state", "globals.json"), JSON.stringify(g, null, 2), "utf8");
	}
	const diskGlobals = async () =>
		JSON.parse(await readFile(join(dataDir, "state", "globals.json"), "utf8"));
	/** 盘上那份里,某个桶的主 key。 */
	const diskKey = async (id: string) =>
		(await diskGlobals())?.defaults?.ai?.providers?.[id]?.apiKey;

	function mkStore(secretStore?: SecretStore): ConfigStore {
		return createConfigStore({
			bootstrap: bootstrap(dataDir),
			bus: makeBus(),
			serviceCtx: makeCtx(),
			secretStore,
		});
	}
	/** 当前生效那家的主 key(测试里一律用 deepseek 桶,除迁移那条)。 */
	const memKey = (store: ConfigStore, id = "deepseek") =>
		store.getGlobals().defaults.ai.providers[id as "deepseek"]?.apiKey;

	it("一次性 lift:上一版明文 apiKey 迁进 custom 桶 + 加密袋,globals.json 抹掉", async () => {
		await seedLegacyPlaintextGlobals("sk-legacy-plain");
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		// 扁平配置整份进 custom 桶(schema 迁移),密钥注水回内存。
		expect(memKey(store, "custom")).toBe("sk-legacy-plain");
		expect(store.getGlobals().defaults.ai.providers.custom?.model).toBe("deepseek-v4-pro");
		// 磁盘上那把被抠成空串 —— 不留明文,也不动键序。
		expect(await diskKey("custom")).toBe("");
		// 加密文件持有,键是 custom(与 schema 迁移的去处一致)。
		expect((await secret.load()).aiApiKeys).toEqual({ custom: "sk-legacy-plain" });
	});

	it("上一版加密袋里的单把 aiApiKey 也迁进 custom 槽", async () => {
		// 已经启用过加密的老用户:明文早就不在盘上了,那把 key 在袋子里叫 aiApiKey。
		const secret = mkSecretStore();
		await secret.save({ aiApiKey: "sk-in-old-bag" });
		const store = mkStore(secret);
		await store.load();
		const bag = await secret.load();
		expect(bag.aiApiKeys).toEqual({ custom: "sk-in-old-bag" });
		expect(bag.aiApiKey).toBeUndefined();
	});

	it("patchGlobals 改某家的 apiKey:新值生效;磁盘无明文;新实例重新注水", async () => {
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		await store.patchGlobals({
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-new" } } } },
		});
		expect(memKey(store)).toBe("sk-new");
		expect(await diskKey("deepseek")).toBe("");

		const store2 = mkStore(mkSecretStore()); // 新实例,同 keyPath → 同 key
		await store2.load();
		expect(memKey(store2)).toBe("sk-new");
	});

	it("各家的 key 互不串味", async () => {
		// 分桶最要紧的一条:拿 A 家的 key 去打 B 家的接口必然 401,而错误来自上游、
		// 看着像「key 填错了」,极难溯源。
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		await store.patchGlobals({
			defaults: {
				ai: {
					providers: {
						deepseek: { apiKey: "sk-ds", vision: { apiKey: "sk-ds-vision" } },
						openrouter: { apiKey: "sk-or" },
					},
				},
			},
		});
		const store2 = mkStore(mkSecretStore());
		await store2.load();
		expect(memKey(store2, "deepseek")).toBe("sk-ds");
		expect(memKey(store2, "openrouter")).toBe("sk-or");
		expect(store2.getGlobals().defaults.ai.providers.deepseek?.vision.apiKey).toBe("sk-ds-vision");
	});

	it("注水后键序仍是 zod 规范形态 — 只改无关字段不该让 defaults.ai 被误判成变了", async () => {
		// 回归守护。密钥落盘时若是 `delete` 掉那个键,load() 读回时键不存在 →
		// 注水的 spread 把它当**新键追加到对象末尾**,键序就偏离了 zod parse 的声明
		// 顺序。而 engines.ts 的 config-changed diff 用 JSON.stringify 逐 section
		// 比较(键序敏感),于是重启后第一次改**任何** globals 字段(哪怕只是
		// dynamicCron),defaults.ai 都会被误判成「变了」→ 白白热重载一次 AI 实例 +
		// 刷两条日志。只有「配了 AI + 启用加密 + 重启后首次变更」三者同时满足才触发,
		// 极难撞见,所以钉在这里。现在 stripAiSecrets 抠成空串而非删键,从源头绕开。
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		await store.patchGlobals({
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-x" } } } },
		});

		// 重启:密钥已从盘上剥离,这一次是靠 secretBag 注水回内存的。
		const store2 = mkStore(mkSecretStore());
		await store2.load();

		const prev = store2.getGlobals(); // engines 的 initialGlobals / prevGlobals 初值
		await store2.patchGlobals({ app: { dynamicCron: "*/9 * * * *" } });
		const next = store2.getGlobals();

		expect(JSON.stringify(next.defaults.ai)).toBe(JSON.stringify(prev.defaults.ai));
	});

	it("清空某家的 apiKey → 那把从袋里消失", async () => {
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		await store.patchGlobals({
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-x" } } } },
		});
		await store.patchGlobals({ defaults: { ai: { providers: { deepseek: { apiKey: "" } } } } });
		expect(memKey(store)).toBe("");
		expect((await secret.load()).aiApiKeys).toEqual({});
	});

	it("无 secretStore(legacy):apiKey 仍写进 globals.json", async () => {
		const store = mkStore(); // 不传 secretStore
		await store.load();
		await store.patchGlobals({
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-legacy-mode" } } } },
		});
		expect(await diskKey("deepseek")).toBe("sk-legacy-mode");
	});

	// 回归守护 — P2:writeGlobals 双写非原子。secretStore.save 成功但
	// persistGlobals 抛错时,必须回滚密钥袋 + in-memory 不更新 → 两端始终一致
	// (绝不 secret 存新 apiKey 而 globals.json/内存留旧 → 重启分叉)。
	// 复发点:去掉 try/catch 回滚,改回 save→persist 顺序无补偿。
	it("writeGlobals:persist 抛错 → 回滚密钥袋,两端不分叉(P2)", async () => {
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		// 先成功落一个 apiKey:bag 里是 sk-good,globals.json 已写。
		await store.patchGlobals({
			defaults: { ai: { providers: { deepseek: { apiKey: "sk-good" } } } },
		});
		expect((await secret.load()).aiApiKeys).toEqual({ deepseek: "sk-good" });

		// 破坏 globals.json 路径(占成目录)→ 下次 atomicWriteJson rename 必失败,
		// 而 secretStore.save(写 secrets/config-secrets.enc,另一路径)仍成功。
		const gp = join(dataDir, "state", "globals.json");
		await rm(gp);
		await mkdir(gp, { recursive: true });

		await expect(
			store.patchGlobals({ defaults: { ai: { providers: { deepseek: { apiKey: "sk-EVIL" } } } } }),
		).rejects.toThrow();

		// 关键:bag 已回滚为 sk-good(不是 sk-EVIL);in-memory 仍 sk-good。
		expect((await secret.load()).aiApiKeys).toEqual({ deepseek: "sk-good" });
		expect(memKey(store)).toBe("sk-good");
	});
});
