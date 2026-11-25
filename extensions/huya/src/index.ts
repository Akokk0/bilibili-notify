import type { ExtensionContext } from "@bilibili-notify/extension";
import { createClient } from "./client";
import { createDirectory } from "./creators";
import { liveStatus } from "./live";
import { monitor } from "./monitor";

export function activate(ctx: ExtensionContext): void {
	const client = createClient(ctx);
	const directory = createDirectory(ctx, client);
	let life = new AbortController();
	let running: ReturnType<typeof monitor> | undefined;
	const scoped = (signal: AbortSignal) => AbortSignal.any([ctx.signal, life.signal, signal]);
	function stop() {
		life.abort();
		running?.dispose();
		running = undefined;
	}
	ctx.registerSource({
		start(source) {
			if (running) stop();
			if (life.signal.aborted) life = new AbortController();
			const current = monitor(ctx, source, directory, client.needsRoomProbe, scoped(source.signal));
			running = current;
			source.onDispose(() => {
				if (running === current) stop();
			});
		},
		stop,
		searchCreators: (query, signal) => directory.searchCreators(query, scoped(signal)),
		fetchProfile: (identity, signal) => directory.fetchProfile(identity, scoped(signal)),
		async fetchLiveStatus(identity, signal) {
			const started = Date.now();
			signal = scoped(signal);
			const room = await directory.lookup(identity.externalId, signal);
			if (!room.ok) return room;
			const watch = running?.room(identity.externalId);
			const result = await directory.observationOf(
				room,
				signal,
				started,
				undefined,
				watch?.readMetrics,
			);
			if (!result.ok) return result;
			watch?.noteHostStatus(result.observation);
			return liveStatus(result.observation);
		},
	});
}
