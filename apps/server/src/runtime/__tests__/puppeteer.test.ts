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

/** 渲染页发出的一个请求的替身。 */
function makeFakeRequest(url: string) {
	return {
		url: () => url,
		abort: vi.fn(async () => {}),
		continue: vi.fn(async () => {}),
	};
}

type FakeRequest = ReturnType<typeof makeFakeRequest>;

function makeFakePage() {
	/** 请求闸相关的调用,按发生的先后记 —— 「先挂监听、再开拦截」的次序靠它断言。 */
	const calls: string[] = [];
	const requestHandlers: Array<(request: FakeRequest) => void> = [];
	return {
		calls,
		/** 演页面发出一个请求:挨个叫挂上来的监听。 */
		emitRequest(request: FakeRequest): void {
			for (const handler of requestHandlers) handler(request);
		},
		on: vi.fn((event: "request", handler: (request: FakeRequest) => void) => {
			calls.push(`on:${event}`);
			requestHandlers.push(handler);
		}),
		setRequestInterception: vi.fn(async (enabled: boolean) => {
			calls.push(`setRequestInterception:${enabled}`);
		}),
		setContent: vi.fn(async () => {}),
		waitForFunction: vi.fn(async () => undefined),
		$: vi.fn(async () => null),
		screenshot: vi.fn(async () => Buffer.alloc(0)),
		close: vi.fn(async () => {}),
	};
}

type FakePage = ReturnType<typeof makeFakePage>;

function makeFakeBrowser(pid: number | null = 4242) {
	let connected = true;
	const pages: FakePage[] = [];
	return {
		pages,
		get connected() {
			return connected;
		},
		process: vi.fn(() => (pid === null ? null : { pid })),
		newPage: vi.fn(async () => {
			const page = makeFakePage();
			pages.push(page);
			return page;
		}),
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

	it("closeIdleNow:把空闲关闭提前到现在;有活跃页就不动、回 false", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 5_000,
		});
		const page = await adapter.page();
		// 正在渲染:不能关。
		expect(await adapter.closeIdleNow()).toBe(false);
		expect(launcher.browsers[0]?.close).not.toHaveBeenCalled();
		await page.close();
		// 空闲了:立刻关,不等 5s;计时器也一并清掉,不会关第二次。
		expect(await adapter.closeIdleNow()).toBe(true);
		expect(launcher.browsers[0]?.close).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(launcher.browsers[0]?.close).toHaveBeenCalledTimes(1);
		// 没有浏览器在跑时也回 false —— 没东西可关。
		expect(await adapter.closeIdleNow()).toBe(false);
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
		const logger = makeLogger();
		const endpoint = "ws://user:password@browserless:3000/devtools?token=private#secret";
		const adapter = createPuppeteerAdapter({
			chromeEndpoint: endpoint,
			logger,
			launcher,
			idleTimeoutMs: 0,
		});
		await adapter.page();
		expect(launcher.launch).not.toHaveBeenCalled();
		expect(launcher.connect).toHaveBeenCalledTimes(1);
		expect(launcher.connect.mock.calls[0]?.[0]).toMatchObject({
			browserWSEndpoint: endpoint,
		});
		expect(logger.info).toHaveBeenCalledWith("连接远程浏览器", {
			endpoint: "ws://browserless:3000/devtools",
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

describe("createPuppeteerAdapter browserProcess", () => {
	it("没起过浏览器 → none:资源卡那一行显示「未接入」而不是 0MB", () => {
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher: makeFakeLauncher(),
		});
		expect(adapter.browserProcess()).toEqual({ state: "none", pid: null });
	});

	it("本地跑着 → running 带 pid,量子树 RSS 要靠它当根", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher,
		});
		const page = await adapter.page();
		expect(adapter.browserProcess()).toEqual({ state: "running", pid: 4242 });
		await page.close();
	});

	it("空闲关掉之后 → closed:是「省内存关了」,不是「没配」", async () => {
		vi.useFakeTimers();
		try {
			const adapter = createPuppeteerAdapter({
				chromePath: "/fake/chrome",
				logger: makeLogger(),
				launcher: makeFakeLauncher(),
				idleTimeoutMs: 5_000,
			});
			const page = await adapter.page();
			await page.close();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(adapter.browserProcess()).toEqual({ state: "closed", pid: null });
		} finally {
			vi.useRealTimers();
		}
	});

	it("远程浏览器 → remote:进程在别人机器上,这里量不到", async () => {
		const adapter = createPuppeteerAdapter({
			chromeEndpoint: "ws://browserless:3000",
			logger: makeLogger(),
			launcher: makeFakeLauncher(),
		});
		const page = await adapter.page();
		expect(adapter.browserProcess()).toEqual({ state: "remote", pid: null });
		await page.close();
	});
});

/**
 * 渲染页的请求闸(3a-37「出图器零联网」):每一页无条件开拦截,只放行内嵌内容(`data:`),
 * 别的请求一律掐断并记一笔。出卡、压图、示例预览、探活都经 `page()`,所以闸长在这里。
 */
describe("createPuppeteerAdapter 渲染页请求闸", () => {
	function makeAdapter(endpoint?: string) {
		const launcher = makeFakeLauncher();
		const logger = makeLogger();
		const adapter = createPuppeteerAdapter({
			...(endpoint ? { chromeEndpoint: endpoint } : { chromePath: "/fake/chrome" }),
			logger,
			launcher,
			idleTimeoutMs: 0,
		});
		const fakePage = (): FakePage => {
			const page = launcher.browsers[0]?.pages[0];
			if (!page) throw new Error("fake page not created");
			return page;
		};
		return { adapter, logger, fakePage };
	}

	it.each([
		["本机 Chrome", undefined],
		["远程 Chrome", "ws://browserless:3000"],
	])("%s:每一页都开拦截,且先挂监听、再开拦截", async (_name, endpoint) => {
		// 反过来的话,开拦截到挂上监听之间发出的请求没人处理,会把 setContent 挂到超时。
		const { adapter, fakePage } = makeAdapter(endpoint);
		await adapter.page();
		expect(fakePage().calls).toEqual(["on:request", "setRequestInterception:true"]);
	});

	it("不是内嵌内容的请求 → 掐断、回调收到原样的地址;账交给回调方记,适配层不再记一遍", async () => {
		const { adapter, logger, fakePage } = makeAdapter();
		const onBlockedRequest = vi.fn();
		await adapter.page({ onBlockedRequest });
		const request = makeFakeRequest("https://example.invalid/a.png?token=1");

		fakePage().emitRequest(request);

		expect(request.abort).toHaveBeenCalledTimes(1);
		expect(request.continue).not.toHaveBeenCalled();
		expect(onBlockedRequest.mock.calls).toEqual([["https://example.invalid/a.png?token=1"]]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("内嵌内容(data:)的请求 → 不掐断也不放行(它本来就拦不了),回调与日志都没有", async () => {
		const { adapter, logger, fakePage } = makeAdapter();
		const onBlockedRequest = vi.fn();
		await adapter.page({ onBlockedRequest });
		const request = makeFakeRequest("data:image/png;base64,AAAA");

		fakePage().emitRequest(request);

		expect(request.abort).not.toHaveBeenCalled();
		expect(request.continue).not.toHaveBeenCalled();
		expect(onBlockedRequest).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("掐断时请求已经没了(关页瞬间的在途请求)→ 不留未处理的拒绝", async () => {
		const { adapter, fakePage } = makeAdapter();
		await adapter.page();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			// `abort` 用裸函数:`vi.fn` 会给返回的 Promise 挂上自己的处理(记 settledResults),
			// 拒绝就算「有人处理了」,实现漏掉 catch 这条也照样绿。
			fakePage().emitRequest({
				...makeFakeRequest("https://example.invalid/a.png"),
				abort: () => Promise.reject(new Error("Target closed")),
			} as FakeRequest);
			// 未处理的拒绝在微任务排空之后才报,等过一轮宏任务再看。
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("闸没开成 → 这一页不交出去:关掉它、把错抛给调用方,下一次取页不受影响", async () => {
		const launcher = makeFakeLauncher();
		const adapter = createPuppeteerAdapter({
			chromePath: "/fake/chrome",
			logger: makeLogger(),
			launcher,
			idleTimeoutMs: 0,
		});
		await (await adapter.page()).close();
		const bad = makeFakePage();
		bad.setRequestInterception.mockRejectedValueOnce(new Error("Protocol error"));
		launcher.browsers[0]?.newPage.mockResolvedValueOnce(bad);

		await expect(adapter.page()).rejects.toThrow("Protocol error");
		expect(bad.close).toHaveBeenCalledTimes(1);
		// 串行闸已放开、活跃页没多记:下一页照常取得到。
		const next = await adapter.page();
		await next.close();
		expect(await adapter.closeIdleNow()).toBe(true);
	});

	it("调用方没传回调 → 照样掐断,适配层自己记一条(地址不带参数)", async () => {
		const { adapter, logger, fakePage } = makeAdapter();
		await adapter.page();
		const request = makeFakeRequest("https://example.invalid/a.png?token=1");

		fakePage().emitRequest(request);

		expect(request.abort).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		// 查询串里可能有签名、令牌,不进日志。
		expect(logger.warn).toHaveBeenCalledWith("已拦截渲染页的外部请求", {
			url: "https://example.invalid/a.png",
		});
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("token");
	});
});
