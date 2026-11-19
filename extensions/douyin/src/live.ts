import {
	type ExtensionContext,
	type ExtensionLiveDetails,
	type ExtensionLiveSignalReport,
	type ExtensionLiveStatusResult,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import { count, image, object, text } from "./media";
import type { DouyinSourceClient } from "./source";

export type LiveObservation =
	| { kind: "offline" }
	| { kind: "live"; roomId: string; startedAt?: string; details: ExtensionLiveDetails };

/** 直播间有些数字只给字符串，像「5万+」的展示值没有精确读数。 */
function exactCount(value: unknown): number | undefined {
	return count(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
}

export async function observeLive(
	ctx: ExtensionContext,
	client: DouyinSourceClient,
	user: Record<string, unknown>,
	signal: AbortSignal,
): Promise<Result<{ observation: LiveObservation }>> {
	const unknown = () => fail("unavailable", ctx.i18n.t("error.live"));
	if (user.live_status === 0) return ok({ observation: { kind: "offline" as const } });
	if (user.live_status !== 1) return unknown();
	let data = user.room_data;
	if (typeof data === "string") {
		try {
			data = JSON.parse(data);
		} catch {
			return unknown();
		}
	}
	const webRid = text(object(object(data).owner).web_rid);
	const roomId = text(user.room_id_str);
	if (!webRid || !/^\d+$/.test(webRid) || !roomId || !/^\d+$/.test(roomId)) return unknown();
	const result = await client.room(webRid, roomId, signal);
	if (!result.ok) return result;
	const payload = object(object(result.data).data);
	const rooms = payload.data;
	if (!Array.isArray(rooms)) return unknown();
	const room = rooms.map(object).find((room) => room.id_str === roomId);
	if (
		room?.status !== 2 ||
		(object(room.owner).sec_uid && object(room.owner).sec_uid !== user.sec_uid)
	)
		return unknown();
	const cover = await image(ctx, room.cover, signal);
	if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
	const start = exactCount(room.start_time);
	const startedAt =
		start && start <= 253402300799 ? new Date(start * 1000).toISOString() : undefined;
	const partitions = object(payload.partition_road_map);
	const category =
		text(object(object(partitions.sub_partition).partition).title) ??
		text(object(partitions.partition).title);
	const stats = object(room.stats);
	const currentViewers =
		exactCount(room.user_count) ??
		exactCount(stats.user_count_str) ??
		exactCount(room.user_count_str);
	const totalViewers = exactCount(stats.total_user) ?? exactCount(stats.total_user_str);
	const title = text(room.title);
	const details: ExtensionLiveDetails = {
		url: `https://live.douyin.com/${webRid}`,
		...(title && { title }),
		...(cover && { cover }),
		...(category && { category }),
		...(currentViewers !== undefined && { currentViewers }),
		...(totalViewers !== undefined && { totalViewers }),
	};
	return ok({
		observation: { kind: "live" as const, roomId, details, ...(startedAt && { startedAt }) },
	});
}

export function liveStatus(observation: LiveObservation): ExtensionLiveStatusResult {
	if (observation.kind === "offline") return ok({ kind: "offline" as const });
	const { roomId: _, ...status } = observation;
	return ok(status);
}

export function liveChanges(
	previous: LiveObservation | undefined,
	next: LiveObservation,
): ExtensionLiveSignalReport[] {
	if (!previous)
		return [
			next.kind === "offline"
				? { kind: "status", isLive: false, details: {} }
				: { kind: "status", isLive: true, startedAt: next.startedAt, details: next.details },
		];
	if (previous.kind === "live" && next.kind === "live" && previous.roomId === next.roomId)
		return [];
	const changes: ExtensionLiveSignalReport[] = [];
	if (previous.kind === "live")
		changes.push({ kind: "end", startedAt: previous.startedAt, details: previous.details });
	if (next.kind === "live")
		changes.push({ kind: "start", startedAt: next.startedAt, details: next.details });
	return changes;
}
