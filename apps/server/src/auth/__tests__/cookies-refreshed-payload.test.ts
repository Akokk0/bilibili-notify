/**
 * 回归守护 — cookie 刷新之后上总线的 `cookies-refreshed` 只带刷新的时刻。
 *
 * 总线上的事件会原样转给所有面板客户端(`ws/channels.ts`),cookie 与 refreshToken 是
 * 整套登录会话的密钥。从前总线载荷就是 cookie 本身,靠 WS 转发那头逐个字段脱敏;现在
 * 在源头就不放上去 —— 这里钉的是**源头**:刷新回调触发后,总线收到的载荷键集合恰好是
 * `["refreshedAt"]`。断言键集合而不是「没有 cookiesJson」:后来的人往载荷里塞任何
 * 别的字段都会让它红,而不只是塞回那两个名字。
 *
 * 走真的 `createAuthSystem()` + 真的 FileKeyProvider / StorageManager,只把会联网的 B 站
 * API 与登录流换成替身,并把 `Api` 收到的回调截下来直接调用。
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBus, ServiceContext } from "@bilibili-notify/internal";
import { FileKeyProvider } from "@bilibili-notify/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createAuthSystem } from "../index.js";

interface RefreshCallbacks {
	onCookiesRefreshed?: (payload: { cookiesJson: string; refreshToken: string }) => Promise<void>;
}

/** `Api` 构造时收到的回调 —— 替身把它截下来,测试里当作 api 刷完 cookie 那一刻去调。 */
const captured = vi.hoisted(() => ({ callbacks: undefined as RefreshCallbacks | undefined }));

vi.mock("../../bilibili/api/index.js", () => ({
	Api: class {
		constructor(opts: { callbacks: RefreshCallbacks }) {
			captured.callbacks = opts.callbacks;
		}
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
		signal: new AbortController().signal,
		track: vi.fn(),
	};
}

let dataDir: string;
beforeEach(async () => {
	captured.callbacks = undefined;
	dataDir = await mkdtemp(join(tmpdir(), "bn-cookies-refreshed-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

describe("AuthSystem — cookies-refreshed 的总线载荷", () => {
	it("刷新回调触发后,总线上的 cookies-refreshed 载荷只有 refreshedAt 一格;盘上那份照存", async () => {
		const emit = vi.fn();
		const bus: MessageBus = { emit, on: vi.fn(() => ({ dispose: vi.fn() })) };
		const ctx = makeCtx();
		const auth = await createAuthSystem({
			serviceCtx: ctx,
			bus,
			bootstrap: { server: { host: "127.0.0.1", port: 8787 }, dataDir, logLevel: "silent" },
			dataRoot: dataDir,
			keyProvider: new FileKeyProvider(join(dataDir, "secrets", "master.key"), ctx.logger),
		});
		expect(captured.callbacks?.onCookiesRefreshed).toBeTypeOf("function");

		await captured.callbacks?.onCookiesRefreshed?.({
			cookiesJson: '[{"name":"SESSDATA","value":"SUPER_SECRET_COOKIE"}]',
			refreshToken: "SECRET_REFRESH",
		});

		const refreshed = emit.mock.calls.filter(([event]) => event === "cookies-refreshed");
		expect(refreshed).toHaveLength(1);
		const payload = refreshed[0]?.[1] as Record<string, unknown>;
		expect(Object.keys(payload)).toEqual(["refreshedAt"]);
		expect(Number.isNaN(Date.parse(String(payload.refreshedAt)))).toBe(false);
		// 总线上任何一次 emit 的载荷里,都不许出现 cookie 或 refreshToken 的内容。
		expect(JSON.stringify(emit.mock.calls)).not.toContain("SECRET");

		// 总线上少了 cookie 不等于少存一份:回调自己把它写进了 secrets/cookies.json。
		await expect(stat(join(dataDir, "secrets", "cookies.json"))).resolves.toBeTruthy();
		auth.dispose();
	});
});
