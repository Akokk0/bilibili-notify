/**
 * 编辑器那口 AI(ADR-0015 决策 3–10、24–26):给**一个框**写 CSS。
 *
 * 两条接缝:
 * - 提示词拼装 —— 规则从清洗器真在执行的那几份常量来,上下文只给这个框用得着的;
 * - 一轮生成 —— 逐条规则往外流、剥代码围栏、清洗器拒收就带着错误重试一次。
 */

import {
	CARD_SKIN_BUILTIN_BLOCKS,
	CARD_SKIN_LIMITS,
	CARD_SKIN_VARIABLES,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
} from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { FORBIDDEN_VALUE, POSITION_VALUES } from "../../skins/scoped-css.js";
import {
	buildCardCssAiSystem,
	type CardCssAiGenerate,
	prepareCardCssAi,
	runCardCssAiRound,
} from "../ai-css.js";
import { CARD_CSS_DENY_PROPS } from "../css-sanitizer.js";

type Block = NonNullable<CardSkinManifest["cards"]["live"]>["blocks"][number];

/** 出厂皮肤的直播卡,几处正文换成认得出来的记号。 */
function fixture(): CardSkinManifest {
	const m = structuredClone(DEFAULT_CARD_SKIN) as CardSkinManifest;
	const live = m.cards.live;
	if (!live) throw new Error("出厂皮肤没有直播卡");
	live.css = '[data-bn="frame"]{padding:3px}/* FRAME_MARK */';
	const byId = (id: string) => live.blocks.find((b) => b.id === id) as Block;
	byId("title").css = '[data-bn="self"]{color:red}/* OTHER_BLOCK_MARK */';
	const cover = byId("cover");
	cover.css = '[data-bn="self"]{border-radius:4px}/* TARGET_MARK */';
	cover.assets = { hero: "asset:assets/hero.png" };
	live.blocks.push(
		{
			id: "note-a",
			kind: "custom",
			html: '<p class="mine">MINE_HTML</p>',
			grid: { row: 7, column: 1, span: 6 },
			showIf: "live.title",
		},
		{
			id: "note-b",
			kind: "custom",
			html: "<p>OTHER_HTML</p>",
			grid: { row: 7, column: 7, span: 6 },
		},
	);
	return m;
}

function prepared(target: Parameters<typeof prepareCardCssAi>[1]) {
	const ctx = prepareCardCssAi(fixture(), target);
	if (!ctx.ok) throw new Error(`没拼出来:${ctx.error}`);
	return ctx;
}

describe("提示词拼装", () => {
	it("规则取自清洗器真在执行的那几份常量", () => {
		const system = buildCardCssAiSystem();
		for (const prop of CARD_CSS_DENY_PROPS) expect(system).toContain(prop);
		for (const fn of FORBIDDEN_VALUE) expect(system).toContain(fn);
		for (const pos of POSITION_VALUES) expect(system).toContain(pos);
		for (const v of Object.values(CARD_SKIN_VARIABLES)) expect(system).toContain(v.css);
		expect(system).toContain(String(CARD_SKIN_LIMITS.maxCssBytes));
		// 卡片是静态截图 —— 这条不讲,模型会写一堆 hover 和动画。
		expect(system).toMatch(/静态/);
		expect(system).toMatch(/只输出 CSS/);
	});

	it("内置块:给这块的挂点、它现在的 CSS、外框 CSS、整卡轮廓、旋钮;不给别的块的 CSS", () => {
		const user = prepared({ kind: "live", blockId: "cover" }).user("圆角大一点");
		expect(user).toContain("圆角大一点");
		expect(user).toContain('[data-bn="self"]');
		const coverHooks = Object.entries(CARD_SKIN_BUILTIN_BLOCKS.live.cover?.hooks ?? {});
		expect(coverHooks.length).toBeGreaterThan(0);
		for (const [hook, label] of coverHooks) {
			expect(user).toContain(`[data-bn="${hook}"]`);
			expect(user).toContain(label);
		}
		expect(user).toContain("TARGET_MARK");
		expect(user).toContain("FRAME_MARK");
		// 整卡轮廓:出厂皮肤直播卡的每一块(块怎么拆归默认皮肤,这里不抄名单)+ 夹具加的两块。
		const ids = [
			...(DEFAULT_CARD_SKIN.cards.live?.blocks ?? []).map((b) => b.id),
			"note-a",
			"note-b",
		];
		expect(ids).toContain("title");
		for (const id of ids) expect(user).toContain(id);
		// 轮廓里带着 showIf —— 「这块有时不出现」会影响怎么写间距。
		expect(user).toContain("live.title");
		// 旋钮只读:给变量名与兜底值,没拧过的旋钮不注入,兜底必须写。
		expect(user).toContain("var(--bn-knob-gradient-start, #e0c3fc)");
		expect(user).toContain("var(--bn-asset-hero)");
		expect(user).not.toContain("OTHER_BLOCK_MARK");
		expect(user).not.toContain("OTHER_HTML");
	});

	it("自定义块:给它自己的 HTML(挂点只有 self,不看 HTML 写不了里面),不给别的块的", () => {
		const user = prepared({ kind: "live", blockId: "note-a" }).user("字大一点");
		expect(user).toContain("MINE_HTML");
		expect(user).not.toContain("OTHER_HTML");
		expect(user).not.toContain('[data-bn="avatar"]');
	});

	it("外框:挂点是 frame / glass,现有内容就是外框 CSS", () => {
		const user = prepared({ kind: "live" }).user("换成深色");
		expect(user).toContain('[data-bn="frame"]');
		expect(user).toContain('[data-bn="glass"]');
		expect(user).toContain("FRAME_MARK");
		expect(user).not.toContain("OTHER_BLOCK_MARK");
		expect(user).not.toContain("TARGET_MARK");
	});

	it("清洗用的是这个框自己那张挂点表", () => {
		const cover = prepared({ kind: "live", blockId: "cover" });
		const own = cover.sanitize('[data-bn="status"]{color:red}');
		expect(own).toMatchObject({ ok: true, warnings: [] });
		const foreign = cover.sanitize('[data-bn="avatar"]{color:red}');
		expect(foreign.ok && foreign.warnings.length).toBeGreaterThan(0);
		const frame = prepared({ kind: "live" }).sanitize('[data-bn="glass"]{color:red}');
		expect(frame).toMatchObject({ ok: true, warnings: [] });
	});

	it("那种卡没接管、或者块不存在 → 说清楚,不硬拼", () => {
		const m = fixture();
		delete m.cards.sc;
		expect(prepareCardCssAi(m, { kind: "sc" })).toMatchObject({ ok: false });
		expect(prepareCardCssAi(m, { kind: "live", blockId: "nope" })).toMatchObject({ ok: false });
	});
});

/** 按给定分片吐字的假生成器,一次调用一份脚本。 */
function scripted(...runs: string[][]): CardCssAiGenerate & { calls: Array<{ user: string }> } {
	const calls: Array<{ user: string }> = [];
	const fn = (async (_system, user, stream) => {
		calls.push({ user });
		const chunks = runs[calls.length - 1] ?? [];
		for (const c of chunks) stream.onText(c);
		return chunks.join("");
	}) as CardCssAiGenerate & { calls: Array<{ user: string }> };
	fn.calls = calls;
	return fn;
}

const OK = (css: string) => ({ ok: true as const, css, warnings: [] });

describe("一轮生成", () => {
	it("只在一整条规则写完时往外交,代码围栏剥掉", async () => {
		const generate = scripted([
			"```css\n.a{col",
			"or:red}\n.b",
			'{content:"}"}/* } */',
			"\n@media (min-width:1px){.c{x:1}}",
			"\n```",
		]);
		const rules: string[] = [];
		const res = await runCardCssAiRound({
			generate,
			system: "S",
			user: "U",
			sanitize: OK,
			onRule: (t) => rules.push(t),
		});
		expect(rules).toEqual([
			".a{color:red}",
			'\n.b{content:"}"}',
			"/* } */\n@media (min-width:1px){.c{x:1}}",
		]);
		expect(res).toEqual({
			ok: true,
			css: '.a{color:red}\n.b{content:"}"}/* } */\n@media (min-width:1px){.c{x:1}}',
			warnings: [],
		});
	});

	it("清洗器削掉的照说 —— warnings 原样带回", async () => {
		const res = await runCardCssAiRound({
			generate: scripted([".a{x:1}"]),
			system: "S",
			user: "U",
			sanitize: () => ({ ok: true, css: "", warnings: ["属性 behavior 被丢弃"] }),
			onRule: () => {},
		});
		expect(res).toMatchObject({ ok: true, css: ".a{x:1}", warnings: ["属性 behavior 被丢弃"] });
	});

	it("清洗器整份拒收 → 带着错误与上次的输出重试一次", async () => {
		const generate = scripted(["BROKEN{"], [".ok{x:1}"]);
		const sanitize = vi
			.fn()
			.mockReturnValueOnce({ ok: false, errors: ["CSS 解析失败"] })
			.mockReturnValueOnce(OK(".ok{x:1}"));
		const retries: string[][] = [];
		const rules: string[] = [];
		const res = await runCardCssAiRound({
			generate,
			system: "S",
			user: "U",
			sanitize,
			onRule: (t) => rules.push(t),
			onRetry: (errors) => retries.push(errors),
		});
		expect(retries).toEqual([["CSS 解析失败"]]);
		expect(generate.calls).toHaveLength(2);
		expect(generate.calls[1]?.user).toContain("U");
		expect(generate.calls[1]?.user).toContain("CSS 解析失败");
		expect(generate.calls[1]?.user).toContain("BROKEN{");
		expect(rules).toEqual([".ok{x:1}"]);
		expect(res).toMatchObject({ ok: true, css: ".ok{x:1}" });
	});

	it("什么都没吐也算没过 —— 不然框被清空,用户手写的那段就没了", async () => {
		const generate = scripted(["```css\n```"], [".ok{x:1}"]);
		const res = await runCardCssAiRound({
			generate,
			system: "S",
			user: "U",
			sanitize: OK,
			onRule: () => {},
		});
		expect(generate.calls).toHaveLength(2);
		expect(res).toMatchObject({ ok: true, css: ".ok{x:1}" });
	});

	it("重试还不过 → 报错,不再试第三次", async () => {
		const generate = scripted(["A{"], ["B{"]);
		const res = await runCardCssAiRound({
			generate,
			system: "S",
			user: "U",
			sanitize: () => ({ ok: false, errors: ["CSS 解析失败"] }),
			onRule: () => {},
		});
		expect(res).toEqual({ ok: false, errors: ["CSS 解析失败"] });
		expect(generate.calls).toHaveLength(2);
	});

	it("取消原样抛出,不当成失败去重试;信号交给生成器", async () => {
		const ctl = new AbortController();
		const cancelled = Object.assign(new Error("已取消"), { cancelled: true });
		const generate = vi.fn<CardCssAiGenerate>(async () => {
			throw cancelled;
		});
		await expect(
			runCardCssAiRound({
				generate,
				system: "S",
				user: "U",
				sanitize: OK,
				onRule: () => {},
				signal: ctl.signal,
			}),
		).rejects.toBe(cancelled);
		expect(generate).toHaveBeenCalledTimes(1);
		expect(generate.mock.calls[0]?.[2].signal).toBe(ctl.signal);
	});
});
