import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_MESSAGE_LAYOUT,
	defaultMessageKindLayout,
	MESSAGE_SPLIT_TYPE,
	type MessageBlock,
	MessageLayoutSchema,
	normalizeMessageLayout,
	planMessageGroups,
} from "./message-layout";

describe("DEFAULT_MESSAGE_LAYOUT", () => {
	it("dynamic/live 都是 [card,text,link] 合并一条(无分条符)、全部可见、分隔符换行", () => {
		for (const kind of ["dynamic", "live"] as const) {
			expect(DEFAULT_MESSAGE_LAYOUT[kind].blocks.map((b) => b.type)).toEqual([
				"card",
				"text",
				"link",
			]);
			expect(DEFAULT_MESSAGE_LAYOUT[kind].blocks.every((b) => b.visible)).toBe(true);
			expect(DEFAULT_MESSAGE_LAYOUT[kind].separator).toBe("\n");
		}
	});

	it("内容块 id===type", () => {
		const all = [...DEFAULT_MESSAGE_LAYOUT.dynamic.blocks, ...DEFAULT_MESSAGE_LAYOUT.live.blocks];
		expect(all.every((b) => b.id === b.type)).toBe(true);
	});

	it("被 MessageLayoutSchema 接受", () => {
		expect(() => MessageLayoutSchema.parse(DEFAULT_MESSAGE_LAYOUT)).not.toThrow();
	});
});

describe("defaultMessageKindLayout", () => {
	it("返回默认版式的深拷贝;link 可见性由 opts.link 决定(缺省 true)", () => {
		const on = defaultMessageKindLayout("dynamic");
		expect(on.blocks.map((b) => [b.type, b.visible])).toEqual([
			["card", true],
			["text", true],
			["link", true],
		]);
		const off = defaultMessageKindLayout("live", { link: false });
		expect(off.blocks.find((b) => b.type === "link")?.visible).toBe(false);
		// 深拷贝:改返回值不得污染 DEFAULT_MESSAGE_LAYOUT
		for (const b of off.blocks) b.visible = false;
		expect(DEFAULT_MESSAGE_LAYOUT.live.blocks[0]?.visible).toBe(true);
	});
});

describe("normalizeMessageLayout", () => {
	it("保留已知内容块与全部分条符的顺序/显隐,丢未知与重复,缺失的已知块追加到末尾", () => {
		const stored: MessageBlock[] = [
			{ id: "text", type: "text", visible: false },
			{ id: "split-1", type: MESSAGE_SPLIT_TYPE, visible: true },
			{ id: "ghost", type: "ghost", visible: true }, // 未知内容块 → 丢弃
			{ id: "card", type: "card", visible: true },
			{ id: "card-dup", type: "card", visible: true }, // 重复内容块 → 丢弃
		];
		const out = normalizeMessageLayout(
			{ ...DEFAULT_MESSAGE_LAYOUT, dynamic: { blocks: stored, separator: "|" } },
			DEFAULT_MESSAGE_LAYOUT,
		);
		expect(out.dynamic.blocks.map((b) => b.id)).toEqual(["text", "split-1", "card", "link"]);
		expect(out.dynamic.blocks.find((b) => b.type === "text")?.visible).toBe(false);
		expect(out.dynamic.separator).toBe("|");
	});

	it("未动的 kind 原样继承 defaults", () => {
		const out = normalizeMessageLayout(DEFAULT_MESSAGE_LAYOUT, DEFAULT_MESSAGE_LAYOUT);
		expect(out).toEqual(DEFAULT_MESSAGE_LAYOUT);
	});
});

describe("planMessageGroups", () => {
	const b = (type: string, visible = true, id = type): MessageBlock => ({ id, type, visible });
	const PRESENT = new Set(["card", "text", "link"]);

	it("无分条符 → 单组,顺序即块序", () => {
		expect(planMessageGroups([b("card"), b("text"), b("link")], PRESENT)).toEqual([
			["card", "text", "link"],
		]);
	});

	it("分条符切组:[card | text,link] → 两条消息", () => {
		const blocks = [
			b("card"),
			{ id: "split-1", type: MESSAGE_SPLIT_TYPE, visible: true },
			b("text"),
			b("link"),
		];
		expect(planMessageGroups(blocks, PRESENT)).toEqual([["card"], ["text", "link"]]);
	});

	it("隐藏块不进组;组内为空的消息被丢弃", () => {
		const blocks = [
			b("card", false),
			{ id: "split-1", type: MESSAGE_SPLIT_TYPE, visible: true },
			b("text"),
			b("link", false),
		];
		expect(planMessageGroups(blocks, PRESENT)).toEqual([["text"]]);
	});

	it("part 实际缺失(如渲染失败无 card)→ 从组里剔除;全空返回 []", () => {
		const blocks = [b("card"), b("text"), b("link")];
		expect(planMessageGroups(blocks, new Set(["text", "link"]))).toEqual([["text", "link"]]);
		expect(planMessageGroups(blocks, new Set())).toEqual([]);
	});

	it("隐藏的分条符不切组(视同不存在)", () => {
		const blocks = [
			b("card"),
			{ id: "split-1", type: MESSAGE_SPLIT_TYPE, visible: false },
			b("text"),
		];
		expect(planMessageGroups(blocks, PRESENT)).toEqual([["card", "text"]]);
	});
});
