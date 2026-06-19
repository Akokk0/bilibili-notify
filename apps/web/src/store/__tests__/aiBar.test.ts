import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useAiBarStore } from "../aiBar";

function reset(): void {
	useAiBarStore.setState({ dismissed: false, expanded: false });
}

describe("useAiBarStore", () => {
	beforeEach(reset);

	it("默认 dismissed=false / expanded=false(AiBar 默认展开显示)", () => {
		const s = useAiBarStore.getState();
		expect(s.dismissed).toBe(false);
		expect(s.expanded).toBe(false);
	});

	it("setDismissed(true) → dismissed=true", () => {
		useAiBarStore.getState().setDismissed(true);
		expect(useAiBarStore.getState().dismissed).toBe(true);
	});

	it("setExpanded(true) 直接 set", () => {
		useAiBarStore.getState().setExpanded(true);
		expect(useAiBarStore.getState().expanded).toBe(true);
	});

	it("setExpanded(updater fn) 跟随 prev 翻转", () => {
		useAiBarStore.getState().setExpanded((v) => !v);
		expect(useAiBarStore.getState().expanded).toBe(true);
		useAiBarStore.getState().setExpanded((v) => !v);
		expect(useAiBarStore.getState().expanded).toBe(false);
	});

	it("dismissed 与 expanded 互不污染", () => {
		useAiBarStore.getState().setExpanded(true);
		useAiBarStore.getState().setDismissed(true);
		const s = useAiBarStore.getState();
		expect(s.dismissed).toBe(true);
		expect(s.expanded).toBe(true);
	});
});
