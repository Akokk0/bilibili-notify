import type {
	Disposable,
	ExtensionContext,
	ExtensionSourceContext,
	Failure,
} from "@bilibili-notify/extension";
import type { createDirectory } from "./creators";
import { type Observation, transition } from "./live";

interface Watch {
	uid: string;
	controller: AbortController;
	next: number;
	failures: number;
	previous?: Observation;
}
const minute = 60000;

export function monitor(
	ctx: ExtensionContext,
	source: ExtensionSourceContext,
	directory: ReturnType<typeof createDirectory>,
	signal: AbortSignal,
) {
	const watches = new Map<string, Watch>();
	let timer: Disposable | undefined;
	let checking = false;

	function failed(watch: Watch, failure: Failure) {
		watch.failures++;
		if (failure.code !== "rate_limited" && failure.upstreamCode !== "huya.verify") {
			source.reportProblem({ externalId: watch.uid, code: "huya_room", message: failure.message });
		}
	}
	async function check(watch: Watch) {
		const scoped = AbortSignal.any([signal, source.signal, watch.controller.signal]);
		const room = await directory.lookup(watch.uid, scoped);
		if (scoped.aborted) return;
		if (!room.ok) return failed(watch, room);
		const profile = await directory.profileOf(room, scoped);
		if (scoped.aborted) return;
		if (profile.ok) {
			const { ok: _, ...fields } = profile;
			source.reportProfile(watch.uid, fields);
		}
		const result = await directory.observationOf(room, scoped);
		if (scoped.aborted) return;
		if (!result.ok) return failed(watch, result);
		watch.failures = 0;
		source.resolveProblem({ externalId: watch.uid, code: "huya_room" });
		const { latest, reports } = transition(watch.previous, result.observation);
		for (const report of reports) {
			if (!scoped.aborted) source.reportLive(watch.uid, report);
		}
		watch.previous = latest;
	}
	function schedule() {
		timer?.dispose();
		if (checking || signal.aborted || source.signal.aborted) return;
		let first: Watch | undefined;
		for (const watch of watches.values()) if (!first || watch.next < first.next) first = watch;
		if (!first) return;
		const watch = first;
		timer = ctx.setTimeout(
			async () => {
				checking = true;
				try {
					await check(watch);
				} catch (error) {
					if (!watch.controller.signal.aborted && !signal.aborted)
						ctx.logger.warn(ctx.i18n.t("request.unavailable"), error);
				} finally {
					checking = false;
					watch.next = Date.now() + minute * 2 ** Math.max(0, Math.min(watch.failures - 1, 4));
					schedule();
				}
			},
			Math.max(0, first.next - Date.now()),
		);
	}
	function reconcile() {
		const ids = new Set(
			source
				.subscriptions()
				.filter((sub) => sub.monitorsLive)
				.map((sub) => sub.externalId),
		);
		for (const [uid, watch] of watches) {
			if (ids.has(uid)) continue;
			watch.controller.abort();
			watches.delete(uid);
			source.resolveProblem({ externalId: uid, code: "huya_room", notify: false });
		}
		for (const uid of ids)
			if (!watches.has(uid))
				watches.set(uid, { uid, controller: new AbortController(), next: Date.now(), failures: 0 });
		schedule();
	}
	const subscriptions = source.onSubscriptionsChanged(reconcile);
	reconcile();
	return {
		dispose() {
			subscriptions.dispose();
			timer?.dispose();
			for (const watch of watches.values()) watch.controller.abort();
			watches.clear();
		},
	};
}
