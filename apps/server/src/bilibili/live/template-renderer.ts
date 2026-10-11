import { applyTemplate, DEFAULT_LIVE_TEMPLATES, renderLiveText } from "../../live/live-text";
import type { CustomLiveMsgLike, SubItemView } from "./push-like";
import type { MasterInfo } from "./types";

/** Build the canonical room link from `LiveRoomResponse.data` style fields. */
export function buildRoomLink(info: { short_id: number; room_id: number }): string {
	return `https://live.bilibili.com/${info.short_id === 0 ? info.room_id : info.short_id}`;
}

/**
 * Resolve the effective template string for a sub at a given occurrence,
 * preferring per-sub override → global config → built-in default.
 *
 * 链接独立成版式部件,模板里没有链接变量(2026-09 起不再替旧模板剥 `{link}` / `-link`:
 * 写了就原样出现,请从模板里删掉)。
 */
function resolveCustomLive(
	subCustom: CustomLiveMsgLike,
	globalCustom: CustomLiveMsgLike | undefined,
	field: "customLiveStart" | "customLiveStreaming" | "customLiveEnd",
	fallback: string,
): string {
	return subCustom[field] ?? globalCustom?.[field] ?? fallback;
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
		return renderLiveText("liveStart", tmpl, {
			name: params.master.username,
			time: params.diffTime,
			follower: params.followerNum,
		});
	}

	/** Compose the "正在直播" notification text(周期推送与重启补报共用). */
	renderLiveStreaming(params: {
		sub: SubItemView;
		globalCustom?: CustomLiveMsgLike;
		master: MasterInfo;
		diffTime: string;
		/** 本场累计观看(精确数);缺了(一帧都没收到)文案里印「暂未获取到」。 */
		watched: number | undefined;
	}): string {
		const tmpl = resolveCustomLive(
			params.sub.customLiveMsg,
			params.globalCustom,
			"customLiveStreaming",
			DEFAULT_LIVE_TEMPLATES.liveStreaming,
		);
		return renderLiveText("liveStreaming", tmpl, {
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
		return renderLiveText("liveEnd", tmpl, {
			name: params.master.username,
			time: params.diffTime,
			followerChange: params.followerChange,
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
