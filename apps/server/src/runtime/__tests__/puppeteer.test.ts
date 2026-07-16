import type { Logger } from "@bilibili-notify/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type BrowserConnectOptions,
	type BrowserLaunchOptions,
	createPuppeteerAdapter,
	resolveChromePath,
} from "../puppeteer";

describe("resolveChromePath", () => {
	it("returns the explicit path as-is when provided (operator's choice wins)", () => {
		// 显式路径优先,即使探测判定它不存在也原样返回 —— 路径写错由 puppeteer 启动
		// 报清晰错误,而非静默换一个浏览器造成困惑。
		const result = resolveChromePath("/custom/chrome", {
			exists: () => false,
			platform: "linux",
		});
		expect(result).toBe("/custom/chrome");
	});

	it("falls back to the first existing platform candidate when path is empty", () => {
		// 没显式路径时,按平台候选表顺序取第一个 exists 命中的。
		const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const result = resolveChromePath("", {
			platform: "darwin",
			exists: (p) => p === chrome,
		});
		expect(result).toBe(chrome);
	});

	it("returns the first candidate when several exist (priority order)", () => {
		const result = resolveChromePath(undefined, {
			platform: "linux",
			exists: () => true, // 全都"存在" → 取候选表最靠前的
		});
		expect(result).toBe("/usr/bin/google-chrome");
	});

	it("returns null when no candidate exists on the platform", () => {
		const result = resolveChromePath(undefined, {
			platform: "linux",
			exists: () => false,
		});
		expect(result).toBeNull();
	});

	it("returns null for a platform without a candidate table", () => {
		const result = resolveChromePath(undefined, {
			platform: "freebsd" as NodeJS.Platform,
			exists: () => true,
		});
		expect(result).toBeNull();
	});
});

function makeLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeFakePage() {
	return {
		setContent: vi.fn(async () => {}),
		waitForFunction: vi.fn(async () => undefined),
		$: vi.fn(async () => null),
		screenshot: vi.fn(async () => Buffer.alloc(0)),
		close: vi.fn(async () => {}),
	};
}

function makeFakeBrowser() {
	let connected = true;
	return {
		get connected() {
			return connected;
		},
		newPage: vi.fn(async () => makeFakePage()),
		close: vi.fn(async () => {
			connected = false;
		}),
		disconnect: vi.fn(async () => {
			connected = false;
		}),
	};
}

type FakeBrowser = ReturnType<typeof makeFakeBrowser>;

/** 注入用假 launcher:记录每次 launch/connect 产出的 browser 以便断言。 */
function makeFakeLauncher() {
	const browsers: FakeBrowser[] = [];
	return {
		browsers,
		launch: vi.fn(async (_options: BrowserLaunchOptions) => {
			const b = makeFakeBrowser();
			browsers.push(b);
			return b;
		}),
		connect: vi.fn(async (_options: BrowserConnectOptions) => {
			const b = makeFakeBrowser();
			browsers.push(b);
			return b;
		}),
	};
}

describe("createPuppeteerAdapter idle auto-close", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("closes the launched browser after the idle timeout elapses", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 5_000,
		});
		const page = await adapter.page();
		await page.close();
		// 刚渲染完:计时器在跑,浏览器还活着。
		expect(launcher.browsers[0]?.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(launcher.browsers[0]?.close).toHaveBeenCalledTimes(1);
	});

	it("cancels the pending close when a new render starts, then relaunches after a real close", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 5_000,
		});
		const page1 = await adapter.page();
		await page1.close();
		await vi.advanceTimersByTimeAsync(4_000);
		// 超时前来了新渲染 → 取消关闭。
		const page2 = await adapter.page();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(launcher.browsers[0]?.close).not.toHaveBeenCalled();
		expect(launcher.launch).toHaveBeenCalledTimes(1); // 仍是同一个浏览器
		// 渲染结束后空闲计时重新开始 → 到点关闭 → 下次渲染重新 launch。
		await page2.close();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(launcher.browsers[0]?.close).toHaveBeenCalledTimes(1);
		await adapter.page();
		expect(launcher.launch).toHaveBeenCalledTimes(2);
	});

	it("never auto-closes when idleTimeoutMs is 0", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 0,
		});
		const page = await adapter.page();
		await page.close();
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(launcher.browsers[0]?.close).not.toHaveBeenCalled();
	});

	it("dispose clears the pending idle timer (no double close)", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 5_000,
		});
		const page = await adapter.page();
		await page.close();
		await adapter.dispose();
		expect(launcher.browsers[0]?.close).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(launcher.browsers[0]?.close).toHaveBeenCalledTimes(1);
	});
});

describe("createPuppeteerAdapter remote endpoint", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("connects to a ws:// endpoint (browserWSEndpoint) instead of launching", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromeEndpoint: "ws://browserless:3000",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 0,
		});
		await adapter.page();
		expect(launcher.launch).not.toHaveBeenCalled();
		expect(launcher.connect).toHaveBeenCalledTimes(1);
		expect(launcher.connect.mock.calls[0]?.[0]).toMatchObject({
			browserWSEndpoint: "ws://browserless:3000",
		});
	});

	it("connects to an http:// endpoint via browserURL (vanilla chromium devtools)", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromeEndpoint: "http://chrome:9222",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 0,
		});
		await adapter.page();
		expect(launcher.connect.mock.calls[0]?.[0]).toMatchObject({
			browserURL: "http://chrome:9222",
		});
	});

	it("prefers the remote endpoint over chromePath when both are configured", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			chromeEndpoint: "ws://browserless:3000",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 0,
		});
		await adapter.page();
		expect(launcher.launch).not.toHaveBeenCalled();
		expect(launcher.connect).toHaveBeenCalledTimes(1);
	});

	it("idle timeout disconnects (never closes) a remote browser, then reconnects on demand", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromeEndpoint: "ws://browserless:3000",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 5_000,
		});
		const page = await adapter.page();
		await page.close();
		await vi.advanceTimersByTimeAsync(5_000);
		// 远程浏览器是共享资源:只断自己的连接,绝不 close 杀掉它。
		expect(launcher.browsers[0]?.disconnect).toHaveBeenCalledTimes(1);
		expect(launcher.browsers[0]?.close).not.toHaveBeenCalled();
		await adapter.page();
		expect(launcher.connect).toHaveBeenCalledTimes(2);
	});

	it("dispose disconnects a remote browser instead of closing it", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromeEndpoint: "ws://browserless:3000",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 0,
		});
		await adapter.page();
		await adapter.dispose();
		expect(launcher.browsers[0]?.disconnect).toHaveBeenCalledTimes(1);
		expect(launcher.browsers[0]?.close).not.toHaveBeenCalled();
	});
});
