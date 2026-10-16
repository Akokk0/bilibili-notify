import { formatCount } from "@bilibili-notify/internal";

/**
 * Plain string-substitution based template renderer for live-related notification
 * text. Mirrors the per-occurrence templates of the live push:
 *
 * - `customLiveStart` / `customLiveStreaming` / `customLiveEnd`
 * - `customSpecialDanmakuUsers.msgTemplate`
 * - `customSpecialUsersEnterTheRoom.msgTemplate`
 *
 * 占位符统一 `{name}` / `{time}` / `{watched}` 语法(与 `@bilibili-notify/internal`
 * 的 `interpolate` 同源)。`applyTemplate` 同时接受旧存档里的 legacy
 * `-name` / `-time` 写法 —— 老用户已保存的 `-key` 模板继续生效,新默认与文档
 * 一律走 `{key}`,二者不冲突(单遍正则,longest-first)。
 */

/**
 * Defaults applied when neither sub-level nor global config provides a template.
 * 链接不再进模板(开播链接是消息版式的独立部件);与 `@bilibili-notify/internal`
 * 的 `DEFAULT_TEMPLATES.liveStart/.liveStreaming` 保持字面量一致。
 */
export const DEFAULT_LIVE_TEMPLATES = {
	liveStart: "{name} 开播啦，当前粉丝数：{follower}",
	liveStreaming: "{name} 正在直播，已播 {time}，累计观看：{watched}",
	liveEnd: "{name} 下播啦，本次直播了 {time}，粉丝变化 {follower_change}",
	liveSummaryFallback: "弹幕总结",
} as const;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 单遍替换所有变量 token,再把 `\n` 转义展开为真换行。`vars` 以**裸键**(`name`/
 * `follower_change`)给出,每个键同时匹配 `{name}`(主)与 legacy `-name`(兼容)。
 *
 * P2:此前 `for…replaceAll` 顺序替换有两个缺陷 ——
 *  1. **token 注入**:用户可控值(uname / 弹幕内容)含 `{link}`/`-link` 时
 *     会被后续轮次再次替换;
 *  2. **前缀吞噬**:legacy `-follower` 先于 `-follower_change` 替换,把后者的
 *     `-follower` 段吃掉只剩 `_change`。
 * 改为基于原始模板的**单遍正则**:键按长度降序进 alternation(最长优先匹配),
 * 每个 token 恰好替换一次且替换值不再被回扫 → 杜绝注入与吞噬。
 */
export function applyTemplate(template: string, vars: Record<string, string>): string {
	const keys = Object.keys(vars).sort((a, b) => b.length - a.length);
	if (keys.length === 0) return template.replaceAll("\\n", "\n");
	// 每个裸键生成两种写法:`{key}`(主)与 `-key`(legacy)。longest-first 由 keys
	// 的降序保证 —— `-follower_change` 的 alt 先于 `-follower` 出现,不被吞噬。
	const alts = keys.flatMap((k) => [`\\{${escapeRegExp(k)}\\}`, `-${escapeRegExp(k)}`]);
	const re = new RegExp(alts.join("|"), "g");
	return template
		.replace(re, (m) => {
			const key = m.charCodeAt(0) === 123 /* '{' */ ? m.slice(1, -1) : m.slice(1);
			return vars[key] ?? m;
		})
		.replaceAll("\\n", "\n");
}

/**
 * 「特别弹幕」那一句:模板套上中立的值。占位符沿用 `mastername`(主播名)/ `uname`(发弹幕的人)/
 * `msg`(弹幕正文),与存档里的模板同一套写法。
 */
export function renderSpecialDanmaku(params: {
	template: string;
	viewerName: string;
	creatorName: string;
	text: string;
}): string {
	return applyTemplate(params.template, {
		mastername: params.creatorName,
		uname: params.viewerName,
		msg: params.text,
	});
}

/** 「特别进场」那一句:占位符 `mastername` / `uname`。 */
export function renderSpecialUserEnter(params: {
	template: string;
	viewerName: string;
	creatorName: string;
}): string {
	return applyTemplate(params.template, {
		mastername: params.creatorName,
		uname: params.viewerName,
	});
}

/**
 * 「弹幕总结」那一句(AI 总结用不了时的模板兜底)。占位符:`-dmc`(发言人数)、`-mdn`(粉丝团名字)、`-dca`(弹幕总数)、
 * `-un1..5`(发言最多的几位)、`-dc1..5`(各自的条数)。
 */
export function renderLiveSummary(params: {
	template: string;
	senderCount: number;
	/** 粉丝团的名字;拿不到给空串。 */
	fanClubName: string;
	viewerChatCount: number;
	topSenders: Array<[string, number]>;
}): string {
	const top = params.topSenders;
	// 公共导出:topSenders 可能 <5(直播弹幕发送者不足 5 人)。此前无条件
	// 索引 top[0..4] 在 <5 时直接 `undefined[0]` 抛 TypeError;缺位安全降级
	// 为空名 / 0 条。
	const at = (i: number): [string, number] => top[i] ?? ["", 0];
	return applyTemplate(params.template, {
		dmc: `${params.senderCount}`,
		mdn: params.fanClubName,
		dca: `${params.viewerChatCount}`,
		un1: at(0)[0],
		dc1: `${at(0)[1]}`,
		un2: at(1)[0],
		dc2: `${at(1)[1]}`,
		un3: at(2)[0],
		dc3: `${at(2)[1]}`,
		un4: at(3)[0],
		dc4: `${at(3)[1]}`,
		un5: at(4)[0],
		dc5: `${at(4)[1]}`,
	});
}

/** 三句直播文案:开播 / 正在直播(周期推送、重启补报)/ 下播。键与 `DEFAULT_LIVE_TEMPLATES` 同名。 */
export type LiveTextKind = "liveStart" | "liveStreaming" | "liveEnd";

/**
 * 三句直播文案的变量,**中立的值**(ADR-0019 决策 65 / 67)—— B 站的直播间与拓展订阅的直播各自把自己的
 * 东西翻成它。数字由渲染排成「1.2万」(粉丝数变化带正负号),平台给的成品文字原样;没有的格子空着
 * (决策 56:拓展没报过资料,粉丝那一格就空着)。
 */
export interface LiveTextInput {
	/** `{name}`。 */
	name: string;
	/** `{time}`:开播到此刻(下播:到下播那一刻)播了多久,已经排好的一句。 */
	time: string;
	/** `{follower}`(开播):当前粉丝数。 */
	follower?: number | string;
	/** `{watched}`(正在直播):本场累计观看,精确数。缺了(一帧都没收到 / 拓展没报)由 {@link renderLiveText} 在出口印「暂未获取到」。 */
	watched?: number;
	/** `{follower_change}`(下播):本场粉丝数变化。 */
	followerChange?: number | string;
}

/** `{watched}` 缺数时印的那句。 */
const WATCHED_UNKNOWN_TEXT = "暂未获取到";

/** 数字按 `format` 排,文字原样,没有就空串。 */
function textOf(v: number | string | undefined, format: (n: number) => string): string {
	return typeof v === "number" ? format(v) : (v ?? "");
}

/**
 * **三句直播文案的中立渲染**:模板(没给 = 默认那句)套上中立的值。
 *
 * 每一种只认自己那几个变量 —— 开播:`{name}` `{time}` `{follower}`;正在直播:`{name}` `{time}`
 * `{watched}`;下播:`{name}` `{time}` `{follower_change}`。别的原样留在文案里(与从前 B 站那三句一样,
 * 主人在开播模板里写了 `{watched}`,看到的就是字面的 `{watched}`)。
 */
export function renderLiveText(
	kind: LiveTextKind,
	template: string | undefined,
	values: LiveTextInput,
): string {
	const vars: Record<string, string> = { name: values.name, time: values.time };
	switch (kind) {
		case "liveStart":
			vars.follower = textOf(values.follower, (n) => formatCount(n));
			break;
		case "liveStreaming":
			// 缺数时的「暂未获取到」只在这里(文字出口)印,不写回直播数据。
			vars.watched =
				values.watched === undefined ? WATCHED_UNKNOWN_TEXT : formatCount(values.watched);
			break;
		case "liveEnd":
			vars.follower_change = textOf(values.followerChange, (n) => formatCount(n, { signed: true }));
			break;
	}
	return applyTemplate(template ?? DEFAULT_LIVE_TEMPLATES[kind], vars);
}
