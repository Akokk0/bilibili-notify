import { describe, expect, it } from "vite-plus/test";
import { keepKnownTagIds, planNewTag, resolveTagNames, toggleTagId } from "../tag-edit";

/**
 * 「编辑标签」弹框语义(ADR-0034):编辑订阅挂的标签 id(勾=加、取消=移)+ 就地新建。
 * 这里穷举纯逻辑边界。
 */
const GAME = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const CHAT = { id: "22222222-2222-4222-8222-222222222222", name: "杂谈" };
const NEW_ID = "33333333-3333-4333-8333-333333333333";

describe("toggleTagId", () => {
	it("勾选一个未挂的标签 → 追加到末尾", () => {
		expect(toggleTagId(["a"], "b")).toEqual(["a", "b"]);
	});

	it("取消一个已挂的标签 → 移除", () => {
		expect(toggleTagId(["a", "b"], "a")).toEqual(["b"]);
	});
});

describe("planNewTag", () => {
	it("新名字 → 建:新标签带上调用方给的 id、名字去了首尾空白,整张新表是旧表末尾追加", () => {
		expect(planNewTag([GAME, CHAT], "  重点 ", NEW_ID)).toEqual({
			kind: "create",
			tag: { id: NEW_ID, name: "重点" },
			table: [GAME, CHAT, { id: NEW_ID, name: "重点" }],
		});
	});

	it("空表上也能建", () => {
		expect(planNewTag([], "重点", NEW_ID)).toEqual({
			kind: "create",
			tag: { id: NEW_ID, name: "重点" },
			table: [{ id: NEW_ID, name: "重点" }],
		});
	});

	it("空白名不建", () => {
		expect(planNewTag([GAME], "   ", NEW_ID)).toEqual({ kind: "empty" });
		expect(planNewTag([GAME], "", NEW_ID)).toEqual({ kind: "empty" });
	});

	it("去空白后与已有的重名 → 不建,指向那一个(弹框把它勾上)", () => {
		expect(planNewTag([GAME, CHAT], " 杂谈 ", NEW_ID)).toEqual({
			kind: "existing",
			id: CHAT.id,
		});
	});

	it("重名按逐字相等算(与服务端同一把尺):大小写不同算两个", () => {
		const a = { id: "44444444-4444-4444-8444-444444444444", name: "Music" };
		expect(planNewTag([a], "music", NEW_ID)).toMatchObject({ kind: "create" });
	});
});

describe("keepKnownTagIds", () => {
	it("只留标签表里还有的 id,保序", () => {
		expect(keepKnownTagIds([CHAT.id, "gone", GAME.id], [GAME, CHAT])).toEqual([CHAT.id, GAME.id]);
	});
});

describe("resolveTagNames", () => {
	it("按订阅上 id 的顺序查名字,不按表的顺序", () => {
		expect(resolveTagNames([CHAT.id, GAME.id], [GAME, CHAT])).toEqual(["杂谈", "游戏"]);
	});

	it("表里没有的 id 静默跳过", () => {
		expect(resolveTagNames(["gone", GAME.id], [GAME])).toEqual(["游戏"]);
		expect(resolveTagNames([GAME.id], [])).toEqual([]);
	});
});
