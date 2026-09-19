/**
 * 内置块的**挂点对表**(ADR-0014 决策 9 与决策 24 的验收门)。
 *
 * 皮肤要能单独选中复合块内部的部件(头像 / 名字 / 封面 / 角标…),办法是给这些元素挂
 * `data-bn="<挂点>"`;挂点名的唯一事实源是 `CARD_SKIN_BUILTIN_BLOCKS[kind][block].hooks`,
 * 而它是**对外 API** —— 第三方皮肤会写死这些名字。所以两个方向都得钉住,少钉一个方向都
 * 只会在别人装皮肤时才暴露:
 *
 * 一、**块里出现的挂点都在目录里**:一个块内层出现的每个 `data-bn` token,必须是该块目录
 *     里声明过的。挂串块(把 `price` 挂进 `sender`)属于这一类 —— 皮肤按目录写 CSS,选中
 *     的却是另一个块的部件。
 * 二、**目录里的挂点都真被挂上**:每个声明过的挂点,至少要在某份夹具的输出里出现过。漏挂
 *     的挂点在编辑器里照列、皮肤照写,就是永远不生效。
 *
 * 走的是**块级**渲染:同一份夹具(`fixtures/card-fixtures.ts`,与基准快照共用)翻成块库
 * 直接吃的 props,逐块单独渲染 —— 这样「块内层」是精确的,不必去整卡 HTML 里划范围。
 *
 * `self` 是渲染器包在块外面的 wrapper,不是块的根元素;2026-09-19 起(ADR-0014 决策 7 的 🔗)
 * 原子块的**根**也挂一个按「它是什么」取名的挂点(`image` / `text` / `pill` / `bubble` / `line`),
 * 默认皮肤把这块长什么样写在它上面。根之外的部件照挂、照声明(`dynamic.text` 里的 `body`、
 * 图廊里的 `pic`、互动数里的 `icon`、主播胶囊里的小头像…)。两种都由这两个方向钉着 ——
 * 目录里声明的根挂点若没真挂上,默认皮肤写的那段外观就一条都选不中。
 */

import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_KINDS,
	type CardSkinKind,
} from "@bilibili-notify/internal";
import { renderToString } from "@vue/server-renderer";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import { createSSRApp, type VNode } from "vue";
import { DYNAMIC_BLOCKS } from "../blocks/dynamic";
import { GUARD_BLOCKS } from "../blocks/guard";
import { LIVE_BLOCKS } from "../blocks/live";
import { ROAST_BOARD_BLOCKS, ROAST_SOLO_BLOCKS } from "../blocks/roast";
import { SC_BLOCKS } from "../blocks/sc";
import type { BlockRenderer } from "../blocks/types";
import { WORDCLOUD_BLOCKS } from "../blocks/wordcloud";
import { blockPropsOf, CARD_FIXTURES } from "./fixtures/card-fixtures";

const TABLES: Record<CardSkinKind, Record<string, BlockRenderer<never>>> = {
	live: LIVE_BLOCKS,
	dynamic: DYNAMIC_BLOCKS,
	sc: SC_BLOCKS,
	guard: GUARD_BLOCKS,
	roastBoard: ROAST_BOARD_BLOCKS,
	roastSolo: ROAST_SOLO_BLOCKS,
	wordcloud: WORDCLOUD_BLOCKS,
} as unknown as Record<CardSkinKind, Record<string, BlockRenderer<never>>>;

/**
 * 「到此为止,不再往里看」的挂点。
 *
 * `dynamic.content` 的转发 inset 里装的是**一整张内部动态卡**(同一套块递归装配),里面
 * 自然会出现 header / additional / stats 的挂点 —— 那些挂点归它们各自的块管,不该算到
 * content 头上。所以数到 `forward` 就停,不进它的子树。
 */
const OPAQUE_HOOKS: ReadonlySet<string> = new Set(["forward"]);

/**
 * 「根就是转发框」的块:与上面 `forward` 挂点同一个理由,里头是一整张内部动态卡。原子块
 * `dynamic.forward` 的根**就是**那个框,它挂的是自己的根挂点 `bubble`(不是 `forward` ——
 * 那是复合块时代的内部部件名),所以按块名认:只数根上那一个挂点,不进子树。
 */
const OPAQUE_BLOCKS: ReadonlySet<string> = new Set(["dynamic.forward"]);

/**
 * 收集一段 HTML 里出现的 `data-bn` token(遇到不透明挂点就不再深入;`rootOnly` 时只看
 * 顶层元素自己)。
 */
function collectHooks(html: string, rootOnly = false): string[] {
	const found = new Set<string>();
	const walk = (el: Element): void => {
		const tokens = (el.getAttribute("data-bn") ?? "").split(/\s+/).filter(Boolean);
		for (const t of tokens) found.add(t);
		if (rootOnly || tokens.some((t) => OPAQUE_HOOKS.has(t))) return;
		for (const child of Array.from(el.children)) walk(child);
	};
	for (const child of Array.from(JSDOM.fragment(html).children)) walk(child);
	return [...found];
}

type BlockHooks = { fixture: string; block: string; hooks: string[] };

/** 把一种卡的所有夹具逐块渲染一遍,记下每块出现的挂点。 */
async function collect(kind: CardSkinKind): Promise<BlockHooks[]> {
	const out: BlockHooks[] = [];
	const table = TABLES[kind] as Record<string, BlockRenderer<unknown>>;
	for (const fixture of CARD_FIXTURES.filter((f) => f.kind === kind)) {
		const props = blockPropsOf(kind, await fixture.build());
		for (const block of Object.keys(CARD_SKIN_BUILTIN_BLOCKS[kind])) {
			const render = table[block];
			expect(render, `${kind}.${block} 没有对应的块渲染器`).toBeTypeOf("function");
			// 无数据的块返回 null(自动收起),这一份夹具就没什么可数的。
			const vnode = render(props);
			if (vnode == null) continue;
			const html = await renderToString(createSSRApp({ render: () => vnode as VNode }));
			const rootOnly = OPAQUE_BLOCKS.has(`${kind}.${block}`);
			out.push({ fixture: fixture.name, block, hooks: collectHooks(html, rootOnly) });
		}
	}
	return out;
}

const cache = new Map<CardSkinKind, Promise<BlockHooks[]>>();
function collected(kind: CardSkinKind): Promise<BlockHooks[]> {
	const hit = cache.get(kind);
	if (hit) return hit;
	const p = collect(kind);
	cache.set(kind, p);
	return p;
}

describe("内置块挂点 — 块里出现的挂点都在目录里", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:每块的 data-bn ⊆ CARD_SKIN_BUILTIN_BLOCKS.${kind}[块].hooks`, async () => {
			const catalogue = CARD_SKIN_BUILTIN_BLOCKS[kind];
			const strays = (await collected(kind)).flatMap(({ fixture, block, hooks }) =>
				hooks
					.filter((h) => !(h in catalogue[block].hooks))
					.map((h) => `${kind}.${block} 里挂了目录外的「${h}」(夹具 ${fixture})`),
			);
			expect(strays).toEqual([]);
		});
	}
});

describe("内置块挂点 — 目录里声明的挂点都真被挂上", () => {
	for (const kind of CARD_SKIN_KINDS) {
		it(`${kind}:每个声明过的挂点至少在一份夹具里出现过`, async () => {
			const catalogue = CARD_SKIN_BUILTIN_BLOCKS[kind];
			const seen = new Map<string, Set<string>>();
			for (const { block, hooks } of await collected(kind)) {
				const set = seen.get(block) ?? new Set<string>();
				for (const h of hooks) set.add(h);
				seen.set(block, set);
			}
			const missing: string[] = [];
			for (const [block, { hooks }] of Object.entries(catalogue)) {
				for (const hook of Object.keys(hooks)) {
					if (!seen.get(block)?.has(hook)) {
						// 要么真漏挂了,要么夹具没盖到这个分支 —— 两种都得处理,不能放着。
						missing.push(`${kind}.${block}.${hook} 没在任何一份夹具的输出里出现`);
					}
				}
			}
			expect(missing).toEqual([]);
		});
	}
});
