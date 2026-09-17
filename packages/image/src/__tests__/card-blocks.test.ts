/**
 * 块库(`src/blocks/`)的两条契约。
 *
 * 一、**目录对表**:每种卡的块表键名必须与 `CARD_SKIN_BUILTIN_BLOCKS` 一字不差 —— 块名是
 * 对外 API(皮肤包会写死它们),多一个是「目录里没有、皮肤引用不到的死块」,少一个是
 * 「皮肤引用得到、渲染器画不出的空块」,两种都只会在装皮肤时才暴露。
 *
 * 二、**原子块确实是从复合块里抠出来的**:原子块今天没有任何模板用到(默认皮肤只排复合块),
 * 所以基准快照照不到它们 —— 这里钉的是「原子块渲染出的那段 HTML,逐字出现在对应复合块
 * 渲染出的 HTML 里」。class 或 style 一旦漂移(哪怕只在一边改),这条立刻红。
 *
 * 比之前先把复合块那边的挂点属性(`data-bn="…"`)剥掉:复合块里的部件挂着 `avatar` /
 * `name` 之类的挂点,原子块**不挂**(它自己就是那一件,挂点是 `self`,见 ADR-0014 决策 9),
 * 两边因此本就差这一个属性。原子块那边不剥,反而正面钉住「它一个内部挂点都没有」。
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
import { blockPropsOf, CARD_FIXTURES, stripCardHooks } from "./fixtures/card-fixtures";

// ── 夹具 ──────────────────────────────────────────────────────────────────────

const LIVE_PROPS: LiveCardProps = {
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

const DYNAMIC_PROPS: DynamicBlockProps = {
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

const SC_PROPS: SCCardProps = {
	senderFace: "http://i0.hdslb.com/bfs/face/face0003.jpg",
	senderName: "热心观众",
	masterName: "示例主播",
	masterAvatarUrl: "http://i0.hdslb.com/bfs/face/face0001.jpg",
	text: "主播加油！",
	price: 30,
	duration: "2 分钟",
	bgColor: ["#E2B52B", "#F5E7B3"],
};

const GUARD_PROPS: GuardCardProps = {
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
async function renderBlock<P>(block: BlockRenderer<P> | undefined, props: P): Promise<string> {
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

// ── 二、原子块是从复合块里抠出来的 ────────────────────────────────────────────

describe("块库 — 原子块与复合块同形", () => {
	/** 原子块:[卡种, 复合块, 原子块, props, 期望的元素标签]。 */
	const CASES: Array<[string, string, string, unknown, string]> = [
		["live", "header", "avatar", LIVE_PROPS, "img"],
		["live", "header", "name", LIVE_PROPS, "span"],
		["live", "header", "time", LIVE_PROPS, "span"],
		["dynamic", "header", "avatar", DYNAMIC_PROPS, "img"],
		["dynamic", "header", "name", DYNAMIC_PROPS, "span"],
		["dynamic", "header", "time", DYNAMIC_PROPS, "span"],
		["sc", "sender", "avatar", SC_PROPS, "div"],
		["sc", "sender", "name", SC_PROPS, "div"],
		["guard", "name", "avatar", GUARD_PROPS, "div"],
	];

	for (const [kind, composite, atom, props, tag] of CASES) {
		it(`${kind}.${atom}:逐字出现在 ${kind}.${composite} 里`, async () => {
			const table = TABLES[kind] as Record<string, BlockRenderer<unknown>>;
			const atomHtml = await renderBlock(table[atom], props);
			const compositeHtml = await renderBlock(table[composite], props);
			expect(atomHtml.startsWith(`<${tag} `)).toBe(true);
			// 原子块的挂点是 `self`,内部一个 data-bn 都不该有。
			expect(atomHtml).not.toContain("data-bn");
			expect(stripCardHooks(compositeHtml)).toContain(atomHtml);
		});
	}

	it("guard.avatar 带着复合块里的定宽圆框(光有 img 不算)", async () => {
		const html = await renderBlock(GUARD_BLOCKS.avatar, GUARD_PROPS);
		expect(html).toContain('class="w-[90px] h-[90px] overflow-hidden rounded-full shrink-0"');
		expect(html).toContain(`src="${GUARD_PROPS.face}"`);
	});
});

// ── 三、数据区那三件:同形,但**多带**复合块根上的观感 ──────────────────────────

/**
 * `live` 的 popularity / area / fans 与上面九条的差别:它们在复合块里靠**根**(那句
 * `px-4 flex flex-col gap-1 text-[13px]` + `--bn-ink-soft:#666`)拿到字号、颜色与左右
 * 内边距,单独摆时没有那个根,所以每件自带一份(`DATA_ATOM_CLASS` / `DATA_ATOM_STYLE`)。
 * 因此不能像上面那样直接逐字比 —— 这里分成两半钉:
 *
 * 一、**剥掉 class / style 之后**逐字出现在复合块里(标签与文案没漂);
 * 二、带上来的观感一句不少 —— 字号 / 内边距,外加颜色的**两半**:属性在 class 上
 *    (`[color:var(--bn-ink-soft)]`)、值在 inline 变量里(`--bn-ink-soft: #666;`)。
 *    两半各钉一条:少了 class 那半颜色染不动,少了 inline 那半颜色直接没了。
 *
 * 少钉哪一半都有洞:只钉一,观感掉了不会红(像素门才照得出);只钉二,文案改了不会红。
 */
describe("块库 — live 数据区的原子块(自带复合块根上的观感)", () => {
	/** 剥掉整个 class / style 属性 —— 原子块是单个元素,全局剥等于只剥它的根。 */
	const stripLook = (html: string): string => html.replace(/ (?:class|style)="[^"]*"/g, "");

	/** [原子块, 期望的元素标签]。 */
	const CASES: Array<[string, string]> = [
		["popularity", "span"],
		["area", "span"],
		["fans", "div"],
	];

	for (const [atom, tag] of CASES) {
		it(`live.${atom}:剥掉观感后逐字出现在 live.data 里`, async () => {
			const atomHtml = await renderBlock(LIVE_BLOCKS[atom], LIVE_PROPS);
			const compositeHtml = await renderBlock(LIVE_BLOCKS.data, LIVE_PROPS);
			expect(atomHtml.startsWith(`<${tag} `)).toBe(true);
			// 原子块的挂点是 `self`,内部一个 data-bn 都不该有。
			expect(atomHtml).not.toContain("data-bn");
			expect(stripCardHooks(compositeHtml)).toContain(stripLook(atomHtml));
		});

		it(`live.${atom}:把复合块根上那几句观感带在自己身上`, async () => {
			const atomHtml = await renderBlock(LIVE_BLOCKS[atom], LIVE_PROPS);
			for (const look of [
				"px-4",
				"text-[13px]",
				"[color:var(--bn-ink-soft)]",
				"--bn-ink-soft: #666;",
			]) {
				expect(atomHtml, look).toContain(look);
			}
		});
	}

	it("live.fans:该态没有粉丝文案时整块收起(与复合块同一条判据)", async () => {
		// liveStatus 2 + watchedNum 仍是占位的 "API" → followerText 给空串。
		const ended = { ...LIVE_PROPS, liveStatus: 2, watchedNum: "API" };
		expect(LIVE_BLOCKS.fans(ended)).toBeNull();
	});
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
async function fixtureProps(name: string): Promise<unknown> {
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
function rootHook(html: string): string | null {
	return / data-bn="([^"]*)"/.exec(rootTag(html))?.[1] ?? null;
}

/**
 * 这批原子块与上面第二节的差别:它们**里头带着部件挂点**(正文的 `body`、图廊的 `pics`、
 * 小头像的 `masterAvatar`…),所以比的时候两边都剥挂点。
 *
 * 根上的挂点单独钉:话题 / 转发框 / 「SC to」那一行是从复合块里抠出来的那一件,复合块里标它
 * 的名字(`topic` / `forward` / `to`)到了原子块里就是 `self`,根上不许再挂;正文文字与视频卡 /
 * 图廊的根是 builder 画的部件本身,根上本来就带着部件挂点(`body` / `video` / `pics`),照挂。
 */
describe("块库 — 2026-09-18 补的原子块与复合块同形", () => {
	/** [夹具, 卡种, 复合块, 原子块, 根上的挂点]。 */
	const CASES: Array<[string, string, string, string, string | null]> = [
		["dynamic-draw", "dynamic", "content", "topic", null],
		["dynamic-draw", "dynamic", "content", "text", "body"],
		["dynamic-av", "dynamic", "content", "text", "body"],
		["dynamic-draw", "dynamic", "content", "media", "pics"],
		["dynamic-draw-single", "dynamic", "content", "media", "pics pic"],
		["dynamic-av", "dynamic", "content", "media", "video"],
		["dynamic-forward", "dynamic", "content", "forward", null],
		["sc-low", "sc", "sender", "to", null],
	];

	for (const [fixture, kind, composite, atom, hook] of CASES) {
		it(`${kind}.${atom}(${fixture}):逐字出现在 ${kind}.${composite} 里,根上的挂点是 ${hook ?? "(无)"}`, async () => {
			const props = await fixtureProps(fixture);
			const table = TABLES[kind] as Record<string, BlockRenderer<unknown>>;
			const atomHtml = await renderBlock(table[atom], props);
			const compositeHtml = await renderBlock(table[composite], props);
			expect(rootHook(atomHtml)).toBe(hook);
			expect(stripCardHooks(compositeHtml)).toContain(stripCardHooks(atomHtml));
		});
	}
});

/**
 * 另一半:复合块把颜色(或颜色变量)写在**根**上,里头那件靠继承拿到;单独摆时没有那个根,
 * 所以原子块自己带上 —— 与 live 数据区那三件同一个道理。钉两半,少一半都有洞:
 *
 * 一、把带上来的那几句(根上加的 class token 与整条 style)去掉之后,逐字出现在复合块里;
 * 二、带上来的那几句一句不少(变量名 + 值)。金额的两个变量缺一个,渐变裁字就整个透明。
 */
describe("块库 — 2026-09-18 补的原子块:自带复合块根上的观感", () => {
	type LookCase = {
		fixture: string;
		kind: string;
		composite: string;
		atom: string;
		/** 根上多加的 class token(没有就 null)。 */
		addedClass: string | null;
		/** 根上的 style 里必须有的几句(按 props 现算)。 */
		style: (p: never) => string[];
	};
	const tier = (p: { bgColor: readonly string[] }) => [`--bn-card-tier-color:${p.bgColor[0]}`];
	const inkFaint = () => ["--bn-ink-faint: #999"];
	const CASES: LookCase[] = [
		...["forwardCount", "commentCount", "likeCount"].map((atom) => ({
			fixture: "dynamic-draw",
			kind: "dynamic",
			composite: "stats",
			atom,
			addedClass: "[color:var(--bn-ink-faint)]",
			style: inkFaint,
		})),
		{
			fixture: "sc-low",
			kind: "sc",
			composite: "amount",
			atom: "price",
			addedClass: null,
			style: (p: { bgColor: readonly string[] }) => [
				`--bn-card-tier-color:${p.bgColor[0]}`,
				`--bn-card-tier-color-end:${p.bgColor[1]}`,
			],
		},
		{
			fixture: "sc-low",
			kind: "sc",
			composite: "amount",
			atom: "duration",
			addedClass: null,
			style: tier,
		},
		{
			fixture: "guard-captain",
			kind: "guard",
			composite: "name",
			atom: "user",
			addedClass: null,
			style: tier,
		},
		{
			fixture: "guard-captain",
			kind: "guard",
			composite: "name",
			atom: "master",
			addedClass: null,
			style: tier,
		},
	];

	for (const c of CASES) {
		it(`${c.kind}.${c.atom}:去掉带上的观感后逐字出现在 ${c.kind}.${c.composite} 里`, async () => {
			const props = await fixtureProps(c.fixture);
			const table = TABLES[c.kind] as Record<string, BlockRenderer<unknown>>;
			const atomHtml = await renderBlock(table[c.atom], props);
			const compositeHtml = await renderBlock(table[c.composite], props);
			const root = rootTag(atomHtml);
			expect(rootHook(atomHtml)).toBeNull();
			let bare = root.replace(/ style="[^"]*"/, "");
			if (c.addedClass) {
				expect(bare).toContain(` ${c.addedClass}"`);
				bare = bare.replace(` ${c.addedClass}"`, '"');
			}
			const stripped = bare + atomHtml.slice(root.length);
			expect(stripCardHooks(compositeHtml)).toContain(stripCardHooks(stripped));
		});

		it(`${c.kind}.${c.atom}:根上带着复合块根上的那几句`, async () => {
			const props = await fixtureProps(c.fixture);
			const table = TABLES[c.kind] as Record<string, BlockRenderer<unknown>>;
			const root = rootTag(await renderBlock(table[c.atom], props));
			const style = / style="([^"]*)"/.exec(root)?.[1] ?? "";
			for (const decl of c.style(props as never)) expect(style, decl).toContain(decl);
			if (c.addedClass) expect(root).toContain(c.addedClass);
		});
	}
});
