// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DashboardBootstrap } from "./api/types";

type DashboardEventsSubscriber = (handlers: {
	readonly onHydrate: (data: DashboardBootstrap) => void;
	readonly onRefresh: () => void;
	readonly onOpen: () => void;
	readonly onError: () => void;
}) => (() => void) | undefined;

const apiMocks = vi.hoisted(() => ({
	bootstrap: vi.fn<() => Promise<DashboardBootstrap>>(),
	subscribeDashboardEvents: vi.fn<DashboardEventsSubscriber>(),
}));

vi.mock("./api/client", () => ({
	dashboardApi: {
		bootstrap: apiMocks.bootstrap,
	},
	errorDetails: (error: unknown) => ({ summary: String(error) }),
	resolveApiBase: () => "/api",
	subscribeDashboardEvents: apiMocks.subscribeDashboardEvents,
}));

vi.mock("./tabs/SettingsTab", async () => {
	const React = await import("react");
	return {
		SettingsTab({ onDirty }: { readonly onDirty: (dirty: boolean) => void }) {
			React.useEffect(() => {
				onDirty(true);
				return () => onDirty(false);
			}, [onDirty]);
			return <div data-testid="settings-panel">settings panel</div>;
		},
	};
});

vi.mock("./tabs/RulesTab", () => ({
	RulesTab: () => <div data-testid="rules-panel">rules panel</div>,
}));

vi.mock("./tabs/SubscriptionsTab", () => ({
	SubscriptionsTab: () => <div data-testid="subscriptions-panel">subscriptions panel</div>,
}));

vi.mock("./tabs/TargetsTab", () => ({
	TargetsTab: () => <div data-testid="targets-panel">targets panel</div>,
}));

import { App } from "./App";
import { ConfirmProvider } from "./components/ui";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
	// __ASTRBOT_PAGE_VERSION__ 由 page 的 vite.config define 注入,根 vitest 配置不应用该
	// define,需在测试里补上这个全局,否则 App 渲染版本徽章时会 ReferenceError。
	vi.stubGlobal("__ASTRBOT_PAGE_VERSION__", "test");
	apiMocks.bootstrap.mockResolvedValue(makeDashboard());
	// 桥接订阅返回清理函数 → App 走 bridge 分支(iframe 真实路径),不会创建
	// 轮询兜底那条路上的 setInterval,避免递归定时器钉住 worker 事件循环导致测试进程不退出。
	apiMocks.subscribeDashboardEvents.mockReturnValue(() => {});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
	}
	container.remove();
	root = undefined;
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("App tab guard", () => {
	it("asks when the active tab is dirty and blocks navigation when cancelled", async () => {
		await renderApp();

		expect(panel("settings-panel")).not.toBeNull();
		await click(getButton("高级规则"));
		expect(container.textContent).toContain("还有未保存草稿：设置。确定切换 Tab 吗？");
		await click(getButton("取消"));

		expect(panel("settings-panel")).not.toBeNull();
		expect(panel("rules-panel")).toBeNull();
	});

	it("asks when the active tab is dirty and allows navigation when approved", async () => {
		await renderApp();

		await click(getButton("高级规则"));
		expect(container.textContent).toContain("还有未保存草稿：设置。确定切换 Tab 吗？");
		await click(getButton("确定"));

		expect(panel("rules-panel")).not.toBeNull();
		expect(panel("settings-panel")).toBeNull();
	});
});

describe("App SSE setup", () => {
	it("prefers the bridge subscription over direct EventSource", async () => {
		const directEventSource = vi.fn();
		class FakeEventSource {
			static readonly CLOSED = 2;
			readonly readyState = 0;
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;

			constructor(url: string) {
				directEventSource(url);
			}

			addEventListener() {}

			close() {}
		}
		// vi.stubGlobal 自动在 afterEach 的 vi.unstubAllGlobals 里恢复,无需手动 save/restore。
		vi.stubGlobal("EventSource", FakeEventSource);
		apiMocks.subscribeDashboardEvents.mockReturnValue(() => {});

		await renderApp();

		expect(apiMocks.subscribeDashboardEvents).toHaveBeenCalledTimes(1);
		expect(directEventSource).not.toHaveBeenCalled();
	});
});

async function renderApp() {
	await render(
		<ConfirmProvider>
			<App />
		</ConfirmProvider>,
	);
	await flush();
	await flush();
}

async function render(node: ReactNode) {
	root = createRoot(container);
	await act(async () => {
		root?.render(node);
	});
	await flush();
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

function getButton(label: string): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!button) throw new Error(`Button not found: ${label}`);
	return button;
}

function panel(testId: string): Element | null {
	return container.querySelector(`[data-testid="${testId}"]`);
}

function makeDashboard(): DashboardBootstrap {
	return {
		snapshot: {
			status: "ready",
			version: "test",
		} as DashboardBootstrap["snapshot"],
		globals: {} as DashboardBootstrap["globals"],
		subscriptions: [],
		adapters: [],
		targets: [],
	};
}
