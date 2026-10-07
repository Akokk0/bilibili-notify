/**
 * 文案占位符改写(㉓d):把盘上文案里旧的变量名改成新的 —— `{uname}` → `{viewer}` 这样的花括号写法,以及 koishi 时代的
 * `-uname` 老写法,一并改写成花括号写法。这是个共用的纯函数(吃模板与一张「旧键 → 新键」的表),㉓d 只对上舰文案用,
 * 3b 迁其余 6 条直播文案时直接调它。
 *
 * 匹配规矩必须和运行时(`apps/server/src/bilibili/live/template-renderer.ts` 的 `applyTemplate`)认旧写法的规矩一致 —— 改写前后
 * 推出去的字才一样:同一组键、两种写法、**不看词边界**(`abc-uname` 里的 `-uname` 照样算)、**最长的键先匹配**、
 * 单遍替换(换进去的字不再被扫一遍)。期望值都是手写的字面量。`\n` 的展开是运行时的事,迁移不碰。
 */

import { describe, expect, it } from "vite-plus/test";
import { rewritePlaceholders } from "../placeholders.js";

/** 上舰文案那张表(0.x 的三个变量 → 1.0 的三个)。 */
const GUARD = { uname: "viewer", mname: "name", guard: "tier" } as const;

describe("rewritePlaceholders —— 花括号写法", () => {
	it("{uname} / {mname} / {guard} 改成 {viewer} / {name} / {tier}", () => {
		expect(rewritePlaceholders("{uname} 成为了 {mname} 的{guard}！", GUARD)).toBe(
			"{viewer} 成为了 {name} 的{tier}！",
		);
	});

	it("同一个变量出现几次就改几次", () => {
		expect(rewritePlaceholders("{uname}{uname}-{uname}", GUARD)).toBe("{viewer}{viewer}-{viewer}");
	});
});

describe("rewritePlaceholders —— koishi 时代的 -key 老写法", () => {
	it("-uname / -mname / -guard 一并改成花括号写法", () => {
		expect(rewritePlaceholders("-uname 成为了 -mname 的-guard！", GUARD)).toBe(
			"{viewer} 成为了 {name} 的{tier}！",
		);
	});

	it("两种写法混着用", () => {
		expect(rewritePlaceholders("-uname 成为了 {mname} 的-guard！", GUARD)).toBe(
			"{viewer} 成为了 {name} 的{tier}！",
		);
	});

	it("不看词边界:和运行时一样,`abc-uname` 里的 `-uname`、`-unamex` 里的前五个字母都算", () => {
		expect(rewritePlaceholders("abc-uname", GUARD)).toBe("abc{viewer}");
		expect(rewritePlaceholders("-unamex", GUARD)).toBe("{viewer}x");
		expect(rewritePlaceholders("a-b-c-guard", GUARD)).toBe("a-b-c{tier}");
	});

	it("只有一个 `-` 或键写不全的不算", () => {
		expect(rewritePlaceholders("-unam {mnam} uname guard", GUARD)).toBe("-unam {mnam} uname guard");
	});
});

describe("rewritePlaceholders —— 最长的键先匹配、单遍替换", () => {
	// 一个键是另一个键的前缀:`-follower` 不能吞掉 `-follower_change` 的前缀。
	const LONG = { follower: "followers", follower_change: "followersChange" } as const;

	it("`-follower_change` 整个算一个键,不被 `-follower` 吃掉前半", () => {
		expect(
			rewritePlaceholders("-follower|-follower_change|{follower}|{follower_change}", LONG),
		).toBe("{followers}|{followersChange}|{followers}|{followersChange}");
	});

	it("表里的键与别的键互相是对方的新名字:换进去的字不再被扫一遍", () => {
		const SWAP = { a: "b", b: "a" } as const;
		expect(rewritePlaceholders("{a}{b}-a-b", SWAP)).toBe("{b}{a}{b}{a}");
	});
});

describe("rewritePlaceholders —— 不碰的东西", () => {
	it("表里没有的变量、别的文字原样", () => {
		expect(rewritePlaceholders("{name} {foo} -bar {uname}", { uname: "viewer" })).toBe(
			"{name} {foo} -bar {viewer}",
		);
	});

	it("字面的 \\n(反斜杠加 n)原样留着:展开成换行是运行时的事", () => {
		expect(rewritePlaceholders("{uname}\\n{guard}", GUARD)).toBe("{viewer}\\n{tier}");
	});

	it("表是空的 / 模板是空串:原样", () => {
		expect(rewritePlaceholders("{uname}", {})).toBe("{uname}");
		expect(rewritePlaceholders("", GUARD)).toBe("");
	});

	it("键里有正则元字符也只按字面匹配", () => {
		expect(rewritePlaceholders("{a.b} -a.b axb", { "a.b": "c" })).toBe("{c} {c} axb");
	});

	it("幂等:改写过的文案再改写一遍不变", () => {
		const once = rewritePlaceholders("-uname 成为了 {mname} 的-guard！", GUARD);
		expect(rewritePlaceholders(once, GUARD)).toBe(once);
	});
});
