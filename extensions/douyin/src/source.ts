import {
	type Disposable,
	type ExtensionContext,
	type ExtensionSourceContext,
	type Failure,
	fail,
	type Result,
	type SourceDef,
} from "@bilibili-notify/extension";
import { createCreatorDirectory } from "./creators";
import { type LiveObservation, liveChanges, liveStatus, observeLive } from "./live";
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
	expand(url: URL, signal: AbortSignal): Promise<Result<{ url: URL }>>;
}

export function createDouyinSource(ctx: ExtensionContext, client: DouyinSourceClient) {
	const directory = createCreatorDirectory(ctx, client);
	let life: AbortController | undefined;
	let timer: Disposable | undefined;
	let changes: Disposable | undefined;
	let running: Promise<void> | undefined;
	let active: ExtensionSourceContext | undefined;
	const pending = new Set<string>();
	const watchers = new Map<
		string,
		{
			controller: AbortController;
			posts?: PostBaseline;
			postEnabled: boolean;
			liveEnabled: boolean;
			live?: LiveObservation;
		}
	>();

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
			watchers.delete(id);
			pending.delete(id);
		}
		for (const [id, sub] of subs) {
			const postEnabled = sub.features.has("post");
			const liveEnabled = sub.monitorsLive;
			const existing = watchers.get(id);
			if (existing?.postEnabled === postEnabled && existing.liveEnabled === liveEnabled) continue;
			existing?.controller.abort();
			watchers.set(id, {
				postEnabled,
				liveEnabled,
				controller: new AbortController(),
				posts: postEnabled ? existing?.posts : undefined,
				live: liveEnabled ? existing?.live : undefined,
			});
			pending.add(id);
		}
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
					if (observed.ok) {
						for (const change of liveChanges(entry.live, observed.observation)) {
							if (signal.aborted) break;
							source.reportLive(id, change);
						}
						entry.live = observed.observation;
					}
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
			signal = requestSignal(signal);
			if (signal.aborted) return fail("indeterminate", ctx.i18n.t("error.stopped"));
			const found = await directory.lookup(identity.externalId, signal);
			if (!found.ok) return record(identity.externalId, "live", found, signal);
			const observed = record(
				identity.externalId,
				"live",
				await observeLive(ctx, client, found.user, signal),
				signal,
			);
			return observed.ok ? liveStatus(observed.observation) : observed;
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
