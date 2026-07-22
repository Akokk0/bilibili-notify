/**
 * 单元测试 — PATCH 线格式构造。
 *
 * 这里守的是本仓库反复复发的那个坑:「关掉一个覆盖」必须在线格式上表达成显式
 * `null`,否则服务端 deepMerge 当「没提 = 不改」,旧值原样留着 —— 用户看到的是
 * 「关不掉」。配套的服务端语义在 apps/server 的 patch-delete.test.ts。
 */

import { describe, expect, it } from "vite-plus/test";
import { buildPatch } from "./patch";

describe("buildPatch", () => {
	it("草稿里消失的键 → 显式 null(删除哨兵)", () => {
		expect(buildPatch({ a: undefined }, { a: 1 })).toEqual({ a: null });
	});

	it("两边都没有的键 → 压根不下发(别凭空造出一个 null)", () => {
		expect(buildPatch({ a: undefined }, { a: undefined })).toEqual({});
	});

	it("任意深度都能单独删,不必整片清掉", () => {
		const patch = buildPatch(
			{ defaults: { byKind: { live: undefined, sc: { color: "#sc" } } } },
			{ defaults: { byKind: { live: { color: "#live" }, sc: { color: "#sc" } } } },
		);
		expect(patch).toEqual({ defaults: { byKind: { live: null, sc: { color: "#sc" } } } });
	});

	it("新增的键原样下发", () => {
		expect(buildPatch({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1, b: 2 });
	});

	it("数组整体当叶子,不做逐元素 diff", () => {
		expect(buildPatch({ xs: [1, 2] }, { xs: [1, 2, 3] })).toEqual({ xs: [1, 2] });
		expect(buildPatch({ xs: [] }, { xs: [1] })).toEqual({ xs: [] });
	});

	it("清空成空数组是「设值」,不是删除 —— 别错发 null", () => {
		expect(buildPatch({ xs: [] }, { xs: [1, 2] })).toEqual({ xs: [] });
	});

	it("空字符串 / false / 0 都是正经值,不能当成删除", () => {
		expect(buildPatch({ s: "", b: false, n: 0 }, { s: "x", b: true, n: 9 })).toEqual({
			s: "",
			b: false,
			n: 0,
		});
	});

	it("基线里没有的整个子树,草稿给了就整块下发", () => {
		expect(buildPatch({ a: { b: 1 } }, {} as { a?: { b: number } })).toEqual({ a: { b: 1 } });
	});

	it("草稿删掉整个子树 → 该子树一个 null,而不是逐字段 null", () => {
		expect(buildPatch({ a: undefined }, { a: { b: 1, c: 2 } })).toEqual({ a: null });
	});

	it("不改动入参", () => {
		const draft = { a: { b: 1 } };
		const baseline = { a: { b: 2 }, c: 3 } as { a: { b: number }; c?: number };
		buildPatch(draft, baseline);
		expect(draft).toEqual({ a: { b: 1 } });
		expect(baseline).toEqual({ a: { b: 2 }, c: 3 });
	});
});
