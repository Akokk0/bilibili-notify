/**
 * 单元测试 — PATCH 线格式构造。
 *
 * 这里守的是本仓库反复复发的那个坑:「关掉一个覆盖」必须在线格式上表达成显式
 * `null`,否则服务端 deepMerge 当「没提 = 不改」,旧值原样留着 —— 用户看到的是
 * 「关不掉」。配套的服务端语义在 apps/server 的 patch-delete.test.ts。
 */

import { describe, expect, it } from "vite-plus/test";
import { buildPatch, withoutMaskedCells } from "../patch";

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

	/**
	 * 密钥格下发时是 `{ masked }`(只读的遮挡,写回一律 400):草稿与基线里同一格都还是它 =
	 * 没动过,不进 PATCH。`buildPatch` 刻意不做「相同就省略」,这是唯一的例外。
	 */
	describe("没动过的密钥格(`{ masked }`)不进 PATCH", () => {
		const M = { masked: "••••••••" };

		it("两边都是遮挡 → 这一格不出现,别的格照常", () => {
			expect(buildPatch({ apiKey: M, model: "b" }, { apiKey: M, model: "a" })).toEqual({
				model: "b",
			});
		});

		it("嵌套在更深处 / record 里也一样", () => {
			const base = { providers: { ds: { apiKey: M, label: "x" } } };
			const draft = { providers: { ds: { apiKey: { masked: "••••••••" }, label: "y" } } };
			expect(buildPatch(draft, base)).toEqual({ providers: { ds: { label: "y" } } });
		});

		it("换成新明文 → 照常下发;清成空串 → 照常下发", () => {
			expect(buildPatch({ k: "new" } as { k: unknown }, { k: M })).toEqual({ k: "new" });
			expect(buildPatch({ k: "" } as { k: unknown }, { k: M })).toEqual({ k: "" });
		});

		it("草稿里把整格删了 → 照常发 null(清掉)", () => {
			expect(buildPatch({} as { k?: unknown }, { k: M })).toEqual({ k: null });
		});

		it("只有一个 masked 字符串键才算遮挡:带别的键的普通对象照常 diff", () => {
			expect(buildPatch({ a: { masked: "x", n: 1 } }, { a: { masked: "x", n: 1 } })).toEqual({
				a: { masked: "x", n: 1 },
			});
			expect(buildPatch({ a: { masked: 1 } }, { a: { masked: 1 } })).toEqual({ a: { masked: 1 } });
		});
	});

	describe("withoutMaskedCells — 整份草稿送出去前拿掉没动的密钥格", () => {
		const M = { masked: "••••••••" };

		it("遮挡整格拿掉(嵌套、数组里都算),新明文与空串留着", () => {
			const draft = {
				a: M,
				b: "new",
				c: "",
				d: { e: M, f: 1 },
				g: [{ h: M, i: "x" }],
			};
			expect(withoutMaskedCells(draft)).toEqual({ b: "new", c: "", d: { f: 1 }, g: [{ i: "x" }] });
		});

		it("不改传进来的那份;没有遮挡的原样", () => {
			const draft = { a: M };
			withoutMaskedCells(draft);
			expect(draft).toEqual({ a: M });
			expect(withoutMaskedCells({ x: 1, y: [1, 2] })).toEqual({ x: 1, y: [1, 2] });
		});
	});
});
