/**
 * 卡片皮肤工坊的八把工具(ADR-0015 决策 13–23 与它们的 🔗)。
 *
 * 全程用临时目录里的**真皮肤库**:工具的全部意义就是「盘上那套皮肤变成了什么样」,
 * 拿假库测只能证明调用顺序。钉的是:
 * - 新建、写卡、改块、删块都真落盘,清洗器削掉的照说,校验不过的把原因带回给模型;
 * - 不是这场对话做的皮肤,第一次写就复制一份,原件一个字节不动;账本当场记下,
 *   之后拿原件 id 写会落到副本上(决策 18 的 🔗);
 * - 一轮最多碰两套(决策 23);
 * - 读卡只给摘要、读块才给正文(决策 14);看图三种情况都不报错(决策 19 的 🔗);
 * - 提示词从契约常量拼(决策 25)。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtraTool, ExtraToolResult } from "@bilibili-notify/ai";
import { AI_CARD_WORKSHOP_TOOLS as T } from "@bilibili-notify/contract";
import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_FIELDS,
	CARD_SKIN_FRAME_HOOKS,
	CARD_SKIN_KINDS,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
} from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	buildCardWorkshopSystem,
	type CardWorkshopDeps,
	type CardWorkshopLedger,
	createCardWorkshopTools,
} from "../chat-tools.js";
import { CARD_CSS_DENY_PROPS } from "../css-sanitizer.js";
import { CARD_HTML_ALLOWED_TAGS } from "../html-sanitizer.js";
import { CARD_SKIN_MANIFEST_FILE } from "../package.js";
import { CardSkinStore } from "../store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;
let store: CardSkinStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bn-card-workshop-"));
	store = new CardSkinStore({ dir });
	await store.init();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 一套「别人的」皮肤:不在账本里,直接装进库。 */
async function installForeign(): Promise<string> {
	const manifest = {
		schemaVersion: 1,
		dataVersion: 1,
		name: "别人做的",
		cards: {
			live: {
				width: 600,
				css: '[data-bn="glass"]{border-radius:20px}',
				assets: { bg: "asset:assets/bg.png" },
				blocks: [
					{
						id: "cover",
						kind: "builtin",
						builtin: "cover",
						grid: { row: 1, column: 1, span: 12 },
						css: '[data-bn="self"]{color:#123456}',
						assets: { pic: "asset:assets/bg.png" },
					},
					{
						id: "note",
						kind: "custom",
						html: "<p>{live.title}</p>",
						grid: { row: 2, column: 1, span: 12 },
						showIf: "live.isStreaming",
					},
				],
				// 主人在编辑器里摆过的分场版式。AI 的工具面一个字都不认它 —— 正因为不认,
				// 才更得原样留着。
				variants: { ended: { blocks: { note: { hidden: true } } } },
			},
		},
	};
	const zip = zipSync({
		[CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(manifest)),
		"assets/bg.png": PNG,
	});
	return (await store.install(zip)).id;
}

interface Harness {
	run: (name: string, args?: Record<string, unknown>) => Promise<string | ExtraToolResult>;
	text: (name: string, args?: Record<string, unknown>) => Promise<string>;
	record: ReturnType<typeof vi.fn<CardWorkshopDeps["record"]>>;
	ledger: { owned: string[]; forks: Record<string, string> };
	touched: () => ReturnType<ReturnType<typeof createCardWorkshopTools>["touched"]>;
}

/**
 * 一轮请求的工具。入参照 generator 的归一规矩:标量成字符串、对象 / 数组成 JSON。
 * 账本是**可变**的一份,record 往里记 —— 与路由「当场落盘」的形状相同。
 */
function harness(
	start: CardWorkshopLedger = { owned: [], forks: {} },
	over: Partial<CardWorkshopDeps> = {},
): Harness {
	const ledger = { owned: [...start.owned], forks: { ...start.forks } };
	const record = vi.fn<CardWorkshopDeps["record"]>(async (entry) => {
		if ("owned" in entry) ledger.owned.push(entry.owned);
		else {
			ledger.forks[entry.fork.from] = entry.fork.to;
			ledger.owned.push(entry.fork.to);
		}
	});
	const made = createCardWorkshopTools({
		store,
		ledger: start,
		record,
		activeId: () => DEFAULT_CARD_SKIN_ID,
		...over,
	});
	const byName = new Map<string, ExtraTool>(made.tools.map((t) => [t.definition.function.name, t]));
	const run = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`没有工具 ${name}`);
		const flat = Object.fromEntries(
			Object.entries(args).map(([k, v]) => [
				k,
				typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v),
			]),
		);
		return tool.execute(flat);
	};
	const text = async (name: string, args: Record<string, unknown> = {}) => {
		const out = await run(name, args);
		return typeof out === "string" ? out : out.text;
	};
	return { run, text, record, ledger, touched: made.touched };
}

/** 从结果文字里抠出「id: xxx」。 */
function idIn(text: string): string {
	const m = text.match(/id[::]\s*([a-z0-9-]+)/i);
	if (!m?.[1]) throw new Error(`结果里没有 id: ${text}`);
	return m[1];
}

const COVER = {
	id: "cover",
	kind: "builtin",
	builtin: "cover",
	grid: { row: 1, column: 1, span: 12 },
};

describe("工具面", () => {
	it("恰好八把,名字与契约一致;没有替主人换上的那一把", () => {
		const names = createCardWorkshopTools({
			store,
			ledger: { owned: [], forks: {} },
			record: async () => {},
			activeId: () => DEFAULT_CARD_SKIN_ID,
		}).tools.map((t) => t.definition.function.name);
		expect(names.sort()).toEqual(Object.values(T).sort());
		expect(names.join(" ")).not.toMatch(/activ/);
	});
});

describe("新建与写卡", () => {
	it("set_skin_meta 不带 skin → 新建一套,账本当场记下,结果带新 id", async () => {
		const h = harness();
		const out = await h.text(T.setSkinMeta, { name: "樱花粉", description: "春天" });
		const id = idIn(out);
		expect(store.get(id)?.name).toBe("樱花粉");
		expect(store.get(id)?.description).toBe("春天");
		expect(h.record).toHaveBeenCalledWith({ owned: id });
		expect(h.touched()).toEqual([{ id, kinds: [] }]);
	});

	it("新建不给名字 → 失败并说清", async () => {
		await expect(harness().run(T.setSkinMeta, {})).rejects.toThrow(/名字/);
	});

	it("write_card 写进自己做的那套:整张卡落盘,碰过的卡种记下", async () => {
		const h = harness();
		const id = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		const out = await h.text(T.writeCard, {
			skin: id,
			kind: "live",
			width: 520,
			css: '[data-bn="glass"]{border-radius:24px}',
			blocks: [COVER],
		});
		const card = store.get(id)?.cards.live;
		expect(card?.width).toBe(520);
		expect(card?.blocks.map((b) => b.id)).toEqual(["cover"]);
		expect(card?.css).toContain("border-radius");
		expect(out).toContain(id);
		expect(h.touched()).toEqual([{ id, kinds: ["live"] }]);
		// 自己的皮肤不复制。
		expect(store.list()).toHaveLength(2);
	});

	it("清洗器削掉的照说", async () => {
		const h = harness();
		const id = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		const out = await h.text(T.writeCard, {
			skin: id,
			kind: "live",
			width: 600,
			blocks: [{ ...COVER, css: '[data-bn="self"]{behavior:x;color:red}' }],
		});
		expect(out).toMatch(/behavior/);
	});

	it("只是提醒的那种(用了没声明的旋钮)不说成「削掉了」", async () => {
		const h = harness();
		const id = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		const out = await h.text(T.writeCard, {
			skin: id,
			kind: "live",
			width: 600,
			blocks: [{ ...COVER, css: '[data-bn="self"]{color:var(--bn-knob-accent, #f09)}' }],
		});
		expect(out).toMatch(/bn-knob-accent/);
		expect(out).not.toMatch(/清洗器削掉了这些/);
		expect(out).toMatch(/有的只是提醒/);
	});

	it("校验不过 → 失败,原因带回给模型,盘上不动", async () => {
		const h = harness();
		const id = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		await expect(
			h.run(T.writeCard, {
				skin: id,
				kind: "live",
				width: 600,
				blocks: [{ ...COVER, builtin: "nope" }],
			}),
		).rejects.toThrow(/nope/);
		expect(store.get(id)?.cards.live).toBeUndefined();
	});

	it("blocks 不是数组 → 失败并说清", async () => {
		const h = harness();
		const id = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		await expect(
			h.run(T.writeCard, { skin: id, kind: "live", width: 600, blocks: "cover" }),
		).rejects.toThrow(/blocks/);
	});

	it("不认识的卡种 / 皮肤 → 失败并说清", async () => {
		const h = harness();
		await expect(
			h.run(T.writeCard, { skin: "ghost", kind: "live", width: 600, blocks: [] }),
		).rejects.toThrow(/ghost/);
		const id = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		await expect(
			h.run(T.writeCard, { skin: id, kind: "poster", width: 600, blocks: [] }),
		).rejects.toThrow(/poster/);
	});
});

describe("改别人的皮肤:先复制", () => {
	it("第一次写 → 复制一份再写,原件不动,账本记下原件 → 副本", async () => {
		const foreign = await installForeign();
		const before = JSON.stringify(store.get(foreign));
		const h = harness();
		const out = await h.text(T.setBlock, {
			skin: foreign,
			kind: "live",
			block: "cover",
			css: '[data-bn="self"]{color:#abcdef}',
		});

		expect(JSON.stringify(store.get(foreign))).toBe(before);
		const copy = h.ledger.forks[foreign];
		expect(copy).toBeTruthy();
		expect(h.record).toHaveBeenCalledWith({ fork: { from: foreign, to: copy } });
		expect(out).toContain(copy as string);
		const block = store.get(copy as string)?.cards.live?.blocks.find((b) => b.id === "cover");
		expect(block?.css).toContain("#abcdef");
		// 碰过的是副本,不是原件。
		expect(h.touched()).toEqual([{ id: copy, kinds: ["live"] }]);
	});

	it("内置默认皮肤也一样:写它 = 复制一份", async () => {
		const h = harness();
		await h.text(T.setBlock, {
			skin: DEFAULT_CARD_SKIN_ID,
			kind: "live",
			block: "cover",
			css: '[data-bn="self"]{opacity:.9}',
		});
		expect(h.ledger.forks[DEFAULT_CARD_SKIN_ID]).toBeTruthy();
	});

	it("账本里已有副本 → 下一句拿原件 id 写,落到副本上,不再复制", async () => {
		const foreign = await installForeign();
		const first = harness();
		await first.text(T.removeBlock, { skin: foreign, kind: "live", block: "note" });
		const copy = first.ledger.forks[foreign] as string;
		const count = store.list().length;

		// 下一次请求:工具重新造,账本是从盘上读回来的那份。
		const next = harness(first.ledger);
		await next.text(T.setBlock, {
			skin: foreign,
			kind: "live",
			block: "cover",
			css: '[data-bn="self"]{color:#000000}',
		});
		expect(store.list()).toHaveLength(count);
		expect(next.record).not.toHaveBeenCalled();
		const blocks = store.get(copy)?.cards.live?.blocks ?? [];
		expect(blocks.map((b) => b.id)).toEqual(["cover"]);
		expect(blocks[0]?.css).toContain("#000000");
	});

	it("副本被主人删了 → 从原件重新复制一份", async () => {
		const foreign = await installForeign();
		const first = harness();
		await first.text(T.removeBlock, { skin: foreign, kind: "live", block: "note" });
		await store.remove(first.ledger.forks[foreign] as string);

		const next = harness(first.ledger);
		await next.text(T.removeBlock, { skin: foreign, kind: "live", block: "note" });
		const again = next.ledger.forks[foreign] as string;
		expect(again).not.toBe(first.ledger.forks[foreign]);
		expect(store.get(again)).not.toBeNull();
	});

	it("读也跟着改道:读原件 id 看到的是副本", async () => {
		const foreign = await installForeign();
		const first = harness();
		await first.text(T.removeBlock, { skin: foreign, kind: "live", block: "note" });
		const out = await harness(first.ledger).text(T.readCard, { skin: foreign, kind: "live" });
		expect(out).not.toMatch(/\bnote\b/);
	});
});

describe("一轮最多碰两套", () => {
	it("第三套被拒;已经碰过的那两套照写", async () => {
		const h = harness();
		const a = idIn(await h.text(T.setSkinMeta, { name: "一" }));
		const b = idIn(await h.text(T.setSkinMeta, { name: "二" }));
		await expect(h.run(T.setSkinMeta, { name: "三" })).rejects.toThrow(/两套|2 套/);
		const foreign = await installForeign();
		await expect(
			h.run(T.removeBlock, { skin: foreign, kind: "live", block: "note" }),
		).rejects.toThrow(/两套|2 套/);
		// 被拒的那次没有复制。
		expect(h.ledger.forks[foreign]).toBeUndefined();
		await h.text(T.writeCard, { skin: a, kind: "live", width: 600, blocks: [COVER] });
		await h.text(T.setSkinMeta, { skin: b, name: "二改" });
		expect(store.get(b)?.name).toBe("二改");
	});
});

describe("改块与删块", () => {
	async function ownLive(h: Harness): Promise<string> {
		const id = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		await h.text(T.writeCard, { skin: id, kind: "live", width: 600, blocks: [COVER] });
		return id;
	}

	it("set_block 能加一个新的自定义块", async () => {
		const h = harness();
		const id = await ownLive(h);
		await h.text(T.setBlock, {
			skin: id,
			kind: "live",
			block: "tag",
			html: "<span>{live.area}</span>",
			grid: { row: 2, column: 1, span: 6 },
		});
		const tag = store.get(id)?.cards.live?.blocks.find((b) => b.id === "tag");
		expect(tag).toMatchObject({ kind: "custom", grid: { row: 2, column: 1, span: 6 } });
	});

	it("set_block 改位置与 showIf;showIf 传空串就是去掉", async () => {
		const h = harness();
		const id = await ownLive(h);
		await h.text(T.setBlock, {
			skin: id,
			kind: "live",
			block: "cover",
			grid: { row: 3, column: 2, span: 10 },
			showIf: "live.hasCover",
		});
		let cover = store.get(id)?.cards.live?.blocks[0];
		expect(cover?.grid).toEqual({ row: 3, column: 2, span: 10 });
		expect(cover?.showIf).toBe("live.hasCover");
		await h.text(T.setBlock, { skin: id, kind: "live", block: "cover", showIf: "" });
		cover = store.get(id)?.cards.live?.blocks[0];
		expect(cover?.showIf).toBeUndefined();
	});

	it("块不存在、又没给够新建要的东西 → 失败并指路", async () => {
		const h = harness();
		const id = await ownLive(h);
		await expect(
			h.run(T.setBlock, { skin: id, kind: "live", block: "ghost", css: "x{}" }),
		).rejects.toThrow(/ghost/);
	});

	it("这种卡还没写 → set_block 失败并指路 write_card", async () => {
		const h = harness();
		const id = await ownLive(h);
		await expect(
			h.run(T.setBlock, { skin: id, kind: "sc", block: "amount", css: "x{}" }),
		).rejects.toThrow(/write_card/);
	});

	it("remove_block 删掉那一块", async () => {
		const h = harness();
		const id = await ownLive(h);
		await h.text(T.removeBlock, { skin: id, kind: "live", block: "cover" });
		expect(store.get(id)?.cards.live?.blocks).toEqual([]);
	});
});

describe("资产不归 AI 管,但也不许被它弄丢", () => {
	it("重写整张卡:同 id 的块与外框原有的资产变量保留,模型自己写的 assets 丢掉", async () => {
		const foreign = await installForeign();
		const h = harness();
		await h.text(T.writeCard, {
			skin: foreign,
			kind: "live",
			width: 600,
			blocks: [
				{ ...COVER, assets: { evil: "asset:assets/bg.png" } },
				{
					id: "fresh",
					kind: "custom",
					html: "<b>x</b>",
					grid: { row: 2, column: 1, span: 12 },
					assets: { evil: "asset:assets/bg.png" },
				},
			],
		});
		const card = store.get(h.ledger.forks[foreign] as string)?.cards.live;
		expect(card?.assets).toEqual({ bg: "asset:assets/bg.png" });
		expect(card?.blocks[0]?.assets).toEqual({ pic: "asset:assets/bg.png" });
		expect(card?.blocks[1]?.assets).toBeUndefined();
	});
});

/**
 * **形态覆盖也不归 AI 管**(ADR-0014 决策 10 的 2026-09-18 🔗:第一版只写基础版式)。
 * 与资产同一条道理,而且更要紧:那是主人在编辑器里一格一格摆出来的分场版式,工具面
 * 连提都没提过它 —— 重写一次卡就悄悄没了,而门禁全绿。
 */
describe("形态覆盖不归 AI 管,但也不许被它弄丢", () => {
	it("重写整张卡:还在的块,它在各形态里的覆盖原样留着", async () => {
		const foreign = await installForeign();
		const h = harness();
		await h.text(T.writeCard, {
			skin: foreign,
			kind: "live",
			width: 600,
			blocks: [
				COVER,
				{ id: "note", kind: "custom", html: "<b>x</b>", grid: { row: 2, column: 1, span: 12 } },
			],
		});
		const card = store.get(h.ledger.forks[foreign] as string)?.cards.live;
		expect(card?.variants?.ended?.blocks?.note?.hidden).toBe(true);
	});

	// 留着悬空的覆盖,整套皮肤当场存不下去(装包门退回「这张卡上没有叫「note」的块」),
	// 而那个 id 指着的东西刚被删掉。
	it("重写整张卡:没写进来的块,它的覆盖跟着收走", async () => {
		const foreign = await installForeign();
		const h = harness();
		await h.text(T.writeCard, { skin: foreign, kind: "live", width: 600, blocks: [COVER] });
		const card = store.get(h.ledger.forks[foreign] as string)?.cards.live;
		expect(card?.variants).toBeUndefined();
	});

	it("删块:它在各形态里的覆盖一起收走", async () => {
		const foreign = await installForeign();
		const h = harness();
		await h.text(T.removeBlock, { skin: foreign, kind: "live", block: "note" });
		const card = store.get(h.ledger.forks[foreign] as string)?.cards.live;
		expect(card?.blocks.some((b) => b.id === "note")).toBe(false);
		expect(card?.variants).toBeUndefined();
	});
});

describe("读", () => {
	it("list_skins:列出每套的 id 与名字,标出正在用的与这场做的", async () => {
		const foreign = await installForeign();
		const h = harness({ owned: [], forks: {} }, { activeId: () => foreign });
		const mine = idIn(await h.text(T.setSkinMeta, { name: "樱花粉" }));
		const out = await h.text(T.listSkins);
		const line = (id: string) => out.split("\n").find((l) => l.includes(id)) ?? "";
		expect(line(DEFAULT_CARD_SKIN_ID)).toMatch(/内置/);
		expect(line(foreign)).toMatch(/别人做的/);
		expect(line(foreign)).toMatch(/正在用/);
		expect(line(mine)).toMatch(/这场/);
	});

	it("read_card 只给摘要:块 id、位置、字节数与外框 CSS,不给块的 CSS / HTML 正文", async () => {
		const foreign = await installForeign();
		const out = await harness().text(T.readCard, { skin: foreign, kind: "live" });
		expect(out).toContain("cover");
		expect(out).toContain("note");
		expect(out).toContain("live.isStreaming");
		expect(out).toContain("border-radius:20px");
		expect(out).not.toContain("#123456");
		expect(out).not.toContain("{live.title}");
	});

	it("read_card 没写过的卡种 → 说明会回落默认皮肤,并给默认皮肤那张的摘要", async () => {
		const foreign = await installForeign();
		const out = await harness().text(T.readCard, { skin: foreign, kind: "sc" });
		expect(out).toMatch(/默认/);
		// 摘要里是出厂默认皮肤那张醒目留言卡的块(块怎么拆归默认皮肤,这里不抄名单)。
		const blocks = DEFAULT_CARD_SKIN.cards.sc?.blocks ?? [];
		expect(blocks.length).toBeGreaterThan(0);
		for (const b of blocks) expect(out).toContain(b.id);
	});

	/**
	 * 默认皮肤那张卡的外框 CSS 引用着它自己的旋钮。拿它当参考时不提醒的话,模型原样照抄,
	 * 新皮肤里就是一串没声明的旋钮引用 —— 面板上拧不动,保存时还冒一排提醒(2026-09-17 真机)。
	 */
	it("read_card 退回默认皮肤那张时,点明其中的旋钮这套没有,叫它换成具体的值", async () => {
		const foreign = await installForeign();
		const out = await harness().text(T.readCard, { skin: foreign, kind: "sc" });
		expect(out).toContain("var(--bn-knob-font");
		expect(out).toMatch(/没有声明这些旋钮/);
		expect(out).toMatch(/换成具体的值/);
	});

	it("这套自己声明了那些旋钮 → 退回默认皮肤时不提醒", async () => {
		// 旋钮与默认皮肤同一套,只写了直播卡:读醒目留言卡会退回默认皮肤那张。
		const manifest = {
			...DEFAULT_CARD_SKIN,
			name: "带旋钮的",
			cards: { live: DEFAULT_CARD_SKIN.cards.live },
		};
		const zip = zipSync({ [CARD_SKIN_MANIFEST_FILE]: strToU8(JSON.stringify(manifest)) });
		const { id } = await store.install(zip);
		const out = await harness().text(T.readCard, { skin: id, kind: "sc" });
		expect(out).toContain("var(--bn-knob-font");
		expect(out).not.toMatch(/没有声明这些旋钮/);
	});

	it("read_block 给那一块的正文;读不改东西", async () => {
		const foreign = await installForeign();
		const h = harness();
		const css = await h.text(T.readBlock, { skin: foreign, kind: "live", block: "cover" });
		expect(css).toContain("#123456");
		const html = await h.text(T.readBlock, { skin: foreign, kind: "live", block: "note" });
		expect(html).toContain("{live.title}");
		expect(h.record).not.toHaveBeenCalled();
		expect(h.touched()).toEqual([]);
	});
});

describe("look_card", () => {
	it("截得到 → 图交回给 generator,文字里叮嘱只说不改", async () => {
		const foreign = await installForeign();
		const shoot = vi.fn(async () => "data:image/jpeg;base64,U0hPVA==");
		const out = await harness(undefined, { shoot }).run(T.lookCard, {
			skin: foreign,
			kind: "live",
		});
		expect(shoot).toHaveBeenCalledWith(foreign, "live");
		expect(typeof out).toBe("object");
		const res = out as ExtraToolResult;
		expect(res.images).toEqual(["data:image/jpeg;base64,U0hPVA=="]);
		expect(res.text).toMatch(/不要自己|别自己/);
	});

	it("服务端没装 Chrome → 回一句看不见,不报错", async () => {
		const foreign = await installForeign();
		const none = await harness(undefined, { shoot: async () => null }).run(T.lookCard, {
			skin: foreign,
			kind: "live",
		});
		expect(typeof none).toBe("string");
		expect(none).toMatch(/看不见|截不了/);
		const absent = await harness().run(T.lookCard, { skin: foreign, kind: "live" });
		expect(absent).toMatch(/看不见|截不了/);
	});
});

describe("提示词从契约常量拼", () => {
	const system = buildCardWorkshopSystem();

	it("七种卡、每种卡的内置块名、外框挂点都在", () => {
		for (const kind of CARD_SKIN_KINDS) {
			expect(system).toContain(kind);
			for (const block of Object.keys(CARD_SKIN_BUILTIN_BLOCKS[kind])) {
				expect(system).toContain(block);
			}
		}
		for (const hook of Object.keys(CARD_SKIN_FRAME_HOOKS)) {
			expect(system).toContain(`[data-bn="${hook}"]`);
		}
	});

	it("每种卡的字段路径都在", () => {
		for (const kind of CARD_SKIN_KINDS) {
			for (const field of CARD_SKIN_FIELDS[kind]) expect(system).toContain(field.path);
		}
	});

	it("清洗器真在执行的规矩都在:禁用属性、HTML 标签白名单", () => {
		for (const prop of CARD_CSS_DENY_PROPS) expect(system).toContain(prop);
		for (const tag of CARD_HTML_ALLOWED_TAGS) expect(system).toContain(tag);
	});

	it("不带人格,也不许它自己换上", () => {
		expect(system).not.toMatch(/主人的女仆|喵/);
		expect(system).toMatch(/换上这套/);
	});
});
