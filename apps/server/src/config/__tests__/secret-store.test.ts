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
	async function seedGlobalsWithPlaintextKey(apiKey: string) {
		const g = makeDefaultGlobalConfig();
		g.defaults.ai.apiKey = apiKey;
		await mkdir(join(dataDir, "state"), { recursive: true });
		await writeFile(join(dataDir, "state", "globals.json"), JSON.stringify(g, null, 2), "utf8");
	}
	const diskGlobals = async () =>
		JSON.parse(await readFile(join(dataDir, "state", "globals.json"), "utf8"));

	function mkStore(secretStore?: SecretStore): ConfigStore {
		return createConfigStore({
			bootstrap: bootstrap(dataDir),
			bus: makeBus(),
			serviceCtx: makeCtx(),
			secretStore,
		});
	}

	it("一次性 lift:明文 apiKey 迁出,getGlobals 仍可读,globals.json 抹掉,secret 持有", async () => {
		await seedGlobalsWithPlaintextKey("sk-legacy-plain");
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		expect(store.getGlobals().defaults.ai.apiKey).toBe("sk-legacy-plain"); // 注水
		expect((await diskGlobals()).defaults.ai.apiKey).toBeUndefined(); // 磁盘抹掉
		expect(await secret.load()).toEqual({ aiApiKey: "sk-legacy-plain" }); // 加密文件持有
	});

	it("patchGlobals 改 apiKey:新值生效;磁盘无 apiKey;新实例同 key 重新注水", async () => {
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		await store.patchGlobals({ defaults: { ai: { apiKey: "sk-new" } } });
		expect(store.getGlobals().defaults.ai.apiKey).toBe("sk-new");
		expect((await diskGlobals()).defaults.ai.apiKey).toBeUndefined();

		const store2 = mkStore(mkSecretStore()); // 新实例,同 keyPath → 同 key
		await store2.load();
		expect(store2.getGlobals().defaults.ai.apiKey).toBe("sk-new");
	});

	it("清空 apiKey → bag 清除", async () => {
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		await store.patchGlobals({ defaults: { ai: { apiKey: "sk-x" } } });
		await store.patchGlobals({ defaults: { ai: { apiKey: "" } } });
		expect(store.getGlobals().defaults.ai.apiKey).toBe("");
		expect(await secret.load()).toEqual({ aiApiKey: undefined });
	});

	it("无 secretStore(legacy):apiKey 仍写进 globals.json", async () => {
		const store = mkStore(); // 不传 secretStore
		await store.load();
		await store.patchGlobals({ defaults: { ai: { apiKey: "sk-legacy-mode" } } });
		expect((await diskGlobals()).defaults.ai.apiKey).toBe("sk-legacy-mode");
	});

	// 回归守护 — P2:writeGlobals 双写非原子。secretStore.save 成功但
	// persistGlobals 抛错时,必须回滚密钥袋 + in-memory 不更新 → 两端始终一致
	// (绝不 secret 存新 apiKey 而 globals.json/内存留旧 → 重启分叉)。
	// 复发点:去掉 try/catch 回滚,改回 save→persist 顺序无补偿。
	it("writeGlobals:persist 抛错 → 回滚密钥袋,两端不分叉(P2)", async () => {
		const secret = mkSecretStore();
		const store = mkStore(secret);
		await store.load();
		// 先成功落一个 apiKey:bag=sk-good,globals.json 已写。
		await store.patchGlobals({ defaults: { ai: { apiKey: "sk-good" } } });
		expect(await secret.load()).toEqual({ aiApiKey: "sk-good" });

		// 破坏 globals.json 路径(占成目录)→ 下次 atomicWriteJson rename 必失败,
		// 而 secretStore.save(写 secrets/config-secrets.enc,另一路径)仍成功。
		const gp = join(dataDir, "state", "globals.json");
		await rm(gp);
		await mkdir(gp, { recursive: true });

		await expect(store.patchGlobals({ defaults: { ai: { apiKey: "sk-EVIL" } } })).rejects.toThrow();

		// 关键:bag 已回滚为 sk-good(不是 sk-EVIL);in-memory 仍 sk-good。
		expect(await secret.load()).toEqual({ aiApiKey: "sk-good" });
		expect(store.getGlobals().defaults.ai.apiKey).toBe("sk-good");
	});
});
