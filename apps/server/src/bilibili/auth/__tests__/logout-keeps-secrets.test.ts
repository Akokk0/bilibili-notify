/**
 * 回归守护 — 「退出登录」不许把配置密钥一起清掉。
 *
 * master.key 是登录凭据与配置密钥袋(AI key / 搜索 key)共用的一把钥匙。旧版的
 * 「重置密钥与 Cookie」会轮换它;而配置密钥袋在进程里缓存着旧钥匙,继续用旧钥匙
 * 写 `config-secrets.enc`,下次重启拿新钥匙解不开 → 按空处理、只打一条 warn,
 * 所有 AI key 被静默清空。
 *
 * 这里走真的 `createAuthSystem().logout()` + 真的 FileKeyProvider /
 * SecretStore / 集成存储宿主,只把会联网的 B 站 API 与登录流换成替身。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type ServiceContext } from "@bilibili-notify/internal";
import { FileKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { inertTransitImages } from "../../../__tests__/support/integration-io.js";
import { createSecretStore } from "../../../config/secret-store.js";
import { createIntegrationStore } from "../../../integration-store/store.js";
import { createValueRedactor } from "../../../logs/value-redactor.js";
import {
	type CreateAuthSystemOptions,
	createAuthSystem as createAuthSystemWith,
} from "../index.js";
import { testAuthDeps } from "./support/auth-deps.js";

/** 测试里不关心配置仓与图库:统一补上替身。 */
const createAuthSystem = (
	o: Omit<CreateAuthSystemOptions, "configStore" | "accountImages" | "problems" | "settingsOf">,
) => createAuthSystemWith({ ...testAuthDeps(), ...o });

// 替身只留 auth 层碰得到的几个口,不起真的 HTTP 客户端与登录流程。
vi.mock("../login-flow.js", () => ({
	LoginFlow: class {
		start = vi.fn(async () => {});
		stop = vi.fn();
		reportLoggedOut = vi.fn();
		reportAccountInfo = vi.fn(async () => {});
		current = vi.fn(() => ({ status: 0, msg: "" }));
	},
}));

vi.mock("../../api/index.js", () => ({
	Api: class {
		start = vi.fn(async () => {});
		stop = vi.fn();
		resumeStoredLogin = vi.fn(async () => {});
		getCookiesJson = vi.fn(() => "[]");
		clearCookies = vi.fn(async () => {});
		commitLogin = vi.fn(async () => ok());
	},
}));

function makeCtx() {
	const ctx: ServiceContext & { forSubsystem: () => ServiceContext } = {
		// 假的子上下文就是它自己。
		forSubsystem: () => ctx,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		setInterval: () => ({ dispose: vi.fn() }),
		setTimeout: () => ({ dispose: vi.fn() }),
		onDispose: vi.fn(),
		signal: new AbortController().signal,
		track: vi.fn(),
	};
	return ctx;
}

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bn-reset-cookies-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

const keyPath = () => join(dataDir, "secrets", "master.key");
const secretsPath = () => join(dataDir, "secrets", "config-secrets.enc");

describe("AuthSystem.logout — 退出登录不牵连配置密钥", () => {
	it("退出登录之后再存配置密钥,重启后配置密钥还在", async () => {
		// 同一个 provider 同时喂登录凭据与配置密钥袋 —— 与 runtime/bootstrap 的装配一致。
		const ctx = makeCtx();
		const keyProvider = new FileKeyProvider(keyPath(), ctx.logger);
		const secretStore = createSecretStore({
			filePath: secretsPath(),
			keyProvider,
			logger: ctx.logger,
		});
		await secretStore.save({ aiApiKeys: { deepseek: "sk-before" } });

		const integrationStore = createIntegrationStore({
			dataRoot: dataDir,
			keyProvider,
			logger: ctx.logger,
			redactor: createValueRedactor(),
		});
		const auth = await createAuthSystem({
			transitImages: inertTransitImages,
			serviceCtx: ctx,
			integrationStore,
		});
		await auth.auth.logout();
		// 清完之后面板上再改一次 key:secret store 用它进程里缓存的那把钥匙写盘。
		await secretStore.save({ aiApiKeys: { deepseek: "sk-after" } });
		await auth.dispose();
		await integrationStore.close();

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
