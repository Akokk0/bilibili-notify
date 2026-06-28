/**
 * 单元测试 — 背景图轮换游标(每次推送顺序轮换 + 可持久化续接)。
 *
 * 纯逻辑:cursors 由闭包持有,snapshot 暴露给上层做 fs 持久化;空/单图不轮换,
 * 多图顺序回环,不同 scope 游标独立,重启从持久化游标续接,列表变短取模安全。
 */

import { describe, expect, it } from "vite-plus/test";
import { createCardBgRotator } from "../card-bg-rotation";

describe("createCardBgRotator", () => {
	it("多图 → 每次 pick 顺序轮换,到尾回环", () => {
		const r = createCardBgRotator();
		const imgs = ["a", "b", "c"];
		expect([r.pick("k", imgs), r.pick("k", imgs), r.pick("k", imgs), r.pick("k", imgs)]).toEqual([
			"a",
			"b",
			"c",
			"a",
		]);
	});

	it("单图 → 恒返回该图,不推进游标", () => {
		const r = createCardBgRotator();
		expect(r.pick("k", ["only"])).toBe("only");
		expect(r.pick("k", ["only"])).toBe("only");
		expect(r.snapshot().k).toBeUndefined();
	});

	it("空列表 → undefined", () => {
		const r = createCardBgRotator();
		expect(r.pick("k", [])).toBeUndefined();
	});

	it("不同 scope 游标独立", () => {
		const r = createCardBgRotator();
		const imgs = ["a", "b"];
		expect(r.pick("x", imgs)).toBe("a");
		expect(r.pick("y", imgs)).toBe("a");
		expect(r.pick("x", imgs)).toBe("b");
	});

	it("从持久化游标续接(重启不归零)", () => {
		const r = createCardBgRotator({ k: 1 });
		expect(r.pick("k", ["a", "b", "c"])).toBe("b");
	});

	it("snapshot 反映推进,可交给持久化", () => {
		const r = createCardBgRotator();
		r.pick("k", ["a", "b", "c"]);
		expect(r.snapshot()).toEqual({ k: 1 });
	});

	it("列表变短时旧游标取模安全(不越界)", () => {
		const r = createCardBgRotator({ k: 5 });
		expect(r.pick("k", ["a", "b"])).toBe("b");
	});

	it("dirty 标记:pick 多图后为脏,clearDirty 后复位;单图/空不弄脏", () => {
		const r = createCardBgRotator();
		expect(r.isDirty()).toBe(false);
		r.pick("k", ["only"]);
		expect(r.isDirty()).toBe(false);
		r.pick("k", ["a", "b"]);
		expect(r.isDirty()).toBe(true);
		r.clearDirty();
		expect(r.isDirty()).toBe(false);
	});
});
