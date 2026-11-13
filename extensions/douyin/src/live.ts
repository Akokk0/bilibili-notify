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
	const rooms = object(object(result.data).data).data;
	if (!Array.isArray(rooms)) return unknown();
	const room = rooms.map(object).find((room) => room.id_str === roomId);
	if (
		room?.status !== 2 ||
		(object(room.owner).sec_uid && object(room.owner).sec_uid !== user.sec_uid)
	)
		return unknown();
	const cover = await image(ctx, room.cover, signal);
	if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
	const start = count(room.start_time);
	const startedAt =
		start && start <= 253402300799 ? new Date(start * 1000).toISOString() : undefined;
	const currentViewers = count(room.user_count);
	const title = text(room.title);
	const details: ExtensionLiveDetails = {
		url: `https://live.douyin.com/${webRid}`,
		...(title && { title }),
		...(cover && { cover }),
		...(currentViewers !== undefined && { currentViewers }),
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
