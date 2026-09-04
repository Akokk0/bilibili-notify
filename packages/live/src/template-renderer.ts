import type { CustomGuardBuyLike, CustomLiveMsgLike, SubItemView } from "./push-like";
import type { MasterInfo } from "./types";

/**
 * Plain string-substitution based template renderer for live-related notification
 * text. Mirrors the per-occurrence templates of the live push:
 *
 * - `customLiveStart` / `customLive` / `customLiveEnd`
 * - `customGuardBuy.guardBuyMsg`
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
 * 的 `DEFAULT_TEMPLATES.liveStart/.liveOngoing` 保持字面量一致。
 */
export const DEFAULT_LIVE_TEMPLATES = {
	liveStart: "{name} 开播啦，当前粉丝数：{follower}",
	liveOngoing: "{name} 正在直播，已播 {time}，累计观看：{watched}",
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
 * Format follower-change as a signed magnitude string with a 1万 (10K) cutoff,
 * mirroring live-service's inline formatting.
 */
export function formatFollowerChange(n: number): string {
	if (n > 0) return n >= 10_000 ? `+${(n / 10000).toFixed(1)}万` : `+${n}`;
	if (n <= -10_000) return `${(n / 10000).toFixed(1)}万`;
	return n.toString();
}

/** Format follower count, abbreviating ≥10K to `X.X万`. */
export function formatFollowerCount(n: number): string {
	return n >= 10_000 ? `${(n / 10000).toFixed(1)}万` : n.toString();
}

/** Build the canonical room link from `LiveRoomInfo.data` style fields. */
export function buildRoomLink(info: { short_id: number; room_id: number }): string {
	return `https://live.bilibili.com/${info.short_id === 0 ? info.room_id : info.short_id}`;
}

/**
 * Resolve the effective template string for a sub at a given occurrence,
 * preferring per-sub override → global config → built-in default.
 *
 * 链接独立成版式部件:模板里的 `{link}`(与 legacy `-link`)连同前导空白 / 字面 `\n`
 * 在这里一并剥掉,三个 render* 拿到的模板里已经没有链接占位符。
 */
function resolveCustomLive(
	subCustom: CustomLiveMsgLike,
	globalCustom: CustomLiveMsgLike | undefined,
	field: "customLiveStart" | "customLive" | "customLiveEnd",
	fallback: string,
): string {
	const tmpl = subCustom[field] ?? globalCustom?.[field] ?? fallback;
	return tmpl.replace(/(?:\s|\\n)*(?:\{link\}|-link)/g, "");
}

export class LiveTemplateRenderer {
	/** Compose the "开播" notification text for a sub. */
	renderLiveStart(params: {
		sub: SubItemView;
		globalCustom?: CustomLiveMsgLike;
		master: MasterInfo;
		diffTime: string;
		followerNum: string;
	}): string {
		const tmpl = resolveCustomLive(
			params.sub.customLiveMsg,
			params.globalCustom,
			"customLiveStart",
			DEFAULT_LIVE_TEMPLATES.liveStart,
		);
		return applyTemplate(tmpl, {
			name: params.master.username,
			time: params.diffTime,
			follower: params.followerNum,
		});
	}

	/** Compose the periodic "正在直播" notification text. */
	renderLiveOngoing(params: {
		sub: SubItemView;
		globalCustom?: CustomLiveMsgLike;
		master: MasterInfo;
		diffTime: string;
		watched: string;
	}): string {
		const tmpl = resolveCustomLive(
			params.sub.customLiveMsg,
			params.globalCustom,
			"customLive",
			DEFAULT_LIVE_TEMPLATES.liveOngoing,
		);
		return applyTemplate(tmpl, {
			name: params.master.username,
			time: params.diffTime,
			watched: params.watched,
		});
	}

	/** Compose the "下播" notification text. */
	renderLiveEnd(params: {
		sub: SubItemView;
		globalCustom?: CustomLiveMsgLike;
		master: MasterInfo;
		diffTime: string;
		followerChange: number;
	}): string {
		const tmpl = resolveCustomLive(
			params.sub.customLiveMsg,
			params.globalCustom,
			"customLiveEnd",
			DEFAULT_LIVE_TEMPLATES.liveEnd,
		);
		return applyTemplate(tmpl, {
			name: params.master.username,
			time: params.diffTime,
			follower_change: formatFollowerChange(params.followerChange),
		});
	}

	/**
	 * Compose the "上舰" notification text using the effective custom-guard
	 * config (resolved by listener-manager).
	 */
	renderGuardBuy(params: {
		guardBuyConfig: CustomGuardBuyLike;
		uname: string;
		master: MasterInfo | undefined;
		giftName: string;
	}): string {
		return applyTemplate(params.guardBuyConfig.guardBuyMsg ?? "", {
			uname: params.uname,
			mname: params.master?.username ?? "",
			guard: params.giftName,
		});
	}

	/** Compose the "特别关注弹幕" notification text. */
	renderSpecialDanmaku(params: {
		template: string;
		uname: string;
		master: MasterInfo | undefined;
		content: string;
	}): string {
		return applyTemplate(params.template, {
			mastername: params.master?.username ?? "",
			uname: params.uname,
			msg: params.content,
		});
	}

	/** Compose the "特别关注进入直播间" notification text. */
	renderSpecialUserEnter(params: {
		template: string;
		uname: string;
		master: MasterInfo | undefined;
	}): string {
		return applyTemplate(params.template, {
			mastername: params.master?.username ?? "",
			uname: params.uname,
		});
	}

	/**
	 * Compose the templated "弹幕总结" text used as the fallback when AI
	 * summarisation is unavailable. Variables: `-dmc` (sender count), `-mdn`
	 * (master medal name), `-dca` (total danmaku), `-un1..5` (top usernames),
	 * `-dc1..5` (top counts).
	 */
	renderLiveSummary(params: {
		template: string;
		senderCount: number;
		master: MasterInfo | undefined;
		danmakuCount: number;
		topSenders: Array<[string, number]>;
	}): string {
		const top = params.topSenders;
		// 公共导出:topSenders 可能 <5(直播弹幕发送者不足 5 人)。此前无条件
		// 索引 top[0..4] 在 <5 时直接 `undefined[0]` 抛 TypeError;缺位安全降级
		// 为空名 / 0 条。
		const at = (i: number): [string, number] => top[i] ?? ["", 0];
		return applyTemplate(params.template, {
			dmc: `${params.senderCount}`,
			mdn: params.master?.medalName ?? "",
			dca: `${params.danmakuCount}`,
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
}
