/**
 * 回归守护 — cookie 刷新之后上总线的 `cookies-refreshed` 只带刷新的时刻。
 *
 * 总线上的事件会原样转给所有面板客户端(`ws/channels.ts`),cookie 与 refreshToken 是
 * 整套登录会话的密钥。从前总线载荷就是 cookie 本身,靠 WS 转发那头逐个字段脱敏;现在
 * 在源头就不放上去 —— 这里钉的是**源头**:刷新回调触发后,总线收到的载荷键集合恰好是
 * `["refreshedAt"]`。断言键集合而不是「没有 cookiesJson」:后来的人往载荷里塞任何
 * 别的字段都会让它红,而不只是塞回那两个名字。
 *
 * 走真的 `createAuthSystem()` + 真的集成存储宿主(临时目录、真 FileKeyProvider),只把会联网的 B 站
 * API 与登录流换成替身,并把 `Api` 收到的回调与上下文截下来:回调当作 api 续期成功那一刻去调,上下文用来
 * 驱动一次真的提交(罐子 + 令牌同一次写)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MessageBus, ok, type ServiceContext } from "@bilibili-notify/internal";
import { FileKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BiliContext } from "../../bilibili/context.js";
import { readIntegrationSecretsFile } from "../../integration-store/files.js";
import { createIntegrationStore } from "../../integration-store/store.js";
import { createAuthSystem } from "../index.js";

interface RefreshCallbacks {
	onCookiesRefreshed?: () => Promise<void> | void;
}

/** `Api` 构造时收到的回调与上下文 —— 替身把它们截下来。 */
const captured = vi.hoisted(() => ({
	callbacks: undefined as RefreshCallbacks | undefined,
	ctx: undefined as unknown,
}));

vi.mock("../../bilibili/api/index.js", () => ({
	Api: class {
		constructor(opts: { callbacks: RefreshCallbacks; ctx: unknown }) {
			captured.callbacks = opts.callbacks;
			captured.ctx = opts.ctx;
		}
		start = vi.fn(async () => {});
		stop = vi.fn();
		resumeStoredLogin = vi.fn(async () => {});
		getCookiesJson = vi.fn(() => "[]");
		clearCookies = vi.fn(async () => {});
		commitLogin = vi.fn(async () => ok());
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
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

let dataDir: string;
beforeEach(async () => {
	captured.callbacks = undefined;
	captured.ctx = undefined;
	dataDir = await mkdtemp(join(tmpdir(), "bn-cookies-refreshed-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

describe("AuthSystem — cookies-refreshed 的总线载荷", () => {
	it("刷新回调触发后,总线上的 cookies-refreshed 载荷只有 refreshedAt 一格;盘上那份由提交写,解开后两个键都在", async () => {
		const emit = vi.fn();
		const bus: MessageBus = { emit, on: vi.fn(() => ({ dispose: vi.fn() })) };
		const ctx = makeCtx();
		const keyProvider = new FileKeyProvider(join(dataDir, "secrets", "master.key"), ctx.logger);
		const integrationStore = createIntegrationStore({
			dataRoot: dataDir,
			keyProvider,
			logger: ctx.logger,
		});
		const auth = await createAuthSystem({ serviceCtx: ctx, bus, integrationStore });
		expect(captured.callbacks?.onCookiesRefreshed).toBeTypeOf("function");

		// 驱动一次真的提交:罐子里有会话 cookie,令牌与罐子同一次写。
		const biliCtx = captured.ctx as BiliContext;
		biliCtx.cookies.jar.load([
			{ key: "SESSDATA", value: "SUPER_SECRET_COOKIE", domain: "bilibili.com", path: "/" },
		]);
		const committed = await biliCtx.cookies.commit([
			{ kind: "set", key: "refreshToken", value: "SECRET_REFRESH" },
		]);
		expect(committed.ok).toBe(true);
		await captured.callbacks?.onCookiesRefreshed?.();

		const refreshed = emit.mock.calls.filter(([event]) => event === "cookies-refreshed");
		expect(refreshed).toHaveLength(1);
		const payload = refreshed[0]?.[1] as Record<string, unknown>;
		expect(Object.keys(payload)).toEqual(["refreshedAt"]);
		expect(Number.isNaN(Date.parse(String(payload.refreshedAt)))).toBe(false);
		// 总线上任何一次 emit 的载荷里,都不许出现 cookie 或 refreshToken 的内容。
		expect(JSON.stringify(emit.mock.calls)).not.toContain("SECRET");

		// 总线上少了 cookie 不等于少存一份:提交把它们写进了 secrets/bilibili/secrets.enc。
		await auth.dispose();
		await integrationStore.close();
		const read = await readIntegrationSecretsFile({
			dataRoot: dataDir,
			key: "bilibili",
			logger: ctx.logger,
			keyProvider,
		});
		expect(read.kind).toBe("ok");
		const entries = read.kind === "ok" ? read.entries : new Map();
		expect(String(entries.get("http.cookies"))).toContain("SUPER_SECRET_COOKIE");
		expect(entries.get("refreshToken")).toBe("SECRET_REFRESH");
	});
});
