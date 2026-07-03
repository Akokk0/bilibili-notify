import { describe, expect, it } from "vite-plus/test";
import type { MessageBlockFull } from "../../types/domain";
import {
	decodeSeparator,
	describeGroups,
	encodeSeparator,
	groupsWithCardNotFirst,
	insertSplit,
	moveBlock,
	removeBlock,
} from "./message-layout-utils";

const b = (type: string, visible = true, id = type): MessageBlockFull => ({ id, type, visible });

describe("moveBlock", () => {
	it("from → to 拖拽落点移动;越界 / 同位不动", () => {
		const blocks = [b("card"), b("text"), b("link")];
		expect(moveBlock(blocks, 0, 2).map((x) => x.type)).toEqual(["text", "link", "card"]);
		expect(moveBlock(blocks, 2, 0).map((x) => x.type)).toEqual(["link", "card", "text"]);
		expect(moveBlock(blocks, 1, 1).map((x) => x.type)).toEqual(["card", "text", "link"]);
		expect(moveBlock(blocks, 0, 3).map((x) => x.type)).toEqual(["card", "text", "link"]);
	});
});

describe("insertSplit / removeBlock", () => {
	it("插入分条符生成唯一 id;可按 id 删除", () => {
		let blocks = [b("card"), b("text")];
		blocks = insertSplit(blocks);
		blocks = insertSplit(blocks);
		const splits = blocks.filter((x) => x.type === "split");
		expect(splits).toHaveLength(2);
		expect(new Set(splits.map((x) => x.id)).size).toBe(2);
		const removed = removeBlock(blocks, splits[0]?.id ?? "");
		expect(removed.filter((x) => x.type === "split")).toHaveLength(1);
	});
});

describe("describeGroups", () => {
	it("按分条符与显隐折算「每条消息装什么」的预览文案", () => {
		const blocks = [
			b("card"),
			{ id: "split-1", type: "split", visible: true },
			b("text"),
			b("link", false),
		];
		expect(describeGroups(blocks)).toEqual(["卡片图", "文本"]);
	});

	it("全部隐藏 → 空数组(调用方渲染「不发送」提示)", () => {
		expect(describeGroups([b("card", false), b("text", false)])).toEqual([]);
	});
});

describe("groupsWithCardNotFirst(QQ 图文合并提示)", () => {
	it("卡片图是某条消息里第一个可见部件 → 该条不受影响", () => {
		const blocks = [b("card"), b("text"), b("link")];
		expect(groupsWithCardNotFirst(blocks)).toEqual([]);
	});

	it("卡片图不在最前(前面有可见文本/链接)→ 命中该条的序号(1-based,对齐 describeGroups)", () => {
		const blocks = [b("text"), b("card"), b("link")];
		expect(groupsWithCardNotFirst(blocks)).toEqual([1]);
	});

	it("分条符切多条消息 → 按各自的组分别判定,只报出问题的那几条", () => {
		const blocks = [
			b("card"),
			{ id: "split-1", type: "split", visible: true },
			b("text"),
			b("card", true, "card2"), // 同 type 在第二组仍视为 card,但重复实例不影响判定逻辑本身
		];
		// 第一条:[card] 卡片在最前,OK;第二条:[text, card] 卡片不在最前,命中
		expect(groupsWithCardNotFirst(blocks)).toEqual([2]);
	});

	it("该条没有卡片图 → 不命中", () => {
		expect(groupsWithCardNotFirst([b("text"), b("link")])).toEqual([]);
	});

	it("卡片图前面的部件被隐藏 → 卡片图实际上是该条第一个可见部件,不命中", () => {
		const blocks = [b("text", false), b("card"), b("link")];
		expect(groupsWithCardNotFirst(blocks)).toEqual([]);
	});
});

describe("separator 编解码(单行输入框里编辑换行)", () => {
	it("encode 把换行显示为 \\n;decode 还原", () => {
		expect(encodeSeparator("\n")).toBe("\\n");
		expect(decodeSeparator("\\n")).toBe("\n");
		expect(decodeSeparator(encodeSeparator(" | "))).toBe(" | ");
	});
});
