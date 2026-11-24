import type {
	ExtensionContext,
	ExtensionSourceContext,
	SourceDef,
} from "@bilibili-notify/extension";
import type { WeiboAccount } from "./account";
import { record } from "./client";
import { type FeedPost, feedPost, postReport } from "./posts";

interface Baseline {
	at: number;
	ids: Set<string>;
}
interface Watch {
	ready: boolean;
	life: AbortController;
	pending: Map<string, FeedPost>;
}
interface Scan {
	watched: Map<string, Watch>;
	cursor: string;
	visited: Set<string>;
	posts: Map<string, FeedPost>;
	newest?: Baseline;
	complete: boolean;
}

function feedPage(data: Record<string, unknown>) {
	if (!Array.isArray(data.statuses)) return;
	const posts: FeedPost[] = [];
	for (const value of data.statuses) {
		const row = record(value);
		if (Number(row.isTop) === 1) continue;
		const post = feedPost(row);
		// Don't advance past a post whose identity or timestamp we could not read.
		if (!post) return;
		posts.push(post);
	}
	const raw = data.since_id_str ?? data.since_id ?? "0";
	if (typeof raw !== "string" && !Number.isSafeInteger(raw)) return;
	return { posts, next: String(raw) };
}

function newest(previous: Baseline | undefined, posts: FeedPost[]): Baseline {
	const next = { at: previous?.at ?? -Infinity, ids: new Set(previous?.ids) };
	for (const { time, id } of posts) {
		if (time > next.at) {
			next.at = time;
			next.ids.clear();
		}
		if (time === next.at) next.ids.add(id);
	}
	if (!Number.isFinite(next.at)) next.at = Math.floor(Date.now() / 1000) * 1000;
	return next;
}

function watchFeed(ctx: ExtensionContext, source: ExtensionSourceContext, account: WeiboAccount) {
	const life = new AbortController();
	const watchers = new Map<string, Watch>();
	let baseline: Baseline | undefined;
	let scan: Scan | undefined;
	let owner: string | undefined;
	let running: AbortController | undefined;
	function reconcile() {
		const wasWatching = watchers.size > 0;
		const wanted = new Set(
			source
				.subscriptions()
				.filter((s) => s.features.has("post"))
				.map((s) => s.externalId),
		);
		let added = false;
		for (const [id, watch] of watchers)
			if (!wanted.has(id)) {
				watch.life.abort();
				watchers.delete(id);
			}
		for (const id of wanted) {
			if (watchers.has(id)) continue;
			watchers.set(id, { ready: false, life: new AbortController(), pending: new Map() });
			added = true;
		}
		if (wasWatching && !watchers.size) {
			running?.abort();
			running = undefined;
			baseline = undefined;
			scan = undefined;
			source.resolveProblem({ code: "weibo_feed", notify: false });
		}
		return added;
	}
	async function poll(uid: string, signal: AbortSignal) {
		scan ??= {
			watched: new Map(watchers),
			cursor: "0",
			visited: new Set(),
			posts: new Map(),
			complete: false,
			newest: baseline,
		};
		const batch = scan;
		const list = `11000${uid}`;
		for (let pages = 0; !batch.complete && pages < 3; pages++) {
			const result = await account.get(
				"/ajax/feed/friendstimeline",
				{ list_id: list, fid: list, since_id: batch.cursor, count: "25", refresh: "4" },
				signal,
			);
			if (signal.aborted || scan !== batch) return;
			if (!result.ok) {
				if (
					!["unauthorized", "rate_limited", "indeterminate"].includes(result.code) &&
					result.upstreamCode !== "weibo.verify"
				)
					source.reportProblem({ code: "weibo_feed", message: result.message });
				return;
			}
			const page = feedPage(result.data);
			if (!page) {
				source.reportProblem({ code: "weibo_feed", message: ctx.i18n.t("request.unavailable") });
				return;
			}
			batch.newest = newest(batch.newest, page.posts);
			for (const post of page.posts) {
				if (!baseline || !batch.watched.get(post.uid)?.ready) continue;
				if (post.time > baseline.at || (post.time === baseline.at && !baseline.ids.has(post.id)))
					batch.posts.set(post.id, post);
			}
			const through = baseline?.at ?? batch.newest.at;
			batch.complete =
				!page.next || page.next === "0" || page.posts.some((post) => post.time < through);
			batch.visited.add(batch.cursor);
			if (!batch.complete && batch.visited.has(page.next)) {
				scan = undefined;
				source.reportProblem({ code: "weibo_feed", message: ctx.i18n.t("feed.cursor") });
				return;
			}
			batch.cursor = page.next;
		}
		if (batch.complete) {
			for (const post of batch.posts.values()) {
				const watch = batch.watched.get(post.uid);
				if (watch && !watch.life.signal.aborted) watch.pending.set(post.id, post);
			}
			baseline = batch.newest;
			for (const watch of batch.watched.values()) watch.ready = true;
			scan = undefined;
		}
		// A completed timeline page can advance even when an individual post still needs its detail.
		const pending = [...watchers.values()].flatMap((watch) => [...watch.pending.values()]);
		let failed = false;
		for (const post of pending.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) {
			const watch = watchers.get(post.uid);
			if (!watch?.pending.has(post.id)) continue;
			const result = await postReport(
				ctx,
				account,
				post,
				AbortSignal.any([signal, watch.life.signal]),
			);
			if (signal.aborted) return;
			if (watch.life.signal.aborted) continue;
			if (!result.ok) {
				if (
					["rate_limited", "unauthorized", "indeterminate"].includes(result.code) ||
					result.upstreamCode === "weibo.verify"
				)
					return;
				failed = true;
				source.reportProblem({ code: "weibo_feed", message: result.message });
				continue;
			}
			source.reportPost(post.uid, result.report);
			watch.pending.delete(post.id);
		}
		if (batch.complete && !failed && watchers.size) source.resolveProblem({ code: "weibo_feed" });
	}
	function tick() {
		const uid = account.uid();
		if (!uid || !watchers.size || life.signal.aborted || running) return;
		if (owner !== uid) {
			baseline = undefined;
			scan = undefined;
			for (const watch of watchers.values()) watch.pending.clear();
			owner = uid;
		}
		const current = new AbortController();
		running = current;
		const signal = AbortSignal.any([
			current.signal,
			life.signal,
			source.signal,
			ctx.signal,
			account.sessionSignal(),
		]);
		void poll(uid, signal)
			.catch(() => {
				if (!signal.aborted)
					source.reportProblem({ code: "weibo_feed", message: ctx.i18n.t("request.unavailable") });
			})
			.finally(() => {
				if (running === current) running = undefined;
			});
	}
	const changes = source.onSubscriptionsChanged(() => {
		if (reconcile()) tick();
	});
	let available = account.uid();
	const login = account.auth.onChange(() => {
		const uid = account.uid();
		if (uid === available) return;
		available = uid;
		if (uid) tick();
	});
	const timer = ctx.setInterval(tick, 60000);
	reconcile();
	tick();
	return () => {
		life.abort();
		timer.dispose();
		changes.dispose();
		login.dispose();
	};
}

export function createFeed(
	ctx: ExtensionContext,
	account: WeiboAccount,
): Pick<SourceDef, "start" | "stop"> {
	let stop: (() => void) | undefined;
	return {
		start(source) {
			stop?.();
			stop = watchFeed(ctx, source, account);
			source.onDispose(stop);
		},
		stop() {
			stop?.();
			stop = undefined;
		},
	};
}
