import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { FieldDiff } from "../../utils/walkTreeDiff";
import { type DraftRegistration, deriveNaturalUiState, useDraftStore } from "../draft";

function reset(): void {
	useDraftStore.setState({
		current: null,
		uiState: "idle",
		errorMessage: null,
		panelLocked: false,
	});
}

function reg(over: Partial<DraftRegistration> = {}): DraftRegistration {
	return {
		pageKey: "rules",
		pageLabel: "动态过滤规则",
		diff: [],
		onSave: () => {},
		onDiscard: () => {},
		...over,
	};
}

const dirtyDiff: FieldDiff[] = [{ code: "blockKeywords", oldValue: [], newValue: ["spam"] }];

describe("deriveNaturalUiState", () => {
	it("current=null → idle", () => {
		expect(deriveNaturalUiState(null)).toBe("idle");
	});
	it("diff 空 → idle", () => {
		expect(deriveNaturalUiState(reg({ diff: [] }))).toBe("idle");
	});
	it("diff 非空 → dirty", () => {
		expect(deriveNaturalUiState(reg({ diff: dirtyDiff }))).toBe("dirty");
	});
});

describe("useDraftStore", () => {
	beforeEach(reset);

	it("register diff 空 → uiState idle", () => {
		useDraftStore.getState().register(reg({ diff: [] }));
		expect(useDraftStore.getState().uiState).toBe("idle");
		expect(useDraftStore.getState().current?.pageKey).toBe("rules");
	});

	it("register diff 非空 → uiState dirty", () => {
		useDraftStore.getState().register(reg({ diff: dirtyDiff }));
		expect(useDraftStore.getState().uiState).toBe("dirty");
	});

	it("同页面 update + saving 进行中 → 保留 saving 不重置为自然态", () => {
		useDraftStore.getState().register(reg({ diff: dirtyDiff }));
		useDraftStore.getState().setUiState("saving");
		expect(useDraftStore.getState().uiState).toBe("saving");
		// 用户在 saving 期间又改了一字段 → diff 重新算 → register 顶替
		useDraftStore.getState().register(
			reg({
				diff: [...dirtyDiff, { code: "blockRegex", oldValue: [], newValue: ["^x"] }],
			}),
		);
		expect(useDraftStore.getState().uiState).toBe("saving");
	});

	it("跨页 register → uiState/panelLocked/errorMessage 重置", () => {
		useDraftStore.getState().register(reg({ pageKey: "rules", diff: dirtyDiff }));
		useDraftStore.getState().setUiState("error", "boom");
		useDraftStore.getState().togglePanelLocked(true);
		expect(useDraftStore.getState().uiState).toBe("error");

		useDraftStore.getState().register(reg({ pageKey: "ai", diff: [] }));
		expect(useDraftStore.getState().uiState).toBe("idle");
		expect(useDraftStore.getState().errorMessage).toBeNull();
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});

	it("unregister → 全部重置", () => {
		useDraftStore.getState().register(reg({ diff: dirtyDiff }));
		useDraftStore.getState().setUiState("error", "x");
		useDraftStore.getState().togglePanelLocked(true);
		useDraftStore.getState().unregister();
		const s = useDraftStore.getState();
		expect(s.current).toBeNull();
		expect(s.uiState).toBe("idle");
		expect(s.errorMessage).toBeNull();
		expect(s.panelLocked).toBe(false);
	});

	it("setUiState error 带 errorMessage", () => {
		useDraftStore.getState().setUiState("error", "网络中断");
		expect(useDraftStore.getState().uiState).toBe("error");
		expect(useDraftStore.getState().errorMessage).toBe("网络中断");
	});

	it("setUiState 非 error → errorMessage 清空", () => {
		useDraftStore.getState().setUiState("error", "x");
		useDraftStore.getState().setUiState("saved");
		expect(useDraftStore.getState().errorMessage).toBeNull();
	});

	it("togglePanelLocked 不传参 → flip", () => {
		expect(useDraftStore.getState().panelLocked).toBe(false);
		useDraftStore.getState().togglePanelLocked();
		expect(useDraftStore.getState().panelLocked).toBe(true);
		useDraftStore.getState().togglePanelLocked();
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});

	it("togglePanelLocked 传 true/false → 显式 set", () => {
		useDraftStore.getState().togglePanelLocked(true);
		expect(useDraftStore.getState().panelLocked).toBe(true);
		useDraftStore.getState().togglePanelLocked(true);
		expect(useDraftStore.getState().panelLocked).toBe(true);
		useDraftStore.getState().togglePanelLocked(false);
		expect(useDraftStore.getState().panelLocked).toBe(false);
	});
});
