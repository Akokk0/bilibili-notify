/**
 * 其余六条直播文案的占位符改写(3b-21,ADR-0021 决策 33):全仓只留一个模板引擎 `interpolate`(只认 `{key}`),所以盘上直播文案
 * 里 koishi 时代的 `-key` 老写法、和 0.x 起名的 `{mastername}` / `{uname}` / `{mdn}`,都要改成中立的 `{key}` —— 改写之后推出去的字
 * 与 0.12 一字不差。接在直播拆键({@link splitGlobalLiveSettings} / {@link splitSubscriptionLiveSettings})之后,此时文案键已是 1.0 的名字
 * (`liveStreaming` / `viewerChat` / `viewerEnter`);全局设置与逐订阅覆盖各一个入口。
 *
 * | 文案 | 改写(0.12 运行时认的键 → 1.0 的键) |
 * | --- | --- |
 * | `liveStart` | `name` `time` `follower`,名字不变,只改写法 |
 * | `liveStreaming` | `name` `time` `watched`,同上 |
 * | `liveEnd` | `name` `time` `follower_change`,同上 |
 * | `viewerChat` | `mastername` → `name`,`uname` → `viewer`,`msg` 不变 |
 * | `viewerEnter` | `mastername` → `name`,`uname` → `viewer` |
 * | `liveSummary` | `mdn` → `fanclub`,`dmc` `dca` `un1..5` `dc1..5` 不变 |
 *
 * 每条文案的键集**恰好是 0.12 运行时那一条认的键集**(`v0.12.0:packages/live/src/template-renderer.ts`):开播里的 `-watched` 在 0.x 里
 * 原样印出来,迁移也不碰它。改写一律走 {@link rewritePlaceholders}(单遍、最长优先、不看词边界,与 0.x 的 `applyTemplate` 同一套规矩:
 * `-follower_change` 不被 `-follower` 吃,`real-time` 里的 `-time` 照样改)。
 *
 * 账本(此时还在老位置 `defaults.templateDefaultsSeen`):`viewerChat` / `viewerEnter` / `liveSummary` 三条,记着的指纹等于任何一代
 * 旧默认的指纹的,换成「该旧默认改写之后」的指纹 —— 改写之后它就是今天的默认,他「见过」的就是这一版,规则页不会因为默认里只换了变量名
 * 而亮灯。别的条目、对不上的不动;没有账本不新建。
 *
 * ⚠️ 撞名(残题 R1,接受,同上舰文案 ㉓d 的先例,见 `placeholders.ts` 末尾):0.x 的特别弹幕 / 进场不认字面的 `{name}` / `{viewer}`,弹幕总结不认
 * `{fanclub}`,原样印出;改写之后它们是变量,会被填值。手写过这些字的文案极少,不为它们检测、不进迁移报告。
 *
 * 旧默认原文来自各发布标签(`git show <tag>:packages/internal/src/{schema/globals,constants}.ts`):特别弹幕与特别进场从
 * `v0.1.0-alpha.0` 到 `v0.12.0` 所有标签逐字相同,一代;弹幕总结两代 —— `v0.1.0-alpha.0` 到 `v0.1.0-alpha.4` 用 `-key`,
 * `v0.1.0-alpha.5` 到 `v0.12.0` 用 `{key}`。账本从 `v0.5.0` 才有,实际只会见到花括号那一代的指纹。
 * **不依赖运行时代码**:改写表与旧默认都是迁移自己冻住的一份,不取 internal 的 `DEFAULT_TEMPLATES`;3b-12 要拿最终默认比「没改过」时,
 * 复用这里导出的改写表。
 *
 * 值原样搬、键序不变;认不得的形状原样放过(由配置仓开机时报出来);已经是新形状的数据再跑一遍回同一个对象。
 */

import { templateFingerprint } from "@bilibili-notify/internal/template-defaults";
import { isPlainObject } from "./files.js";
import { rewritePlaceholders } from "./placeholders.js";

type Obj = Record<string, unknown>;

/** 恒等的那几格不能省:它们是 `-key` → `{key}` 的那一半。键集 = 0.12 运行时那一条认的键集。 */
export const ZERO_LIVE_PLACEHOLDER_RENAMES = {
	liveStart: { name: "name", time: "time", follower: "follower" },
	liveStreaming: { name: "name", time: "time", watched: "watched" },
	liveEnd: { name: "name", time: "time", follower_change: "follower_change" },
	viewerChat: { mastername: "name", uname: "viewer", msg: "msg" },
	viewerEnter: { mastername: "name", uname: "viewer" },
	liveSummary: {
		dmc: "dmc",
		mdn: "fanclub",
		dca: "dca",
		un1: "un1",
		dc1: "dc1",
		un2: "un2",
		dc2: "dc2",
		un3: "un3",
		dc3: "dc3",
		un4: "un4",
		dc4: "dc4",
		un5: "un5",
		dc5: "dc5",
	},
} as const;

type LiveTextKey = keyof typeof ZERO_LIVE_PLACEHOLDER_RENAMES;

const LIVE_TEXT_KEYS = Object.keys(ZERO_LIVE_PLACEHOLDER_RENAMES) as LiveTextKey[];

/** 弹幕总结两代旧默认之一(`v0.1.0-alpha.5` 到 `v0.12.0`)。 */
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

/**
 * 弹幕总结两代旧默认之二(`v0.1.0-alpha.0` 到 `v0.1.0-alpha.4`):和上一代逐字相同,只是 `{key}` 写成 `-key`
 * (`__tests__/live-placeholders.test.ts` 里冻着标签上的原文,逐字比过)。
 */
const OLD_SUMMARY_DASH = OLD_SUMMARY_BRACE.replace(/\{(\w+)\}/g, "-$1");

/** 账本要换指纹的三条和它们历代的旧默认。开播 / 正在直播 / 下播的 0.12 默认本来就是花括号写法,改写不动它们,账本不用换。 */
const OLD_DEFAULTS: Partial<Record<LiveTextKey, readonly string[]>> = {
	viewerChat: ["{mastername} 的关注用户 {uname} 发送弹幕：{msg}"],
	viewerEnter: ["{uname} 进入了 {mastername} 的直播间"],
	liveSummary: [OLD_SUMMARY_BRACE, OLD_SUMMARY_DASH],
};

const rewriteText = (key: LiveTextKey, text: string): string =>
	rewritePlaceholders(text, ZERO_LIVE_PLACEHOLDER_RENAMES[key]);

/**
 * `templates`(全局与逐订阅覆盖共用)里六格的改写,键序不变;没有要改的回同一个对象。
 */
function rewriteTemplates(templates: Obj): Obj {
	let changed = false;
	const next: Obj = {};
	for (const [key, value] of Object.entries(templates)) {
		if ((LIVE_TEXT_KEYS as string[]).includes(key) && typeof value === "string") {
			const rewritten = rewriteText(key as LiveTextKey, value);
			if (rewritten !== value) changed = true;
			next[key] = rewritten;
		} else {
			next[key] = value;
		}
	}
	return changed ? next : templates;
}

/** 账本:三条里记着旧默认指纹的换成该旧默认改写之后的指纹;没有要换的回同一个对象。 */
function rewriteLedger(ledger: Obj): Obj {
	let changed = false;
	const next: Obj = { ...ledger };
	for (const key of LIVE_TEXT_KEYS) {
		const seen = ledger[key];
		if (typeof seen !== "string") continue;
		const old = OLD_DEFAULTS[key]?.find((text) => templateFingerprint(text) === seen);
		if (old === undefined) continue;
		next[key] = templateFingerprint(rewriteText(key, old));
		if (next[key] !== seen) changed = true;
	}
	return changed ? next : ledger;
}

/**
 * 整份全局设置(**已经改成 1.0 的键、直播已拆键**)的 raw → raw:`defaults.templates` 六格改写,
 * 老位置账本 `defaults.templateDefaultsSeen` 三条换指纹。没有要改的回同一个对象。
 */
export function rewriteGlobalLivePlaceholders(raw: unknown): unknown {
	if (!isPlainObject(raw) || !isPlainObject(raw.defaults)) return raw;
	const defaults = raw.defaults;
	const templates = isPlainObject(defaults.templates) ? defaults.templates : undefined;
	const ledger = isPlainObject(defaults.templateDefaultsSeen)
		? defaults.templateDefaultsSeen
		: undefined;
	const nextTemplates = templates && rewriteTemplates(templates);
	const nextLedger = ledger && rewriteLedger(ledger);
	if (nextTemplates === templates && nextLedger === ledger) return raw;
	return {
		...raw,
		defaults: {
			...defaults,
			...(nextTemplates ? { templates: nextTemplates } : {}),
			...(nextLedger ? { templateDefaultsSeen: nextLedger } : {}),
		},
	};
}

/** 一条订阅(**已经改成 1.0 的键**)的 raw → raw:`overrides.templates` 六格改写。没有要改的回同一个对象。 */
export function rewriteSubscriptionLivePlaceholders(row: unknown): unknown {
	if (!isPlainObject(row) || !isPlainObject(row.overrides)) return row;
	const overrides = row.overrides;
	if (!isPlainObject(overrides.templates)) return row;
	const next = rewriteTemplates(overrides.templates);
	if (next === overrides.templates) return row;
	return { ...row, overrides: { ...overrides, templates: next } };
}
