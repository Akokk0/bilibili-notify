// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DashboardBootstrap, FEATURE_KEYS } from "../api/types";
import { ConfirmProvider } from "../components/ui";
import { RulesTab } from "./RulesTab";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
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
});

describe("RulesTab subscription switch guard", () => {
	it("blocks a switch when cancelled", async () => {
		const onData = vi.fn();
		const onDirty = vi.fn();
		await render(
			<ConfirmProvider>
				<RulesTab data={makeDashboard()} onData={onData} onDirty={onDirty} />
			</ConfirmProvider>,
		);

		await click(getButton("自定义"));
		await changeSelect("sub-2");
		expect(container.textContent).toContain("当前 UP 有未保存高级规则草稿。确定切换吗？");
		await click(getButton("取消"));

		expect(getSelect().value).toBe("sub-1");
		expect(onData).not.toHaveBeenCalled();
	});

	it("allows a switch when approved", async () => {
		const onData = vi.fn();
		const onDirty = vi.fn();
		await render(
			<ConfirmProvider>
				<RulesTab data={makeDashboard()} onData={onData} onDirty={onDirty} />
			</ConfirmProvider>,
		);

		await click(getButton("自定义"));
		await changeSelect("sub-2");
		expect(container.textContent).toContain("当前 UP 有未保存高级规则草稿。确定切换吗？");
		await click(getButton("确定"));

		expect(getSelect().value).toBe("sub-2");
		expect(onData).not.toHaveBeenCalled();
	});
});

async function render(node: ReactNode) {
	root = createRoot(container);
	await act(async () => {
		root?.render(node);
	});
	await flush();
	await flush();
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function changeSelect(value: string) {
	const select = getSelect();
	select.value = value;
	await act(async () => {
		select.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
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

function getSelect(): HTMLSelectElement {
	const select = container.querySelector("select");
	if (!select) throw new Error("Select not found");
	return select as HTMLSelectElement;
}

function makeDashboard(): DashboardBootstrap {
	const features = Object.fromEntries(
		FEATURE_KEYS.map((key) => [key, true]),
	) as DashboardBootstrap["globals"]["defaults"]["features"];
	return {
		snapshot: {
			status: "ready",
			version: "test",
		} as DashboardBootstrap["snapshot"],
		globals: {
			app: {} as DashboardBootstrap["globals"]["app"],
			master: {} as DashboardBootstrap["globals"]["master"],
			defaults: {
				features,
				templates: {
					dynamic: "动态",
					dynamicVideo: "视频",
					liveStart: "开播",
					liveOngoing: "直播中",
					liveEnd: "下播",
					liveSummary: "总结",
					specialDanmaku: "特别弹幕",
					specialUserEnter: "特别进房",
				},
				filters: {
					blockKeywords: [],
					whitelistKeywords: [],
					blockRegex: [],
					whitelistRegex: [],
					minScPrice: 0,
					minGuardLevel: 1,
					blockForward: false,
					blockArticle: false,
					blockDraw: false,
					blockAv: false,
				},
				schedule: {
					pushTime: 0,
					restartPush: false,
					quietHours: [],
				},
				ai: {
					preset: "inherit",
					temperature: 1,
					persona: {
						name: "默认",
						addressUser: "你",
						addressSelf: "我",
						traits: "稳妥",
						catchphrase: "收到",
						baseRole: "助手",
						extraSystemPrompt: "",
					},
					dynamicPrompt: "动态",
					liveSummaryPrompt: "总结",
					presets: [{ id: "mock", label: "Mock" }],
				},
				cardStyle: {
					enabled: false,
					cardColorStart: "#000000",
					cardColorEnd: "#ffffff",
					font: "system-ui",
					hideDesc: false,
					hideFollower: false,
				},
				imageGroup: {
					enable: false,
					forward: false,
				},
			} as unknown as DashboardBootstrap["globals"]["defaults"],
		} as DashboardBootstrap["globals"],
		subscriptions: [
			{
				id: "sub-1",
				uid: "1001",
				name: "UP 1",
				overrides: {},
			},
			{
				id: "sub-2",
				uid: "1002",
				name: "UP 2",
				overrides: {},
			},
		] as DashboardBootstrap["subscriptions"],
		adapters: [],
		targets: [],
	};
}
