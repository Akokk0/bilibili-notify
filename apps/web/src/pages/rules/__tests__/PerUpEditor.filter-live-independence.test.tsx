// @vitest-environment jsdom
/**
 * 复现 bug:per-UP「动态过滤覆盖」与「直播阈值覆盖」共享同一个 overrides.filters
 * 切片,开其中一个会把 minScPrice/minGuardLevel(阈值域)或 blockKeywords 等
 * (过滤域)一并带出来,导致另一个 section 的 toggle 被动跟着开。
 *
 * 两组断言:
 * - diff code:开「动态过滤」不该让阈值域字段(minScPrice/minGuardLevel)出现在
 *   灵动岛 diff 里,反之亦然 —— 抓的是"seed 时字段范围有没有越界"。
 * - badge 文案:同一个 draft 状态下切换 section,另一个 section 的 badge 不该
 *   被动变成"覆盖中" —— 抓的是用户实际看到的症状。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../../../services/api";
import { useDraftStore } from "../../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import { PerUpEditor } from "../PerUpEditor";
import { makeDefaults } from "./fixtures";

vi.mock("../../../services/api", () => ({
	api: { patch: vi.fn() },
	ApiError: class extends Error {},
}));

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function makeSub(): Subscription {
	return makeEmptySubscription("123456");
}

function diffCodes(): string[] {
	return useDraftStore.getState().current?.diff.map((d) => d.code) ?? [];
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	resetStore();
});

describe("per-UP 动态过滤覆盖 与 直播阈值覆盖 相互独立", () => {
	it("开「动态过滤覆盖」不应带出 minScPrice / minGuardLevel(阈值域)", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const sub = makeSub();
		const { container } = render(
			<QueryClientProvider client={qc}>
				<PerUpEditor sub={sub} defaults={makeDefaults()} section="filter" />
			</QueryClientProvider>,
		);
		// 未开启时只有头部一个 Toggle 按钮(InheritHint 无交互控件)。
		const headerToggle = container.querySelector("button");
		expect(headerToggle).not.toBeNull();
		fireEvent.click(headerToggle as Element);

		await waitFor(() => {
			expect(diffCodes()).toContain("blockKeywords");
		});
		expect(diffCodes()).not.toContain("minScPrice");
		expect(diffCodes()).not.toContain("minGuardLevel");
	});

	it("开「直播阈值覆盖」不应带出 blockKeywords 等过滤域字段", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const sub = makeSub();
		const { container } = render(
			<QueryClientProvider client={qc}>
				<PerUpEditor sub={sub} defaults={makeDefaults()} section="live" />
			</QueryClientProvider>,
		);
		const headerToggle = container.querySelector("button");
		expect(headerToggle).not.toBeNull();
		fireEvent.click(headerToggle as Element);

		await waitFor(() => {
			expect(diffCodes()).toContain("minScPrice");
		});
		expect(diffCodes()).not.toContain("blockKeywords");
		expect(diffCodes()).not.toContain("blockRegex");
		expect(diffCodes()).not.toContain("whitelistKeywords");
	});

	it("开「动态过滤覆盖」后切到「直播阈值」section,badge 不应被动显示为覆盖中", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const sub = makeSub();
		const { container, rerender } = render(
			<QueryClientProvider client={qc}>
				<PerUpEditor sub={sub} defaults={makeDefaults()} section="filter" />
			</QueryClientProvider>,
		);
		fireEvent.click(container.querySelector("button") as Element);
		await waitFor(() => {
			expect(diffCodes()).toContain("blockKeywords");
		});

		rerender(
			<QueryClientProvider client={qc}>
				<PerUpEditor sub={sub} defaults={makeDefaults()} section="live" />
			</QueryClientProvider>,
		);
		const liveBox = within(container);
		expect(liveBox.getByText("直播阈值覆盖")).toBeTruthy();
		expect(liveBox.queryByText("覆盖中")).toBeNull();
		expect(liveBox.getByText("继承")).toBeTruthy();
	});

	it("开「直播阈值覆盖」后切到「动态过滤」section,badge 不应被动显示为覆盖中", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const sub = makeSub();
		const { container, rerender } = render(
			<QueryClientProvider client={qc}>
				<PerUpEditor sub={sub} defaults={makeDefaults()} section="live" />
			</QueryClientProvider>,
		);
		fireEvent.click(container.querySelector("button") as Element);
		await waitFor(() => {
			expect(diffCodes()).toContain("minScPrice");
		});

		rerender(
			<QueryClientProvider client={qc}>
				<PerUpEditor sub={sub} defaults={makeDefaults()} section="filter" />
			</QueryClientProvider>,
		);
		const filterBox = within(container);
		expect(filterBox.getByText("动态过滤覆盖")).toBeTruthy();
		expect(filterBox.queryByText("覆盖中")).toBeNull();
		expect(filterBox.getByText("继承")).toBeTruthy();
	});

	it("关闭「动态过滤覆盖」并保存 → PATCH body 里过滤域字段显式 null,阈值域字段不受影响(不会保存后又复活)", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const sub: Subscription = {
			...makeSub(),
			overrides: { filters: { blockKeywords: ["广告"], minScPrice: 30 } },
		};
		const { container } = render(
			<QueryClientProvider client={qc}>
				<PerUpEditor sub={sub} defaults={makeDefaults()} section="filter" />
			</QueryClientProvider>,
		);
		await waitFor(() => {
			expect(useDraftStore.getState().current?.pageKey).toBe("rules-perup");
		});
		// 已开启:关掉过滤域(点一次头部 Toggle)。
		const toggle = container.querySelector("button") as Element;
		fireEvent.click(toggle);
		await waitFor(() => {
			expect(diffCodes()).toContain("blockKeywords");
		});

		const onSave = useDraftStore.getState().current?.onSave as (() => Promise<void>) | undefined;
		await onSave?.();

		expect(api.patch).toHaveBeenCalledWith(
			`/api/subs/${sub.id}`,
			expect.objectContaining({
				overrides: expect.objectContaining({
					filters: { blockKeywords: null, minScPrice: 30 },
				}),
			}),
		);
	});
});
