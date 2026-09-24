import { describe, expect, it } from "vite-plus/test";
import {
	assembleMessageGroups,
	DEFAULT_MESSAGE_LAYOUT,
	defaultMessageKindLayout,
	MESSAGE_SPLIT_TYPE,
	type MessageBlock,
	type MessageKindLayout,
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
	it("返回默认版式的深拷贝", () => {
		const copy = defaultMessageKindLayout("live");
		expect(copy).toEqual(DEFAULT_MESSAGE_LAYOUT.live);
		// 深拷贝:改返回值不得污染 DEFAULT_MESSAGE_LAYOUT
		for (const b of copy.blocks) b.visible = false;
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

describe("assembleMessageGroups", () => {
	const b = (type: string, visible = true, id = type): MessageBlock => ({ id, type, visible });
	const split = (visible = true, id = "split-1"): MessageBlock => ({
		id,
		type: MESSAGE_SPLIT_TYPE,
		visible,
	});
	const layout = (blocks: MessageBlock[], separator = "\n"): MessageKindLayout => ({
		blocks,
		separator,
	});
	const card = Buffer.from("card");
	const ALL = { card, text: "文案", link: "https://example.com/1" };
	const img = { type: "image", buffer: card, mime: "image/jpeg" } as const;

	it("默认版式 → 一条:卡片成段,文字与链接以连接符连成一段", () => {
		expect(assembleMessageGroups(DEFAULT_MESSAGE_LAYOUT.dynamic, ALL)).toEqual([
			[img, { type: "text", text: "文案\nhttps://example.com/1" }],
		]);
	});

	it("卡片段原样带出那份 buffer(不拷贝),mime 恒为 image/jpeg", () => {
		const seg = assembleMessageGroups(layout([b("card")]), { card })[0]?.[0];
		expect(seg?.type === "image" && seg.buffer).toBe(card);
		expect(seg?.type === "image" && seg.mime).toBe("image/jpeg");
	});

	it("相邻文字按版式的连接符连", () => {
		expect(assembleMessageGroups(layout([b("link"), b("text")], " | "), ALL)).toEqual([
			[{ type: "text", text: "https://example.com/1 | 文案" }],
		]);
	});

	it("卡片夹在文字中间 → 前后两段文字各自成段,不跨卡片连接", () => {
		expect(assembleMessageGroups(layout([b("text"), b("card"), b("link")]), ALL)).toEqual([
			[{ type: "text", text: "文案" }, img, { type: "text", text: "https://example.com/1" }],
		]);
	});

	it("分条符切组;隐藏的分条符视同不存在", () => {
		expect(assembleMessageGroups(layout([b("card"), split(), b("text"), b("link")]), ALL)).toEqual([
			[img],
			[{ type: "text", text: "文案\nhttps://example.com/1" }],
		]);
		expect(assembleMessageGroups(layout([b("card"), split(false), b("text")]), ALL)).toEqual([
			[img, { type: "text", text: "文案" }],
		]);
	});

	it("隐藏的块不进消息,哪怕调用方给了它的值", () => {
		expect(
			assembleMessageGroups(layout([b("card", false), b("text"), b("link", false)]), ALL),
		).toEqual([[{ type: "text", text: "文案" }]]);
	});

	it("缺某个部件(没给 / 空串)→ 从消息里剔掉;剔空的那条整条丢弃", () => {
		expect(
			assembleMessageGroups(layout([b("card"), split(), b("text"), b("link")]), {
				text: "",
				link: "https://example.com/1",
			}),
		).toEqual([[{ type: "text", text: "https://example.com/1" }]]);
	});

	it("什么都没有 / 全部隐藏 → [](本次无可发内容)", () => {
		expect(assembleMessageGroups(DEFAULT_MESSAGE_LAYOUT.live, {})).toEqual([]);
		expect(
			assembleMessageGroups(layout([b("card", false), b("text", false), b("link", false)]), ALL),
		).toEqual([]);
	});
});
