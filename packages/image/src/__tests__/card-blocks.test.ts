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
import { describe, expect, it } from "vite-plus/test";
import { DYNAMIC_BLOCKS } from "../blocks/dynamic";
import { GUARD_BLOCKS } from "../blocks/guard";
import { LIVE_BLOCKS } from "../blocks/live";
import { ROAST_BOARD_BLOCKS, ROAST_SOLO_BLOCKS } from "../blocks/roast";
import { SC_BLOCKS } from "../blocks/sc";
import type { BlockRenderer } from "../blocks/types";
import { WORDCLOUD_BLOCKS } from "../blocks/wordcloud";

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

// ── 五、非原子块的**完整名单** ────────────────────────────────────────────────

/**
 * 目录里还剩哪些块不是原子块 —— 一份**闭集**,多一个少一个都红(ADR-0014 决策 8 的
 * 2026-09-18 🔗)。「复合块整批退役」不是一次性的清理,是从今往后的规矩:新加的块默认
 * 就该是原子的,要开例外得先改这份名单,顺带解释为什么它拆不动。
 *
 * ⚠️ 光靠 `atom` 的键数对不出问题:漏标一个块,编辑器只是把它归进「复合块」那一组,
 * 出图一个像素都不差 —— 门禁全绿,只有主人打开编辑器才看得见。
 */
const NON_ATOM: Record<string, readonly string[]> = {
	live: [],
	// 预约 / 商品 / 通用 / 关联视频四种形态结构各异,字段也不在契约里 —— 主人拍板不拆。
	dynamic: ["additional"],
	sc: [],
	guard: [],
	// 三种不可编辑卡:一块就是一整张卡。
	roastBoard: ["body"],
	roastSolo: ["body"],
	wordcloud: ["body"],
};

describe("块目录 — 非原子块只剩这些", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:${NON_ATOM[kind].length === 0 ? "全是原子块" : NON_ATOM[kind].join(" / ")}`, () => {
			const left = Object.entries(CARD_SKIN_BUILTIN_BLOCKS[kind])
				.filter(([, meta]) => meta.atom !== true)
				.map(([name]) => name);
			expect(left.sort()).toEqual([...NON_ATOM[kind]].sort());
		});
	}
});
