import {
	type ExtensionContext,
	type ExtensionLiveDetails,
	type ExtensionLiveSignalReport,
	type ExtensionLiveStatusResult,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import { decimal, record } from "./client";
import type { HuyaRoom } from "./creators";
import type { createImageReader } from "./images";
import { web } from "./pages";

export type Observation =
	| { kind: "offline" }
	| { kind: "live"; sessionId?: string; startedAt?: string; details: ExtensionLiveDetails };
export async function observe(
	ctx: ExtensionContext,
	room: HuyaRoom,
	signal: AbortSignal,
	readImage: ReturnType<typeof createImageReader>,
	deadline: number,
): Promise<Result<{ observation: Observation }>> {
	const { data } = room,
		live = record(data.liveData);
	const { liveStatus, realLiveStatus } = data;
	if (
		[data.isRoomPay, live.isSecret].some(
			(mark) => mark === true || mark === 1 || mark === "1" || mark === "true",
		)
	)
		return fail("unavailable", ctx.i18n.t("live.restricted"));
	if (liveStatus === realLiveStatus) {
		if (liveStatus === "OFF" || liveStatus === "REPLAY")
			return ok({ observation: { kind: "offline" as const } });
		if (liveStatus === "ON") {
			const seconds = Number(decimal(live.startTime));
			const startedAt =
				seconds <= 253402300799 ? new Date(seconds * 1000).toISOString() : undefined;
			const cover = await readImage(live.screenshot, signal, deadline);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
			const details: ExtensionLiveDetails = { url: `${web}/${room.number}` };
			if (typeof live.introduction === "string" && live.introduction.trim())
				details.title = live.introduction;
			if (typeof live.gameFullName === "string" && live.gameFullName.trim())
				details.category = live.gameFullName;
			if (cover) details.cover = cover;
			return ok({
				observation: { kind: "live" as const, sessionId: decimal(live.liveId), startedAt, details },
			});
		}
	}
	return fail("unavailable", ctx.i18n.t("live.unknown"));
}

export function liveStatus(value: Observation): ExtensionLiveStatusResult {
	if (value.kind === "offline") return ok({ kind: "offline" as const });
	return ok({
		kind: "live" as const,
		...(value.startedAt && { startedAt: value.startedAt }),
		details: value.details,
	});
}

function status(value: Observation): ExtensionLiveSignalReport {
	return value.kind === "offline"
		? { kind: "status", isLive: false, details: {} }
		: { kind: "status", isLive: true, startedAt: value.startedAt, details: value.details };
}

export function transition(
	previous: Observation | undefined,
	current: Observation,
): { latest: Observation; reports: ExtensionLiveSignalReport[] } {
	if (!previous) return { latest: current, reports: [status(current)] };
	if (current.kind === "live" && previous.kind === "live") {
		const different =
			previous.sessionId && current.sessionId
				? previous.sessionId !== current.sessionId
				: previous.startedAt && current.startedAt && previous.startedAt !== current.startedAt;
		if (!different) {
			const latest: Observation = {
				kind: "live",
				sessionId: current.sessionId ?? previous.sessionId,
				startedAt: current.startedAt ?? previous.startedAt,
				details: { ...previous.details, ...current.details },
			};
			const changed =
				latest.startedAt !== previous.startedAt ||
				(["title", "category", "url", "cover"] as const).some(
					(key) => latest.details[key] !== previous.details[key],
				);
			return { latest, reports: changed ? [status(latest)] : [] };
		}
	}
	const reports: ExtensionLiveSignalReport[] = [];
	if (previous.kind === "live")
		reports.push({ kind: "end", startedAt: previous.startedAt, details: previous.details });
	if (current.kind === "live")
		reports.push({ kind: "start", startedAt: current.startedAt, details: current.details });
	return { latest: current, reports };
}
