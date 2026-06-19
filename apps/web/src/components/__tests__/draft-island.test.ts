import { describe, expect, it } from "vite-plus/test";
import type { DraftRegistration } from "../../store/draft";
import type { FieldDiff } from "../../utils/walkTreeDiff";
import { selectChipKind } from "../draft-island";

const diff: FieldDiff[] = [{ code: "blockKeywords", oldValue: [], newValue: ["x"] }];
const fullReg: DraftRegistration = {
	pageKey: "rules",
	pageLabel: "动态过滤规则",
	diff,
	onSave: () => {},
	onDiscard: () => {},
};

describe("selectChipKind", () => {
	it("idle + 无 current → none(不渲染灵动岛)", () => {
		expect(selectChipKind("idle", null)).toBe("none");
	});

	it("idle + 有 current(不太可能但兜底)→ none", () => {
		expect(selectChipKind("idle", fullReg)).toBe("none");
	});

	it("dirty + 有 current → dirty", () => {
		expect(selectChipKind("dirty", fullReg)).toBe("dirty");
	});

	it("dirty + 无 current(异常态)→ none(避免 null 解引用 crash)", () => {
		expect(selectChipKind("dirty", null)).toBe("none");
	});

	it("saving → saving(即使 current 为 null,因为 saving 文案不依赖 current)", () => {
		expect(selectChipKind("saving", null)).toBe("saving");
		expect(selectChipKind("saving", fullReg)).toBe("saving");
	});

	it("saved → saved", () => {
		expect(selectChipKind("saved", fullReg)).toBe("saved");
	});

	it("error → error(errorMessage 由调用方另取)", () => {
		expect(selectChipKind("error", fullReg)).toBe("error");
		expect(selectChipKind("error", null)).toBe("error");
	});
});
