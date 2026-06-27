import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as desktopToken from "../../services/desktop-token";
import { externalLinkClick, isDesktop, openExternal } from "../externalLink";

/**
 * 外链跳转探测 —— node 环境无 DOM,用伪 `window` + spy `getDesktopToken` 模拟两种壳:
 * - 桌面壳:`getDesktopToken()` 有值 → 同窗口导航(交 Rust on_navigation)。
 * - 浏览器:无 token → 放行原生 `target="_blank"`,handler 不 preventDefault。
 */

type FakeWindow = {
	open?: (...args: unknown[]) => unknown;
	location?: { assign?: (url: string) => void };
};

function setWindow(win: FakeWindow): void {
	(globalThis as unknown as { window?: FakeWindow }).window = win;
}

function mockDesktop(token: string | null): void {
	vi.spyOn(desktopToken, "getDesktopToken").mockReturnValue(token);
}

/** 构造一个最小事件桩,只带 handler 读取的字段。 */
function fakeEvent(over?: Partial<Record<string, unknown>>) {
	return {
		defaultPrevented: false,
		button: 0,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		preventDefault: vi.fn(),
		...over,
	} as unknown as Parameters<ReturnType<typeof externalLinkClick>>[0] & {
		preventDefault: ReturnType<typeof vi.fn>;
	};
}

afterEach(() => {
	(globalThis as unknown as { window?: FakeWindow }).window = undefined;
	vi.restoreAllMocks();
});

describe("isDesktop", () => {
	it("无 token → false", () => {
		mockDesktop(null);
		expect(isDesktop()).toBe(false);
	});

	it("有 token → true", () => {
		mockDesktop("secret");
		expect(isDesktop()).toBe(true);
	});
});

describe("openExternal", () => {
	it("桌面壳:同窗口导航 location.assign", () => {
		mockDesktop("secret");
		const assign = vi.fn();
		setWindow({ location: { assign }, open: vi.fn() });
		openExternal("https://afdian.com/a/akokko");
		expect(assign).toHaveBeenCalledWith("https://afdian.com/a/akokko");
	});

	it("浏览器:走 window.open(_blank, noopener)", () => {
		mockDesktop(null);
		const open = vi.fn();
		setWindow({ open });
		openExternal("https://x.test");
		expect(open).toHaveBeenCalledWith("https://x.test", "_blank", "noopener,noreferrer");
	});
});

describe("externalLinkClick", () => {
	it("桌面壳 + 普通左键 → preventDefault + 同窗口导航", () => {
		mockDesktop("secret");
		const assign = vi.fn();
		setWindow({ location: { assign } });
		const e = fakeEvent();
		externalLinkClick("https://x.test")(e);
		expect(e.preventDefault).toHaveBeenCalledOnce();
		expect(assign).toHaveBeenCalledWith("https://x.test");
	});

	it("浏览器 → 不拦截(放行原生 target=_blank)", () => {
		mockDesktop(null);
		setWindow({ open: vi.fn() });
		const e = fakeEvent();
		externalLinkClick("https://x.test")(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	it("桌面壳但带修饰键 / 中键 → 不拦截", () => {
		mockDesktop("secret");
		const assign = vi.fn();
		setWindow({ location: { assign } });
		for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
			const e = fakeEvent(over);
			externalLinkClick("https://x.test")(e);
			expect(e.preventDefault).not.toHaveBeenCalled();
		}
		expect(assign).not.toHaveBeenCalled();
	});

	it("无 href → no-op", () => {
		mockDesktop("secret");
		const assign = vi.fn();
		setWindow({ location: { assign } });
		const e = fakeEvent();
		externalLinkClick(undefined)(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(assign).not.toHaveBeenCalled();
	});
});
