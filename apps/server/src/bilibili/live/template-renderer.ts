import { DEFAULT_LIVE_TEMPLATES, renderLiveText } from "../../live/live-text";
import type { CustomLiveMsgLike } from "../../live/live-types";
import type { SubItemView } from "./push-like";
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
}
