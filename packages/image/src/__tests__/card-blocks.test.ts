/**
 * **块库与内置块目录对表**(ADR-0014 决策 8)。
 *
 * 钉一件事:`src/blocks/*` 里每种卡的块表,键名与 `CARD_SKIN_BUILTIN_BLOCKS` 一个不多
 * 一个不少 —— 目录里有而块表里没有的块,皮肤摆上去会被当「没数据」**静默收起**;反过来
 * 多出来的块,编辑器里根本点不到。两头都不报错,所以要对表。
 *
 * 这份原来还有一大半:「原子块逐字出现在它被抠出来的那个复合块里」,以及「单独摆时自带
 * 复合块根上的观感」。那是拆原子块那一轮的验收方式 —— 复合块整批退役之后
 * (决策 8 的 2026-09-18 🔗),原子块就是唯一的真相,没有第二份可比;观感有没有掉由
 * `card-baseline.test.ts` 的字节基准守着(出厂默认皮肤全是原子块,掉一句字节就变)。
 */

import { CARD_SKIN_BUILTIN_BLOCKS, CARD_SKIN_KINDS } from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, h, type VNode } from "vue";
import { DYNAMIC_BLOCKS, type DynamicBlockProps } from "../blocks/dynamic";
import { GUARD_BLOCKS } from "../blocks/guard";
import { LIVE_BLOCKS } from "../blocks/live";
import { ROAST_BOARD_BLOCKS, ROAST_SOLO_BLOCKS } from "../blocks/roast";
import { SC_BLOCKS } from "../blocks/sc";
import type { BlockRenderer } from "../blocks/types";
import { WORDCLOUD_BLOCKS } from "../blocks/wordcloud";
import type { GuardCardProps } from "../templates/guard-card";
import type { LiveCardProps } from "../templates/live-card";
import type { SCCardProps } from "../templates/sc-card";
import { blockPropsOf, CARD_FIXTURES } from "./fixtures/card-fixtures";

// ── 夹具 ──────────────────────────────────────────────────────────────────────

const _LIVE_PROPS: LiveCardProps = {
	cardColorStart: "#e0c3fc",
	cardColorEnd: "#8ec5fc",
	data: {
		title: "周年庆典特别直播",
		area_name: "虚拟主播",
		user_cover: "http://i0.hdslb.com/bfs/live/cover0001.jpg",
		keyframe: "http://i0.hdslb.com/bfs/live-key-frame/kf0001.jpg",
		description: "<p>每晚八点开播</p>",
	},
	username: "示例主播",
	userface: "http://i0.hdslb.com/bfs/face/face0001.jpg",
	titleStatus: "直播中",
	liveTime: "已开播 1 小时",
	liveStatus: 1,
	cover: true,
	onlineNum: "1.2 万",
	likedNum: "3456",
	watchedNum: "2.3 万",
	fansNum: "12.3 万",
	fansChanged: "+128",
};

const _DYNAMIC_PROPS: DynamicBlockProps = {
	node: {
		avatarUrl: "http://i0.hdslb.com/bfs/face/face0002.jpg",
		upName: "示例 UP 主",
		upIsVip: true,
		pubTime: "3 分钟前",
		headerLabel: "投稿了视频",
		body: h("div", null, "正文"),
	},
	// 这份 node 没有 forward,转发框那条路走不到 —— 真走到了说明夹具变了,当场炸出来。
	renderForward: () => {
		throw new Error("这份夹具的动态不是转发");
	},
};

const _SC_PROPS: SCCardProps = {
	senderFace: "http://i0.hdslb.com/bfs/face/face0003.jpg",
	senderName: "热心观众",
	masterName: "示例主播",
	masterAvatarUrl: "http://i0.hdslb.com/bfs/face/face0001.jpg",
	text: "主播加油！",
	price: 30,
	duration: "2 分钟",
	bgColor: ["#E2B52B", "#F5E7B3"],
};

const _GUARD_PROPS: GuardCardProps = {
	captainImgUrl: "https://s1.hdslb.com/bfs/static/captain.png",
	guardLevel: 3,
	uname: "热心观众",
	face: "http://i0.hdslb.com/bfs/face/face0003.jpg",
	isAdmin: 0,
	masterAvatarUrl: "http://i0.hdslb.com/bfs/face/face0001.jpg",
	masterName: "示例主播",
	bgColor: ["#4B79E4", "#7CA0F0"],
};

/** 把一个块渲染成 HTML 片段(不套外框、不加 wrapper),用来做逐字比对。 */
async function _renderBlock<P>(block: BlockRenderer<P> | undefined, props: P): Promise<string> {
	expect(block).toBeTypeOf("function");
	const vnode = (block as BlockRenderer<P>)(props);
	expect(vnode).not.toBeNull();
	return await renderToString(createSSRApp({ render: () => vnode as VNode }));
}

// ── 一、目录对表 ──────────────────────────────────────────────────────────────

const TABLES: Record<string, Record<string, BlockRenderer<never>>> = {
	live: LIVE_BLOCKS,
	dynamic: DYNAMIC_BLOCKS,
	sc: SC_BLOCKS,
	guard: GUARD_BLOCKS,
	roastBoard: ROAST_BOARD_BLOCKS,
	roastSolo: ROAST_SOLO_BLOCKS,
	wordcloud: WORDCLOUD_BLOCKS,
} as unknown as Record<string, Record<string, BlockRenderer<never>>>;

describe("块库 — 键名与内置块目录对表", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:块表键名 = CARD_SKIN_BUILTIN_BLOCKS.${kind} 的键集`, () => {
			expect(Object.keys(TABLES[kind]).sort()).toEqual(
				Object.keys(CARD_SKIN_BUILTIN_BLOCKS[kind]).sort(),
			);
		});
	}
});

// ── 四、2026-09-18 补的那批原子块(ADR-0014 决策 8 的 🔗) ─────────────────────

/** 块名是对外 API(主人定的),一个字不许改;label 是编辑器里那颗按钮上的字。 */
const SPLIT_ATOMS: Record<string, Record<string, string>> = {
	dynamic: {
		topic: "话题",
		text: "正文文字",
		media: "视频卡 / 图廊",
		forward: "转发框",
		forwardCount: "转发数",
		commentCount: "评论数",
		likeCount: "点赞数",
	},
	sc: { price: "金额", duration: "时长胶囊", to: "「SC to」那一行" },
	guard: { user: "用户名胶囊", master: "主播胶囊" },
};

describe("块库 — 2026-09-18 补的原子块在目录里", () => {
	for (const [kind, atoms] of Object.entries(SPLIT_ATOMS)) {
		for (const [name, label] of Object.entries(atoms)) {
			it(`${kind}.${name}:原子块,叫「${label}」`, () => {
				const entry = (CARD_SKIN_BUILTIN_BLOCKS as Record<string, Record<string, unknown>>)[kind][
					name
				];
				expect(entry).toMatchObject({ label, atom: true });
			});
		}
	}
});

/** 一份共享夹具(与基准 / 挂点对表同一份)翻成块库吃的 props。 */
async function _fixtureProps(name: string): Promise<unknown> {
	const fixture = CARD_FIXTURES.find((f) => f.name === name);
	if (!fixture) throw new Error(`夹具表里没有 ${name}`);
	return blockPropsOf(fixture.kind, await fixture.build());
}

/** 一段 HTML 的根标签(第一个 `<…>`)。 */
function rootTag(html: string): string {
	const m = /^<[^>]*>/.exec(html);
	if (!m) throw new Error(`不是以标签开头的 HTML:${html.slice(0, 80)}`);
	return m[0];
}

/** 根标签上的 `data-bn`(没有就 null)。 */
function _rootHook(html: string): string | null {
	return / data-bn="([^"]*)"/.exec(rootTag(html))?.[1] ?? null;
}
