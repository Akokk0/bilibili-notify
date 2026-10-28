/**
 * 其余六条直播文案的占位符改写(3b-21):`-key` 老写法与 `{mastername}` / `{uname}` / `{mdn}` 改成中立的 `{key}`,
 * 推出去的字不变;账本里这三条(特别弹幕 / 特别进场 / 弹幕总结)记着旧默认的指纹的,换成新默认的指纹。
 *
 * 输入**不往** `zero-fixtures.ts` 里加(那套夹具钉着整份迁移产出的摘要,`card-moves.test.ts` 同一个理由),在夹具之外造,
 * 走同一条纯函数流水:设置 `migrateGlobalsToCurrent`,订阅行 `toCurrentRow`。
 */

import { interpolate } from "@bilibili-notify/internal";
import { DEFAULT_LOCALE } from "@bilibili-notify/internal/i18n";
import { templateFingerprint } from "@bilibili-notify/internal/template-defaults";
import { templateDefaultsFor } from "@bilibili-notify/internal/texts/builtin";
import { describe, expect, it } from "vite-plus/test";
import {
	rewriteGlobalLivePlaceholders,
	rewriteSubscriptionLivePlaceholders,
	ZERO_LIVE_PLACEHOLDER_RENAMES,
} from "../live-placeholders.js";
import { ZERO_GLOBAL_LIVE_FACTS } from "../live-split.js";
import { migrateGlobalsToCurrent } from "../settings.js";
import { toCurrentRow } from "../subscriptions.js";

const FACTORY_TEMPLATES = templateDefaultsFor(DEFAULT_LOCALE);

type Obj = Record<string, unknown>;

/** 全局设置里只有文案(和可选的账本),够走完 `rewriteGlobalLivePlaceholders`。 */
const globalsOf = (templates: Obj, ledger?: Obj): Obj => ({
	defaults: { templates, ...(ledger ? { templateDefaultsSeen: ledger } : {}) },
});

const templatesOf = (raw: unknown): Obj => ((raw as Obj).defaults as { templates: Obj }).templates;
const ledgerOf = (raw: unknown): Obj =>
	((raw as Obj).defaults as { templateDefaultsSeen: Obj }).templateDefaultsSeen;

// ── 各发布标签上的旧默认原文(`git show <tag>:<path>` 取的,冻在这里) ──────────────────────────────
// 特别弹幕、特别进场:v0.1.0-alpha.0 到 v0.12.0 所有标签逐字相同,一代。
const OLD_VIEWER_CHAT = "{mastername} 的关注用户 {uname} 发送弹幕：{msg}";
const OLD_VIEWER_ENTER = "{uname} 进入了 {mastername} 的直播间";
// 弹幕总结两代:v0.1.0-alpha.0 到 alpha.4 用 `-key`;v0.1.0-alpha.5 到 v0.12.0 用 `{key}`。
const OLD_SUMMARY_DASH = `🔍【弹幕情报站】本场直播数据如下：
🧍‍♂️ 总共 -dmc 位-mdn上线
💬 共计 -dca 条弹幕飞驰而过
📊 热词云图已生成，快来看看你有没有上榜！
👑 本场顶级输出选手：
🥇 -un1 - 弹幕输出 -dc1 条
🥈 -un2 - 弹幕 -dc2 条，萌力惊人
🥉 -un3 - -dc3 条精准狙击
🎖️ 特别嘉奖：-un4 & -un5
你们的弹幕，我们都记录在案！🕵️‍♀️`;
const OLD_SUMMARY_BRACE = `🔍【弹幕情报站】本场直播数据如下：
🧍‍♂️ 总共 {dmc} 位{mdn}上线
💬 共计 {dca} 条弹幕飞驰而过
📊 热词云图已生成，快来看看你有没有上榜！
👑 本场顶级输出选手：
🥇 {un1} - 弹幕输出 {dc1} 条
🥈 {un2} - 弹幕 {dc2} 条，萌力惊人
🥉 {un3} - {dc3} 条精准狙击
🎖️ 特别嘉奖：{un4} & {un5}
你们的弹幕，我们都记录在案！🕵️‍♀️`;

// ── 0.12 的运行时引擎(冻一份:v0.12.0 的 `packages/live/src/template-renderer.ts` 的 `applyTemplate`) ──
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function zeroApplyTemplate(template: string, vars: Record<string, string>): string {
	const keys = Object.keys(vars).sort((a, b) => b.length - a.length);
	if (keys.length === 0) return template.replaceAll("\\n", "\n");
	const alts = keys.flatMap((k) => [`\\{${escapeRegExp(k)}\\}`, `-${escapeRegExp(k)}`]);
	const re = new RegExp(alts.join("|"), "g");
	return template
		.replace(re, (m) => {
			const key = m.charCodeAt(0) === 123 ? m.slice(1, -1) : m.slice(1);
			return vars[key] ?? m;
		})
		.replaceAll("\\n", "\n");
}

describe("六条直播文案的占位符改写:逐条", () => {
	const rewrite = (key: string, text: string): string =>
		templatesOf(rewriteGlobalLivePlaceholders(globalsOf({ [key]: text })))[key] as string;

	it("开播:`-key` 与 `{key}` 都改成 `{key}`;`real-time` 里的 `-time` 照样改", () => {
		expect(rewrite("liveStart", "-name 开播啦 -follower {time} real-time")).toBe(
			"{name} 开播啦 {follower} {time} real{time}",
		);
	});

	it("开播里的 `-watched` 不碰(0.x 开播不认它,原样印出)", () => {
		expect(rewrite("liveStart", "{name} -watched {watched}")).toBe("{name} -watched {watched}");
	});

	it("正在直播:`-watched` 改成 `{watched}`", () => {
		expect(rewrite("liveStreaming", "-name 已播 -time 看过 -watched")).toBe(
			"{name} 已播 {time} 看过 {watched}",
		);
	});

	it("下播:`-follower_change` 不被 `-follower` 吃掉前半", () => {
		expect(rewrite("liveEnd", "-name 下播 -follower_change {follower_change}")).toBe(
			"{name} 下播 {follower_change} {follower_change}",
		);
		// 下播不认 `-follower`,原样留着。
		expect(rewrite("liveEnd", "-follower")).toBe("-follower");
	});

	it("特别弹幕:`mastername` → `name`,`uname` → `viewer`,`msg` 不变,两种写法都改", () => {
		expect(rewrite("viewerChat", "-mastername 的 {uname} 说 -msg / {msg}")).toBe(
			"{name} 的 {viewer} 说 {msg} / {msg}",
		);
	});

	it("特别进场:`mastername` → `name`,`uname` → `viewer`;不认 `msg`", () => {
		expect(rewrite("viewerEnter", "{uname} 进了 -mastername 的房间 -msg")).toBe(
			"{viewer} 进了 {name} 的房间 -msg",
		);
	});

	it("弹幕总结:`mdn` → `fanclub`(两种写法),其余缩写原名只改写法", () => {
		expect(rewrite("liveSummary", "-dmc 位-mdn / {mdn} / -dca / -un1 -dc1 / {un5} {dc5}")).toBe(
			"{dmc} 位{fanclub} / {fanclub} / {dca} / {un1} {dc1} / {un5} {dc5}",
		);
	});

	it("键集恰好是 0.12 运行时认的那一套", () => {
		expect(
			Object.fromEntries(
				Object.entries(ZERO_LIVE_PLACEHOLDER_RENAMES).map(([k, v]) => [k, Object.keys(v).sort()]),
			),
		).toEqual({
			liveStart: ["follower", "name", "time"],
			liveStreaming: ["name", "time", "watched"],
			liveEnd: ["follower_change", "name", "time"],
			viewerChat: ["mastername", "msg", "uname"],
			viewerEnter: ["mastername", "uname"],
			liveSummary: [
				"dc1",
				"dc2",
				"dc3",
				"dc4",
				"dc5",
				"dca",
				"dmc",
				"mdn",
				"un1",
				"un2",
				"un3",
				"un4",
				"un5",
			],
		});
	});

	it("撞名(接受,同上舰文案 ㉓d):主人手写的字面 `{name}` 迁移前原样印出,迁移后成了变量", () => {
		// 0.x 不认特别弹幕里的 `{name}`;1.0 认。这一小撮文案推出去的字会变,见模块头注释。
		expect(
			zeroApplyTemplate("{name} 说 {msg}", { mastername: "阿绫", uname: "路人", msg: "嗨" }),
		).toBe("{name} 说 嗨");
		expect(
			interpolate(rewrite("viewerChat", "{name} 说 {msg}"), {
				name: "阿绫",
				viewer: "路人",
				msg: "嗨",
			}),
		).toBe("阿绫 说 嗨");
	});
});

describe("出字不变:冻住的 0.12 引擎 vs 改写之后的 `interpolate`", () => {
	/** 每条文案:旧键值(给 0.12 引擎)与新键值(给 `interpolate`)是同样的内容,只是键名不同。 */
	const CASES: Array<{
		key: string;
		templates: string[];
		oldVars: Record<string, string>;
		newVars: Record<string, string>;
	}> = [
		{
			key: "liveStart",
			templates: [
				"-name 开播 -follower",
				"{name} 开播啦，粉丝 {follower}\\n第二行",
				"real-time {time}",
				// 开播不认 `watched`:0.12 原样印出,改写不能把它变成变量。
				"-name -watched",
			],
			oldVars: { name: "阿绫", time: "1小时", follower: "1.2万" },
			newVars: { name: "阿绫", time: "1小时", follower: "1.2万" },
		},
		{
			key: "liveStreaming",
			templates: ["-name 已播 -time 看过 -watched", "{name}{time}{watched}", "-watched-watched"],
			oldVars: { name: "阿绫", time: "2小时", watched: "{name}" },
			newVars: { name: "阿绫", time: "2小时", watched: "{name}" },
		},
		{
			key: "liveEnd",
			templates: ["-name 下播 -follower_change", "{name} {follower_change}\\n{time}"],
			oldVars: { name: "阿绫", time: "3小时", follower_change: "+120" },
			newVars: { name: "阿绫", time: "3小时", follower_change: "+120" },
		},
		{
			key: "viewerChat",
			templates: [
				"-mastername 的 -uname 说 -msg",
				"{mastername}/{uname}/{msg}\\n完",
				OLD_VIEWER_CHAT,
			],
			oldVars: { mastername: "阿绫", uname: "{msg}", msg: "-uname" },
			newVars: { name: "阿绫", viewer: "{msg}", msg: "-uname" },
		},
		{
			key: "viewerEnter",
			templates: ["-uname 进了 -mastername 的房间", OLD_VIEWER_ENTER],
			oldVars: { mastername: "阿绫", uname: "路人" },
			newVars: { name: "阿绫", viewer: "路人" },
		},
		{
			key: "liveSummary",
			templates: [OLD_SUMMARY_DASH, OLD_SUMMARY_BRACE, "-dmc 位-mdn / -dca\\n-un1 -dc1"],
			oldVars: {
				dmc: "5",
				mdn: "粉丝团",
				dca: "9",
				un1: "甲",
				dc1: "4",
				un2: "乙",
				dc2: "3",
				un3: "丙",
				dc3: "2",
				un4: "丁",
				dc4: "1",
				un5: "戊",
				dc5: "1",
			},
			newVars: {
				dmc: "5",
				fanclub: "粉丝团",
				dca: "9",
				un1: "甲",
				dc1: "4",
				un2: "乙",
				dc2: "3",
				un3: "丙",
				dc3: "2",
				un4: "丁",
				dc4: "1",
				un5: "戊",
				dc5: "1",
			},
		},
	];

	for (const c of CASES) {
		it(`${c.key}:每个样例改写之后推出去的字与 0.12 一字不差`, () => {
			for (const template of c.templates) {
				const rewritten = templatesOf(
					rewriteGlobalLivePlaceholders(globalsOf({ [c.key]: template })),
				)[c.key] as string;
				expect(interpolate(rewritten, c.newVars).replaceAll("\\n", "\n")).toBe(
					zeroApplyTemplate(template, c.oldVars),
				);
			}
		});
	}
});

describe("每一代旧默认改写之后就是今天的默认", () => {
	it("特别弹幕、特别进场各一代,弹幕总结两代", () => {
		const out = templatesOf(
			rewriteGlobalLivePlaceholders(
				globalsOf({
					viewerChat: OLD_VIEWER_CHAT,
					viewerEnter: OLD_VIEWER_ENTER,
					liveSummary: OLD_SUMMARY_DASH,
				}),
			),
		);
		expect(out.viewerChat).toBe(FACTORY_TEMPLATES.viewerChat);
		expect(out.viewerEnter).toBe(FACTORY_TEMPLATES.viewerEnter);
		expect(out.liveSummary).toBe(FACTORY_TEMPLATES.liveSummary);
		expect(
			templatesOf(rewriteGlobalLivePlaceholders(globalsOf({ liveSummary: OLD_SUMMARY_BRACE })))
				.liveSummary,
		).toBe(FACTORY_TEMPLATES.liveSummary);
	});

	it("开播、正在直播、下播的 0.12 默认本来就是今天的默认,改写不动它们", () => {
		const zero = {
			liveStart: "{name} 开播啦，当前粉丝数：{follower}",
			liveStreaming: "{name} 正在直播，已播 {time}，累计观看：{watched}",
			liveEnd: "{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
		};
		expect(templatesOf(rewriteGlobalLivePlaceholders(globalsOf(zero)))).toEqual(zero);
		expect(zero).toEqual({
			liveStart: FACTORY_TEMPLATES.liveStart,
			liveStreaming: FACTORY_TEMPLATES.liveStreaming,
			liveEnd: FACTORY_TEMPLATES.liveEnd,
		});
	});
});

describe("账本:这三条记着旧默认的指纹的,换成新默认的指纹", () => {
	const fp = templateFingerprint;

	it("等于任何一代旧默认的指纹就换;别的条目、对不上的不动;键序不变", () => {
		const ledger = {
			liveStart: "1nkgnb7",
			viewerChat: fp(OLD_VIEWER_CHAT),
			viewerEnter: fp(OLD_VIEWER_ENTER),
			liveSummary: fp(OLD_SUMMARY_DASH),
			post: "7uw5nq",
		};
		const out = ledgerOf(rewriteGlobalLivePlaceholders(globalsOf({}, ledger)));
		expect(out).toEqual({
			liveStart: "1nkgnb7",
			viewerChat: fp(FACTORY_TEMPLATES.viewerChat),
			viewerEnter: fp(FACTORY_TEMPLATES.viewerEnter),
			liveSummary: fp(FACTORY_TEMPLATES.liveSummary),
			post: "7uw5nq",
		});
		expect(Object.keys(out)).toEqual(Object.keys(ledger));
		// 花括号那一代的总结也换。
		expect(
			ledgerOf(rewriteGlobalLivePlaceholders(globalsOf({}, { liveSummary: fp(OLD_SUMMARY_BRACE) })))
				.liveSummary,
		).toBe(fp(FACTORY_TEMPLATES.liveSummary));
		// 对不上任何一代旧默认的指纹(比如他见过的是别的版本)原样留着。
		expect(
			ledgerOf(
				rewriteGlobalLivePlaceholders(globalsOf({}, { viewerChat: "zzzz", liveSummary: 7 })),
			),
		).toEqual({ viewerChat: "zzzz", liveSummary: 7 });
	});

	it("没有账本不新建", () => {
		const out = rewriteGlobalLivePlaceholders(globalsOf({ viewerChat: OLD_VIEWER_CHAT })) as {
			defaults: Obj;
		};
		expect(out.defaults).not.toHaveProperty("templateDefaultsSeen");
	});
});

describe("认不得的形状与再跑一遍", () => {
	it("认不得的形状原样放过(同一个对象)", () => {
		for (const raw of [
			undefined,
			null,
			"x",
			7,
			[],
			{},
			{ defaults: 3 },
			{ defaults: {} },
			{ defaults: { templates: [] } },
		]) {
			expect(rewriteGlobalLivePlaceholders(raw)).toBe(raw);
		}
		for (const row of [
			undefined,
			null,
			"x",
			{},
			{ overrides: 3 },
			{ overrides: {} },
			{ overrides: { templates: "x" } },
		]) {
			expect(rewriteSubscriptionLivePlaceholders(row)).toBe(row);
		}
	});

	it("非字符串的文案格不碰", () => {
		const raw = globalsOf({ viewerChat: 3, liveSummary: null });
		expect(rewriteGlobalLivePlaceholders(raw)).toBe(raw);
	});

	it("已是新形状的再跑一遍回同一个对象", () => {
		const once = rewriteGlobalLivePlaceholders(
			globalsOf(
				{ viewerChat: OLD_VIEWER_CHAT, liveSummary: OLD_SUMMARY_DASH },
				{ viewerChat: templateFingerprint(OLD_VIEWER_CHAT) },
			),
		);
		expect(rewriteGlobalLivePlaceholders(once)).toBe(once);
		const sub = rewriteSubscriptionLivePlaceholders({
			overrides: { templates: { viewerEnter: "-uname" } },
		});
		expect(rewriteSubscriptionLivePlaceholders(sub)).toBe(sub);
	});
});

describe("订阅覆盖", () => {
	it("六格都改,没覆盖的格不长出来,别的格与键序不动", () => {
		const row = {
			id: "s1",
			overrides: {
				templates: {
					liveStart: "-name 开了",
					viewerChat: "-mastername/-uname/-msg",
					liveSummary: "-mdn",
					post: "-name 的作品",
				},
				features: { viewerChat: true },
			},
		};
		const out = rewriteSubscriptionLivePlaceholders(row) as typeof row;
		expect(out.overrides.templates).toEqual({
			liveStart: "{name} 开了",
			viewerChat: "{name}/{viewer}/{msg}",
			liveSummary: "{fanclub}",
			post: "-name 的作品",
		});
		expect(Object.keys(out.overrides.templates)).toEqual([
			"liveStart",
			"viewerChat",
			"liveSummary",
			"post",
		]);
		expect(out.overrides.features).toBe(row.overrides.features);
	});
});

describe("接线:真走设置流水与订阅行流水", () => {
	it("全局:经 `migrateGlobalsToCurrent`,改过的文案先改写,等于 0.12 默认的随后删键、账本一起修剪", () => {
		const out = migrateGlobalsToCurrent(
			globalsOf(
				{
					viewerChat: OLD_VIEWER_CHAT,
					liveSummary: OLD_SUMMARY_DASH,
					liveStreaming: "-name -time",
				},
				{ viewerChat: templateFingerprint(OLD_VIEWER_CHAT) },
			),
		) as { defaults: { templates: Obj }; templatesSeen: Obj };
		expect(out.defaults.templates).not.toHaveProperty("viewerChat");
		expect(out.defaults.templates).not.toHaveProperty("liveSummary");
		expect(out.defaults.templates.liveStreaming).toBe("{name} {time}");
		expect(out.templatesSeen).toEqual({});
	});

	it("订阅:经 `toCurrentRow`,覆盖里的文案改写", () => {
		const row = {
			id: "s1",
			uid: "1",
			overrides: { templates: { viewerEnter: "{uname}-mastername" } },
		};
		const out = toCurrentRow(row, ZERO_GLOBAL_LIVE_FACTS) as { overrides: { templates: Obj } };
		expect(out.overrides.templates.viewerEnter).toBe("{viewer}{name}");
	});
});
