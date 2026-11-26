import {
	type Disposable,
	type ExtensionContext,
	type ExtensionSourceContext,
	type Failure,
	fail,
	type Result,
	type SourceDef,
	type WebSocketLike,
} from "@bilibili-notify/extension";
import { createCreatorDirectory } from "./creators";
import {
	type LiveObservation,
	type LiveRoom,
	liveChanges,
	liveStatus,
	observeLive,
	sameRoom,
} from "./live";
import { watchRoomSocket } from "./live-socket";
import { type PostBaseline, readPosts } from "./posts";

type ApiResponse = Promise<Result<{ data: unknown }>>;
export interface DouyinSourceClient {
	sessionSignal?(): AbortSignal;
	observe?(source: ExtensionSourceContext | undefined): void;
	profile(id: string, signal: AbortSignal): ApiResponse;
	account(id: string, signal: AbortSignal): ApiResponse;
	search(keyword: string, signal: AbortSignal): ApiResponse;
	posts(id: string, cursor: string, signal: AbortSignal): ApiResponse;
	room(webRid: string, roomId: string, signal: AbortSignal): ApiResponse;
	openLiveSocket(
		roomId: string,
		viewerId: string,
		signal: AbortSignal,
	): Result<{ socket: WebSocketLike }>;
	expand(url: URL, signal: AbortSignal): Promise<Result<{ url: URL }>>;
}

interface LiveWatcher {
	controller: AbortController;
	/** Identifies transitions independently of updates to the room details. */
	revision: number;
	observation?: LiveObservation;
	ended?: LiveRoom;
	socket?: Disposable & { signal: AbortSignal };
}

interface Watcher {
	controller: AbortController;
	posts?: { controller: AbortController; baseline?: PostBaseline };
	live?: LiveWatcher;
}

function afterSocketEnd(
	observation: LiveObservation,
	ended: LiveRoom | undefined,
): LiveObservation {
	return observation.kind === "live" && ended && sameRoom(observation, ended)
		? { kind: "offline" }
		: observation;
}

export function createDouyinSource(ctx: ExtensionContext, client: DouyinSourceClient) {
	const directory = createCreatorDirectory(ctx, client);
	let life: AbortController | undefined;
	let timer: Disposable | undefined;
	let changes: Disposable | undefined;
	let running: Promise<void> | undefined;
	let active: ExtensionSourceContext | undefined;
	const pending = new Set<string>();
	const watchers = new Map<string, Watcher>();

	// Bind a whole operation (including pagination and image downloads) to the
	// account that started it, even when the transport has finished its first call.
	function requestSignal(...signals: AbortSignal[]) {
		const account = client.sessionSignal?.();
		if (account) signals.push(account);
		if (life) signals.push(life.signal);
		return AbortSignal.any([ctx.signal, ...signals]);
	}

	function stop() {
		life?.abort();
		timer?.dispose();
		changes?.dispose();
		for (const entry of watchers.values()) entry.controller.abort();
		watchers.clear();
		pending.clear();
		active = undefined;
		running = undefined;
		client.observe?.(undefined);
	}
	function reconcile() {
		if (!active || !life || life.signal.aborted) return;
		const subs = new Map(active.subscriptions().map((sub) => [sub.externalId, sub]));
		for (const [id, entry] of watchers) {
			if (subs.has(id)) continue;
			entry.controller.abort();
			if (entry.live) resolveSocketProblem(active, id);
			watchers.delete(id);
			pending.delete(id);
		}
		for (const [id, sub] of subs) {
			const postEnabled = sub.features.has("post");
			const liveEnabled = sub.monitorsLive;
			let entry = watchers.get(id);
			if (entry && Boolean(entry.posts) === postEnabled && Boolean(entry.live) === liveEnabled)
				continue;
			if (!entry) {
				entry = { controller: new AbortController() };
				watchers.set(id, entry);
			}
			if (postEnabled !== Boolean(entry.posts)) {
				entry.posts?.controller.abort();
				entry.posts = postEnabled ? { controller: new AbortController() } : undefined;
			}
			if (liveEnabled !== Boolean(entry.live)) {
				entry.live?.controller.abort();
				entry.live = liveEnabled ? { controller: new AbortController(), revision: 0 } : undefined;
				if (!liveEnabled) resolveSocketProblem(active, id);
			}
			pending.add(id);
		}
	}
	function resolveSocketProblem(source: ExtensionSourceContext, id: string) {
		source.resolveProblem({ externalId: id, code: "douyin_live_socket", notify: false });
	}
	function noteLive(
		source: ExtensionSourceContext,
		id: string,
		entry: Watcher,
		observed: LiveObservation,
	) {
		const live = entry.live;
		if (!live) return;
		const previous = live.observation;
		const next = afterSocketEnd(observed, live.ended);
		// A cached observation of the ended room must not stop a newer room.
		if (observed.kind === "live" && next.kind === "offline" && previous?.kind === "live") return;
		const matched = previous?.kind === "live" && next.kind === "live" && sameRoom(previous, next);
		if (!matched || live.socket?.signal.aborted) {
			live.socket?.dispose();
			live.socket = undefined;
		}
		live.observation = matched
			? {
					...next,
					startedAt: next.startedAt ?? previous.startedAt,
					details: { ...previous.details, ...next.details },
				}
			: next;
		const changes = liveChanges(previous, next);
		if (changes.length > 0) live.revision++;
		for (const change of changes) source.reportLive(id, change);
		if (next.kind !== "live") {
			if (previous?.kind === "live") resolveSocketProblem(source, id);
			return;
		}
		if (live.socket) return;
		const unavailable = () =>
			source.reportProblem({
				externalId: id,
				code: "douyin_live_socket",
				message: ctx.i18n.t("live.socketUnavailable"),
				notify: false,
			});
		if (!next.viewerId) return unavailable();
		const signal = requestSignal(source.signal, entry.controller.signal, live.controller.signal);
		if (signal.aborted) return;
		const viewerId = next.viewerId;
		const listener = watchRoomSocket(
			ctx,
			() => client.openLiveSocket(next.roomId, viewerId, signal),
			next.roomId,
			signal,
			{
				ready: () => resolveSocketProblem(source, id),
				interaction(report) {
					if (!signal.aborted) source.reportLiveInteraction?.(id, report);
				},
				unavailable,
				ended() {
					const ended = live.observation;
					if (signal.aborted || ended?.kind !== "live" || !sameRoom(ended, next)) return;
					live.ended = ended;
					live.observation = { kind: "offline" };
					live.revision++;
					listener.dispose();
					live.socket = undefined;
					resolveSocketProblem(source, id);
					source.reportLive(id, {
						kind: "end",
						endedAt: new Date().toISOString(),
						startedAt: ended.startedAt,
						details: ended.details,
					});
				},
			},
		);
		live.socket = { ...listener, signal };
	}
	function record<T extends { ok: true } | Failure>(
		id: string,
		area: string,
		result: T,
		signal: AbortSignal,
	): T {
		if (!active || signal.aborted) return result;
		const code = `douyin_${area}`;
		const status: { ok: true } | Failure = result;
		if (status.ok) {
			active.resolveProblem({ externalId: id, code });
			return result;
		}
		const failure = status;
		if (
			failure.code === "unauthorized" ||
			["douyin.verify", "douyin.cooldown", "douyin.signature"].includes(
				String(failure.upstreamCode),
			)
		)
			return result;
		active.reportProblem({ externalId: id, code, message: failure.message });
		return result;
	}
	async function poll(source: ExtensionSourceContext, session: AbortSignal) {
		while (!session.aborted) {
			const { value: id, done } = pending.values().next();
			if (done) break;
			pending.delete(id);
			const entry = watchers.get(id);
			if (!entry) continue;
			const signal = requestSignal(session, source.signal, entry.controller.signal);
			if (signal.aborted) continue;
			const { live, posts: postWatch } = entry;
			const liveRevision = live?.revision;
			const found = await directory.lookup(id, signal);
			if (signal.aborted) continue;
			if (found.ok) {
				const info = record(id, "profile", await directory.profile(found.user, signal), signal);
				if (signal.aborted) continue;
				if (info.ok) {
					const { ok: _, ...report } = info;
					source.reportProfile(id, report);
				}
				if (live && !signal.aborted && !live.controller.signal.aborted) {
					const liveSignal = AbortSignal.any([signal, live.controller.signal]);
					const observed = record(
						id,
						"live",
						await observeLive(ctx, client, found.user, liveSignal),
						liveSignal,
					);
					if (!liveSignal.aborted && observed.ok && live.revision === liveRevision)
						noteLive(source, id, entry, observed.observation);
				}
			} else record(id, "profile", found, signal);
			if (!postWatch) continue;
			const postSignal = AbortSignal.any([signal, postWatch.controller.signal]);
			if (postSignal.aborted) continue;
			const posts = record(
				id,
				"posts",
				await readPosts(ctx, client, id, postWatch.baseline, postSignal),
				postSignal,
			);
			if (postSignal.aborted) continue;
			if (posts.ok) {
				for (const report of posts.reports) {
					if (postSignal.aborted) break;
					source.reportPost(id, report);
				}
				postWatch.baseline = posts.baseline;
			}
		}
	}
	function tick(checkAll = true) {
		if (!active || !life || life.signal.aborted) return;
		reconcile();
		if (running) return running;
		if (checkAll) for (const id of watchers.keys()) pending.add(id);
		if (!pending.size) return;

		const session = life;
		running = poll(active, session.signal)
			.catch(() => {
				if (!session.signal.aborted) ctx.logger.warn(ctx.i18n.t("error.poll"));
			})
			.finally(() => {
				if (life === session) {
					running = undefined;
					if (pending.size) return tick(false);
				}
			});
		return running;
	}
	return {
		start(source) {
			if (active) stop();
			active = source;
			life = new AbortController();
			client.observe?.(source);
			changes = source.onSubscriptionsChanged(() => {
				void tick(false);
			});
			timer = ctx.setInterval(tick, 10 * 60 * 1000);
			source.onDispose(() => {
				if (active === source) stop();
			});
			void tick();
		},
		stop,
		searchCreators(query, signal) {
			const request = requestSignal(signal);
			return request.aborted
				? Promise.resolve(fail("indeterminate", ctx.i18n.t("error.stopped")))
				: directory.searchCreators(query, request);
		},
		async fetchLiveStatus(identity, signal) {
			const { externalId } = identity;
			const entry = watchers.get(externalId);
			const live = entry?.live;
			const liveRevision = live?.revision;
			signal = requestSignal(
				signal,
				...(entry ? [entry.controller.signal] : []),
				...(live ? [live.controller.signal] : []),
			);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
			const found = await directory.lookup(externalId, signal);
			if (!found.ok) return record(externalId, "live", found, signal);
			const observed = record(
				externalId,
				"live",
				await observeLive(ctx, client, found.user, signal),
				signal,
			);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
			if (live?.observation && live.revision !== liveRevision) return liveStatus(live.observation);
			if (!observed.ok) return observed;
			if (entry && live && active) {
				noteLive(active, externalId, entry, observed.observation);
				if (live.observation) return liveStatus(live.observation);
			}
			return liveStatus(observed.observation);
		},
		async fetchProfile(identity, signal) {
			signal = requestSignal(signal);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
			const found = await directory.lookup(identity.externalId, signal);
			return record(
				identity.externalId,
				"profile",
				found.ok ? await directory.profile(found.user, signal) : found,
				signal,
			);
		},
	} satisfies SourceDef;
}
