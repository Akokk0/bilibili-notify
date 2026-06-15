// @vitest-environment jsdom
/**
 * PerUpEditor 接入草稿灵动岛的接线测试。
 *
 * 投影 → diff code 的结构映射由 perup-island.test.ts(纯函数)覆盖;本文件验证
 * 组件层接线:PerUpEditor 把投影喂给 useDirtyDraft(pageKey "rules-perup"),编辑
 * 字段后 draftStore 检出对应 diff code,且页内保存/丢弃按钮已统一到灵动岛(移除)。
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "../../../store/draft";
import { makeEmptySubscription, type Subscription } from "../../../types/domain";
import { PerUpEditor } from "../PerUpEditor";
import type { SectionId } from "../sections";
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

function makeSub(overrides: Subscription["overrides"]): Subscription {
	return { ...makeEmptySubscription("123456"), overrides };
}

function renderEditor(sub: Subscription, section: SectionId) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<PerUpEditor sub={sub} defaults={makeDefaults()} section={section} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	resetStore();
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	resetStore();
});

describe("PerUpEditor 接入草稿灵动岛", () => {
	it("mount → 以 pageKey 'rules-perup' 注册到 draftStore", () => {
		renderEditor(makeSub({ imageGroup: { enable: true, forward: false } }), "imageGroup");
		expect(useDraftStore.getState().current?.pageKey).toBe("rules-perup");
	});

	it("编辑字段 → draftStore diff 检出对应 code(draft→投影→hook 路径活)", async () => {
		const { container } = renderEditor(
			makeSub({ imageGroup: { enable: true, forward: false } }),
			"imageGroup",
		);
		const enableToggle = container.querySelector('[data-code="enable"] button');
		expect(enableToggle).not.toBeNull();
		fireEvent.click(enableToggle as Element);
		await waitFor(() => {
			const codes = useDraftStore.getState().current?.diff.map((d) => d.code) ?? [];
			expect(codes).toContain("enable");
		});
	});

	it("即使变 dirty 也不渲染页内『保存』『丢弃』按钮(统一到灵动岛)", async () => {
		const { container } = renderEditor(
			makeSub({ imageGroup: { enable: true, forward: false } }),
			"imageGroup",
		);
		// 先编辑成 dirty —— 移除前此时页内会冒出保存/丢弃按钮,移除后不应有。
		fireEvent.click(container.querySelector('[data-code="enable"] button') as Element);
		await waitFor(() => {
			expect(useDraftStore.getState().current?.diff.length ?? 0).toBeGreaterThan(0);
		});
		expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
		expect(screen.queryByRole("button", { name: "丢弃" })).toBeNull();
	});
});
