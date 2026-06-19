import { describe, expect, it } from "vite-plus/test";
import { walkTreeDiff } from "../walkTreeDiff";

describe("walkTreeDiff", () => {
	it("完全相同 → 空 diff", () => {
		expect(walkTreeDiff({ a: 1, b: "x" }, { a: 1, b: "x" })).toEqual([]);
	});

	it("叶子值不同 → 一条 diff,带 dot-path", () => {
		const diff = walkTreeDiff({ a: 1 }, { a: 2 });
		expect(diff).toEqual([{ code: "a", oldValue: 1, newValue: 2 }]);
	});

	it("嵌套 object 不同字段单独 diff,path 用 . 连接", () => {
		const diff = walkTreeDiff(
			{ schedule: { pushTime: 5, restartPush: false } },
			{ schedule: { pushTime: 10, restartPush: false } },
		);
		expect(diff).toEqual([{ code: "schedule.pushTime", oldValue: 5, newValue: 10 }]);
	});

	it("数组当叶子整体比较:长度不同 → 一条 diff", () => {
		const diff = walkTreeDiff({ keywords: ["a", "b"] }, { keywords: ["a", "b", "c"] });
		expect(diff).toEqual([{ code: "keywords", oldValue: ["a", "b"], newValue: ["a", "b", "c"] }]);
	});

	it("数组当叶子:同长不同内容 → 一条 diff", () => {
		const diff = walkTreeDiff({ k: ["x"] }, { k: ["y"] });
		expect(diff).toEqual([{ code: "k", oldValue: ["x"], newValue: ["y"] }]);
	});

	it("数组同长同内容 → 无 diff", () => {
		const diff = walkTreeDiff({ k: ["a", "b"] }, { k: ["a", "b"] });
		expect(diff).toEqual([]);
	});

	it("数组里嵌套对象:深度等价 → 无 diff(JSON 兜底)", () => {
		const diff = walkTreeDiff(
			{ quietHours: [{ start: 0, end: 7 }] },
			{ quietHours: [{ start: 0, end: 7 }] },
		);
		expect(diff).toEqual([]);
	});

	it("数组里嵌套对象:深度不等价 → 一条 diff", () => {
		const diff = walkTreeDiff(
			{ quietHours: [{ start: 0, end: 7 }] },
			{ quietHours: [{ start: 0, end: 8 }] },
		);
		expect(diff).toEqual([
			{
				code: "quietHours",
				oldValue: [{ start: 0, end: 7 }],
				newValue: [{ start: 0, end: 8 }],
			},
		]);
	});

	it("null vs undefined → 视为不同(PATCH 语义:null=置空,undefined=不改)", () => {
		const diff = walkTreeDiff({ x: null }, { x: undefined });
		expect(diff).toEqual([{ code: "x", oldValue: null, newValue: undefined }]);
	});

	it("双 undefined / 双 missing → 无 diff", () => {
		expect(walkTreeDiff({ a: undefined }, {})).toEqual([]);
		expect(walkTreeDiff({}, { a: undefined })).toEqual([]);
	});

	it("类型不同(number vs string)→ 一条 diff", () => {
		expect(walkTreeDiff({ a: 1 }, { a: "1" })).toEqual([{ code: "a", oldValue: 1, newValue: "1" }]);
	});

	it("一侧 plain object 一侧 undefined → 当 leaf 整体输出(add per-UP override 场景)", () => {
		const diff = walkTreeDiff({ ai: undefined }, { ai: { preset: "inherit", temperature: 0.7 } });
		expect(diff).toEqual([
			{ code: "ai", oldValue: undefined, newValue: { preset: "inherit", temperature: 0.7 } },
		]);
	});

	it("仅 right 多字段 → diff 标 oldValue=undefined", () => {
		const diff = walkTreeDiff({ a: 1 }, { a: 1, b: 2 });
		expect(diff).toEqual([{ code: "b", oldValue: undefined, newValue: 2 }]);
	});

	it("仅 left 多字段 → diff 标 newValue=undefined", () => {
		const diff = walkTreeDiff({ a: 1, b: 2 }, { a: 1 });
		expect(diff).toEqual([{ code: "b", oldValue: 2, newValue: undefined }]);
	});

	it("多字段并行 diff:全列出", () => {
		const diff = walkTreeDiff({ a: 1, b: "x", c: { d: false } }, { a: 2, b: "x", c: { d: true } });
		expect(diff).toEqual(
			expect.arrayContaining([
				{ code: "a", oldValue: 1, newValue: 2 },
				{ code: "c.d", oldValue: false, newValue: true },
			]),
		);
		expect(diff).toHaveLength(2);
	});

	it("NaN 自等 → 无 diff(Object.is 语义)", () => {
		expect(walkTreeDiff({ x: Number.NaN }, { x: Number.NaN })).toEqual([]);
	});
});
