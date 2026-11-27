import type {
	Disposable,
	ExtensionContext,
	ExtensionSourceContext,
	Failure,
} from "@bilibili-notify/extension";
import type { createDirectory } from "./creators";
import {
	endReport,
	type Observation,
	type ReadMetrics,
	type RoomMetrics,
	sameSession,
	transition,
} from "./live";
import { listen, type RoomNotice } from "./socket";

type Directory = ReturnType<typeof createDirectory>;
const minute = 60000;

function watchRoom(
	ctx: ExtensionContext,
	source: ExtensionSourceContext,
	directory: Directory,
	uid: string,
	needsRoomProbe: () => boolean,
	parent: AbortSignal,
) {
	const life = new AbortController();
	const signal = AbortSignal.any([parent, life.signal]);
	let previous: Observation | undefined;
	let sessionRevision = 0;
	let hint: { kind: "live" | "offline"; sessionId?: string; until: number } | undefined;
	let socket: Disposable | undefined;
	let reconnect: Disposable | undefined;
	let retryCount = 0;
	let timer: Disposable | undefined;
	let reading = false,
		queued = false;
	let failures = 0;
	const metrics = new Map<keyof RoomMetrics, { value: number; at: number }>();
	const readMetrics: ReadMetrics = (current) => {
		if (
			previous?.kind !== "live" ||
			!sameSession(previous, current) ||
			!((previous.sessionId && current.sessionId) || (previous.startedAt && current.startedAt))
		)
			return;
		const fresh: RoomMetrics = {};
		for (const [key, stat] of metrics)
			if (Date.now() - stat.at < 2 * minute) fresh[key] = stat.value;
		return fresh;
	};
	function refresh(delay = 0) {
		if (signal.aborted) return;
		if (reading && delay === 0) {
			queued = true;
			return;
		}
		timer?.dispose();
		timer = ctx.setTimeout(run, delay);
	}
	function failed(failure: Failure) {
		if (failure.code !== "rate_limited" && failure.upstreamCode !== "huya.verify")
			source.reportProblem({ externalId: uid, code: "huya_room", message: failure.message });
		refresh(minute * 2 ** Math.min(failures++, 4));
	}
	function notice(event: RoomNotice) {
		switch (event.kind) {
			case "vipViewers":
			case "heatScore":
				if (previous?.kind === "live" && !hint) {
					metrics.set(event.kind, { value: event.value, at: Date.now() });
					previous = { ...previous, details: { ...previous.details, [event.kind]: event.value } };
				}
				return;
			case "live":
			case "offline":
				metrics.clear();
				hint = { ...event, until: Date.now() + 90000 };
		}
		refresh();
	}
	function disconnected() {
		socket = undefined;
		metrics.clear();
		if (signal.aborted) return;
		source.reportProblem({
			externalId: uid,
			code: "huya_socket",
			message: ctx.i18n.t("live.disconnected"),
			notify: false,
		});
		reconnect = ctx.setTimeout(
			() => {
				reconnect = undefined;
				connect();
			},
			Math.min(minute * 5, 5000 * 2 ** Math.min(retryCount++, 6)),
		);
	}
	function connect() {
		if (signal.aborted || socket || reconnect) return;
		if (needsRoomProbe()) {
			refresh(minute);
			return;
		}
		socket = listen(ctx, uid, signal, {
			ready() {
				source.resolveProblem({ externalId: uid, code: "huya_socket" });
				hint = undefined;
				refresh();
			},
			heartbeat() {
				retryCount = 0;
			},
			notice,
			disconnected,
		});
		if (!socket) disconnected();
	}
	async function check() {
		const started = Date.now();
		const expected = hint;
		const revision = sessionRevision;
		const room = await directory.lookup(uid, signal);
		if (signal.aborted) return;
		if (!room.ok) return failed(room);
		const profile = await directory.profileOf(room, signal);
		if (signal.aborted) return;
		if (profile.ok) {
			const { ok: _, ...fields } = profile;
			source.reportProfile(uid, fields);
		}
		const result = await directory.observationOf(room, signal, started, previous, readMetrics);
		if (signal.aborted) return;
		if (!result.ok) return failed(result);
		failures = 0;
		source.resolveProblem({ externalId: uid, code: "huya_room" });
		connect();
		if (expected !== hint || revision !== sessionRevision) return;
		// 虎牙房间资料有缓存；收到切换通知后给同一场状态一点时间追上。
		const current = result.observation;
		if (
			expected &&
			Date.now() < expected.until &&
			(current.kind !== expected.kind ||
				(current.kind === "live" && expected.sessionId && current.sessionId !== expected.sessionId))
		) {
			refresh(10000);
			return;
		}
		hint = undefined;
		const { latest, reports } = transition(previous, result.observation);
		if (
			latest.kind !== previous?.kind ||
			(latest.kind === "live" && previous?.kind === "live" && !sameSession(previous, latest))
		) {
			sessionRevision++;
			metrics.clear();
		}
		previous = latest;
		for (const report of reports) {
			if (signal.aborted) return;
			source.reportLive(uid, report);
		}
	}
	async function run() {
		if (signal.aborted) return;
		reading = true;
		try {
			await check();
		} catch (error) {
			if (!signal.aborted) {
				ctx.logger.warn(ctx.i18n.t("request.unavailable"), error);
				refresh(minute);
			}
		} finally {
			reading = false;
			if (queued) {
				queued = false;
				refresh();
			}
		}
	}
	function cleanup() {
		timer?.dispose();
		reconnect?.dispose();
		socket?.dispose();
	}
	signal.addEventListener("abort", cleanup, { once: true });
	refresh();
	return {
		readMetrics,
		get sessionRevision() {
			return sessionRevision;
		},
		noteHostStatus(current: Observation, revision: number | undefined) {
			if (!previous || signal.aborted || revision !== sessionRevision) return;
			if (previous.kind === "live" && current.kind === "offline") {
				const report = endReport(previous);
				previous = current;
				sessionRevision++;
				metrics.clear();
				if (hint?.kind === "offline") hint = undefined;
				const endedAt = new Date().toISOString();
				source.reportLive(uid, { ...report, endedAt });
				refresh();
			} else if (
				previous.kind === "live" &&
				current.kind === "live" &&
				sameSession(previous, current)
			) {
				const details = { ...previous.details };
				for (const key of ["heatScore", "vipViewers"] as const) {
					const value = current.details[key];
					if (value !== undefined) details[key] = value;
				}
				previous = { ...previous, details };
			} else if (current.kind === "live") {
				refresh();
			}
		},
		dispose() {
			life.abort();
		},
	};
}

export function monitor(
	ctx: ExtensionContext,
	source: ExtensionSourceContext,
	directory: Directory,
	needsRoomProbe: () => boolean,
	signal: AbortSignal,
) {
	const watches = new Map<string, ReturnType<typeof watchRoom>>();
	function reconcile() {
		const ids = new Set(
			source
				.subscriptions()
				.filter((sub) => sub.monitorsLive)
				.map((sub) => sub.externalId),
		);
		for (const [uid, watch] of watches) {
			if (ids.has(uid)) continue;
			watch.dispose();
			watches.delete(uid);
			for (const code of ["huya_room", "huya_socket"])
				source.resolveProblem({ externalId: uid, code, notify: false });
		}
		for (const uid of ids)
			if (!watches.has(uid))
				watches.set(uid, watchRoom(ctx, source, directory, uid, needsRoomProbe, signal));
	}
	const subscriptions = source.onSubscriptionsChanged(reconcile);
	reconcile();
	return {
		room(uid: string) {
			return watches.get(uid);
		},
		dispose() {
			subscriptions.dispose();
			for (const watch of watches.values()) watch.dispose();
			watches.clear();
		},
	};
}
