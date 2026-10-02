// @vitest-environment jsdom
/**
 * GlobalDraftBinder 接线测试 —— 全局 island 从 Rules.tsx 顶层抽出的子组件,只在
 * isGlobal 时挂载。与 PerUpEditor 的 useDirtyDraft 永不同时挂载(JSX 条件渲染互斥),
 * 从而消除「双 hook 抢单槽 draftStore」的 effect 时序竞态。
 *
 * 锁三件事:① 注册 pageKey "rules";② 打平 code 对齐(无 defaults 前缀);
 * ③ unmount → unregister(切到 per-UP 时清空槽,保证互斥不串台)。
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { useDraftStore } from "../../../store/draft";
import { GlobalDraftBinder } from "../../Rules";
import { makeDefaults } from "./fixtures";

function resetStore(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

const noop = () => {};

beforeEach(resetStore);
afterEach(() => {
	cleanup();
	resetStore();
});

describe("GlobalDraftBinder — 全局 island 互斥 binder", () => {
	it("mount → 以 pageKey 'rules' 注册到 draftStore", () => {
		const d = makeDefaults();
		render(<GlobalDraftBinder defaults={d} baseline={d} onSave={noop} onDiscard={noop} />);
		expect(useDraftStore.getState().current?.pageKey).toBe("rules");
	});

	it("filters 不同 → diff 检出打平 code 'blockKeywords'(无 defaults 前缀)", () => {
		const baseline = makeDefaults();
		const draft = makeDefaults();
		draft.filters = { ...draft.filters, blockKeywords: ["spam"] };
		render(
			<GlobalDraftBinder defaults={draft} baseline={baseline} onSave={noop} onDiscard={noop} />,
		);
		const codes = useDraftStore.getState().current?.diff.map((x) => x.code) ?? [];
		expect(codes).toContain("blockKeywords");
		expect(codes).not.toContain("defaults.filters.blockKeywords");
	});

	// 直播拆键(⑬d):周期开关、间隔与启动补报从 schedule 里搬出来各成一格,全局那一页的草稿要认得它们。
	it("周期开关 / 间隔 / 启动补报改了 → diff 检出对应的 code(schedule 那一段不再有它们)", () => {
		const baseline = makeDefaults();
		const draft = makeDefaults();
		draft.features = { ...draft.features, liveStreaming: true };
		draft.liveStreaming = { streamingIntervalHours: 2 };
		draft.liveStart = { catchUpOnBoot: true };
		render(
			<GlobalDraftBinder defaults={draft} baseline={baseline} onSave={noop} onDiscard={noop} />,
		);
		const codes = useDraftStore.getState().current?.diff.map((x) => x.code) ?? [];
		expect(codes).toContain("features.liveStreaming");
		expect(codes).toContain("liveStreaming.streamingIntervalHours");
		expect(codes).toContain("liveStart.catchUpOnBoot");
		expect(codes.filter((c) => c.startsWith("schedule."))).toEqual([]);
	});

	it("没改特性开关里别的键 → 不会冒出 features.* 的 diff(这一页只管周期那一把)", () => {
		const baseline = makeDefaults();
		const draft = makeDefaults();
		draft.features = { ...draft.features, post: false };
		render(
			<GlobalDraftBinder defaults={draft} baseline={baseline} onSave={noop} onDiscard={noop} />,
		);
		const codes = useDraftStore.getState().current?.diff.map((x) => x.code) ?? [];
		expect(codes.filter((c) => c.startsWith("features."))).toEqual([]);
	});

	it("unmount → unregister(current 归 null),与 per-UP binder 互斥不串台", () => {
		const d = makeDefaults();
		const { unmount } = render(
			<GlobalDraftBinder defaults={d} baseline={d} onSave={noop} onDiscard={noop} />,
		);
		expect(useDraftStore.getState().current?.pageKey).toBe("rules");
		unmount();
		expect(useDraftStore.getState().current).toBeNull();
	});
});
