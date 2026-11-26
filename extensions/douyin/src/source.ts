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

interface Watcher {
	controller: AbortController;
	posts?: PostBaseline;
	postEnabled: boolean;
	liveEnabled: boolean;
	live?: LiveObservation;
	ended?: LiveRoom;
	socket?: Disposable & { signal: AbortSignal };
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
			if (entry.liveEnabled) resolveSocketProblem(active, id);
			watchers.delete(id);
			pending.delete(id);
		}
		for (const [id, sub] of subs) {
			const postEnabled = sub.features.has("post");
			const liveEnabled = sub.monitorsLive;
			const existing = watchers.get(id);
			if (existing?.postEnabled === postEnabled && existing.liveEnabled === liveEnabled) continue;
			existing?.controller.abort();
			if (existing?.liveEnabled && !liveEnabled) resolveSocketProblem(active, id);
			watchers.set(id, {
				postEnabled,
				liveEnabled,
				controller: new AbortController(),
				posts: postEnabled ? existing?.posts : undefined,
				live: liveEnabled ? existing?.live : undefined,
				ended: liveEnabled ? existing?.ended : undefined,
			});
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
		const previous = entry.live;
		const next = afterSocketEnd(observed, entry.ended);
		// A cached observation of the ended room must not stop a newer room.
		if (observed.kind === "live" && next.kind === "offline" && previous?.kind === "live") return;
		const matched = previous?.kind === "live" && next.kind === "live" && sameRoom(previous, next);
		if (!matched || entry.socket?.signal.aborted) {
			entry.socket?.dispose();
			entry.socket = undefined;
		}
		entry.live = matched
			? {
					...next,
					startedAt: next.startedAt ?? previous.startedAt,
					details: { ...previous.details, ...next.details },
				}
			: next;
		for (const change of liveChanges(previous, next)) source.reportLive(id, change);
		if (next.kind !== "live") {
			if (previous?.kind === "live") resolveSocketProblem(source, id);
			return;
		}
		if (entry.socket) return;
		const unavailable = () =>
			source.reportProblem({
				externalId: id,
				code: "douyin_live_socket",
				message: ctx.i18n.t("live.socketUnavailable"),
				notify: false,
			});
		if (!next.viewerId) return unavailable();
		const signal = requestSignal(source.signal, entry.controller.signal);
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
					if (signal.aborted || entry.live?.kind !== "live" || !sameRoom(entry.live, next)) return;
					const ended = entry.live;
					entry.ended = ended;
					entry.live = { kind: "offline" };
					listener.dispose();
					entry.socket = undefined;
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
		entry.socket = { ...listener, signal };
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
			const previousLive = entry.live;
			const found = await directory.lookup(id, signal);
			if (signal.aborted) continue;
			if (found.ok) {
				const info = record(id, "profile", await directory.profile(found.user, signal), signal);
				if (signal.aborted) continue;
				if (info.ok) {
					const { ok: _, ...report } = info;
					source.reportProfile(id, report);
				}
				if (entry.liveEnabled && !signal.aborted) {
					const observed = record(
						id,
						"live",
						await observeLive(ctx, client, found.user, signal),
						signal,
					);
					if (signal.aborted) continue;
					if (observed.ok && entry.live === previousLive)
						noteLive(source, id, entry, observed.observation);
				}
			} else record(id, "profile", found, signal);
			if (!entry.postEnabled || signal.aborted) continue;
			const posts = record(
				id,
				"posts",
				await readPosts(ctx, client, id, entry.posts, signal),
				signal,
			);
			if (signal.aborted) continue;
			if (posts.ok) {
				for (const report of posts.reports) {
					if (signal.aborted) break;
					source.reportPost(id, report);
				}
				entry.posts = posts.baseline;
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
			const previous = entry?.live;
			signal = requestSignal(signal, ...(entry ? [entry.controller.signal] : []));
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
			if (entry?.live && entry.live !== previous) return liveStatus(entry.live);
			if (!observed.ok) return observed;
			if (entry?.liveEnabled && active) {
				noteLive(active, externalId, entry, observed.observation);
				if (entry.live) return liveStatus(entry.live);
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
