import { describe, expect, it } from "vite-plus/test";
import { addGroupName, toggleGroup } from "./group-edit";

/**
 * 「编辑分组」弹框语义:编辑所属分组(勾=加、取消=移)+ 新建。这里穷举纯逻辑边界。
 */
describe("toggleGroup", () => {
	it("勾选一个未所属的分组 → 追加到末尾", () => {
		expect(toggleGroup(["A"], "B")).toEqual(["A", "B"]);
	});

	it("取消一个已所属的分组 → 移除", () => {
		expect(toggleGroup(["A", "B"], "A")).toEqual(["B"]);
	});
});

describe("addGroupName", () => {
	it("加入新分组名并 trim 两端空白", () => {
		expect(addGroupName(["A"], "  B ")).toEqual(["A", "B"]);
	});

	it("空白名忽略,原样返回", () => {
		expect(addGroupName(["A"], "   ")).toEqual(["A"]);
	});

	it("trim 后已存在则不重复加", () => {
		expect(addGroupName(["A"], " A ")).toEqual(["A"]);
	});
});
