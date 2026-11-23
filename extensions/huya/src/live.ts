import {
	type ExtensionContext,
	type ExtensionLiveDetails,
	type ExtensionLiveSignalReport,
	type ExtensionLiveStatusResult,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/extension";
import { count, decimal, type HuyaClient, record } from "./client";
import type { HuyaRoom } from "./creators";
import { type createImageReader, imageDeadline } from "./images";
import { web } from "./pages";

export type Observation =
	| { kind: "offline" }
	| { kind: "live"; sessionId?: string; startedAt?: string; details: ExtensionLiveDetails };

type LiveObservation = Extract<Observation, { kind: "live" }>;
function sameSession(previous: LiveObservation, current: LiveObservation): boolean {
	if (previous.sessionId && current.sessionId) return previous.sessionId === current.sessionId;
	return !previous.startedAt || !current.startedAt || previous.startedAt === current.startedAt;
}
export async function observe(
	ctx: ExtensionContext,
	room: HuyaRoom,
	signal: AbortSignal,
	readImage: ReturnType<typeof createImageReader>,
	client: HuyaClient,
	started: number,
	previous?: Observation,
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
			const details: ExtensionLiveDetails = { url: `${web}/${room.number}` };
			const observation: LiveObservation = {
				kind: "live",
				sessionId: decimal(live.liveId),
				startedAt,
				details,
			};
			const needsStats = previous?.kind !== "live" || !sameSession(previous, observation);
			const [cover, vipViewers] = await Promise.all([
				readImage(live.screenshot, signal, imageDeadline(started)),
				needsStats ? client.vipViewers(room.uid, signal, started + 12000) : undefined,
			]);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("request.cancelled"));
			const heatScore = count(live.totalCount);
			if (heatScore !== undefined) details.heatScore = heatScore;
			if (vipViewers !== undefined) details.vipViewers = vipViewers;
			if (typeof live.introduction === "string" && live.introduction.trim())
				details.title = live.introduction;
			if (typeof live.gameFullName === "string" && live.gameFullName.trim())
				details.category = live.gameFullName;
			if (cover) details.cover = cover;
			return ok({ observation });
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
	if (current.kind === "live" && previous.kind === "live" && sameSession(previous, current)) {
		const { heatScore: _heat, vipViewers: _vips, ...prior } = previous.details;
		const latest: Observation = {
			kind: "live",
			sessionId: current.sessionId ?? previous.sessionId,
			startedAt: current.startedAt ?? previous.startedAt,
			details: { ...prior, ...current.details },
		};
		const changed =
			latest.startedAt !== previous.startedAt ||
			(["title", "category", "url", "cover"] as const).some(
				(key) => latest.details[key] !== previous.details[key],
			);
		return { latest, reports: changed ? [status(latest)] : [] };
	}
	const reports: ExtensionLiveSignalReport[] = [];
	if (previous.kind === "live")
		reports.push({ kind: "end", startedAt: previous.startedAt, details: previous.details });
	if (current.kind === "live")
		reports.push({ kind: "start", startedAt: current.startedAt, details: current.details });
	return { latest: current, reports };
}
