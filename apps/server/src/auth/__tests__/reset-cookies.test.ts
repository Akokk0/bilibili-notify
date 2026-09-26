/**
 * 回归守护 — 「清除 Cookie」不许把配置密钥一起清掉。
 *
 * master.key 是 cookie 与配置密钥袋(AI key / 搜索 key)共用的一把钥匙。旧版的
 * 「重置密钥与 Cookie」会轮换它;而配置密钥袋在进程里缓存着旧钥匙,继续用旧钥匙
 * 写 `config-secrets.enc`,下次重启拿新钥匙解不开 → 按空处理、只打一条 warn,
 * 所有 AI key 被静默清空。
 *
 * 这里走真的 `createAuthSystem().resetCookies()` + 真的 FileKeyProvider /
 * SecretStore,只把会联网的 B 站 API 与登录流换成替身。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { FileKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSecretStore } from "../../config/secret-store.js";
import { createAuthSystem } from "../index.js";

// BilibiliAPI.start() 会去拿 BiliTicket(真联网),替身只留 auth 层碰得到的几个口。
vi.mock("@bilibili-notify/api", () => ({
	BilibiliAPI: class {
		start = vi.fn(async () => {});
		stop = vi.fn();
		loadCookies = vi.fn(async () => {});
		markLoginInfoLoaded = vi.fn();
		getCookiesJson = vi.fn(() => "[]");
		clearCookies = vi.fn(async () => {});
	},
	LoginFlow: class {
		start = vi.fn(async () => {});
		stop = vi.fn();
		reportLoggedOut = vi.fn();
		reportAccountInfo = vi.fn(async () => {});
		current = vi.fn(() => ({ status: 0, msg: "" }));
	},
}));

function makeCtx(): ServiceContext {
	return {
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
	};
}

const bus: MessageBus = { emit: vi.fn(), on: vi.fn(() => ({ dispose: vi.fn() })) };

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-reset-cookies-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

const keyPath = () => join(dataDir, "secrets", "master.key");
const secretsPath = () => join(dataDir, "secrets", "config-secrets.enc");

describe("AuthSystem.resetCookies — 清除 Cookie 不牵连配置密钥", () => {
	it("清除 Cookie 之后再存配置密钥,重启后配置密钥还在", async () => {
		// 同一个 provider 同时喂 cookie 与配置密钥袋 —— 与 runtime/bootstrap 的装配一致。
		const ctx = makeCtx();
		const keyProvider = new FileKeyProvider(keyPath(), ctx.logger);
		const secretStore = createSecretStore({
			filePath: secretsPath(),
			keyProvider,
			logger: ctx.logger,
		});
		await secretStore.save({ aiApiKeys: { deepseek: "sk-before" } });

		const auth = await createAuthSystem({
			serviceCtx: ctx,
			bus,
			bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
			keyProvider,
		});
		await auth.resetCookies();
		// 清完之后面板上再改一次 key:secret store 用它进程里缓存的那把钥匙写盘。
		await secretStore.save({ aiApiKeys: { deepseek: "sk-after" } });
		auth.dispose();

		// 模拟重启:同一个 key 路径新建 provider 与 secret store。
		const restartCtx = makeCtx();
		const restarted = createSecretStore({
			filePath: secretsPath(),
			keyProvider: new FileKeyProvider(keyPath(), restartCtx.logger),
			logger: restartCtx.logger,
		});
		expect(await restarted.load()).toEqual({ aiApiKeys: { deepseek: "sk-after" } });
		expect(restartCtx.logger.warn).not.toHaveBeenCalled();
	});
});
