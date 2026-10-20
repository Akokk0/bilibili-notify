/**
 * B 站房间数据 → 中立直播详情。推送、预览与来源上报都从这一份翻译出发，
 * 不再各自拼直播卡输入。
 */

import { htmlToPlain } from "@bilibili-notify/image";
import type { LiveDetails, PostImage } from "@bilibili-notify/internal";
import { DateTime } from "luxon";
import { buildRoomLink } from "./template-renderer.js";

/** B 站 `live_time`（恒为北京时间）→ ISO；缺失或占位零值回 `undefined`。 */
export function liveTimeToIso(raw: string | LiveRoomFields | undefined): string | undefined {
	const value = typeof raw === "string" ? raw : raw?.live_time;
	if (typeof value !== "string" || value === "") return undefined;
	const at = DateTime.fromFormat(value, "yyyy-MM-dd HH:mm:ss", { zone: "UTC+8" });
	return at.isValid ? (at.toUTC().toISO() ?? undefined) : undefined;
}

export type LiveRoomFields = Readonly<Record<string, unknown>>;

const text = (value: unknown): string =>
	value === undefined || value === null ? "" : String(value);

function countOf(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function present<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, cell]) => cell !== undefined)) as T;
}

export function liveDetailsFromRoomInfo(
	data: LiveRoomFields | null | undefined,
	opts: {
		coverRef?: PostImage["ref"];
		totalViewers?: number;
		status?: "start" | "streaming" | "offline";
	} = {},
): LiveDetails {
	const roomCover = text(data?.user_cover);
	const keyframe = text(data?.keyframe);
	const coverUrl = opts.status === "streaming" ? keyframe || roomCover : roomCover || keyframe;
	const cover: PostImage | undefined =
		coverUrl === ""
			? undefined
			: {
					url: coverUrl,
					...(opts.coverRef === undefined ? {} : { ref: opts.coverRef }),
				};
	const shortId = countOf(data?.short_id);
	const roomId = countOf(data?.room_id);
	return present({
		title: text(data?.title) || undefined,
		cover,
		category: text(data?.area_name) || undefined,
		url:
			shortId !== undefined || roomId !== undefined
				? buildRoomLink({ short_id: shortId ?? 0, room_id: roomId ?? 0 })
				: undefined,
		currentViewers: countOf(data?.online),
		totalViewers: opts.totalViewers,
		description: data ? htmlToPlain(text(data.description)) : undefined,
	});
}
