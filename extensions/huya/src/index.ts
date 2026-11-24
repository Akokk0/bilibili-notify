import type { ExtensionContext } from "@bilibili-notify/extension";
import { createClient } from "./client";
import { createDirectory } from "./creators";
import { liveStatus } from "./live";
import { monitor } from "./monitor";

export function activate(ctx: ExtensionContext): void {
	const directory = createDirectory(ctx, createClient(ctx));
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
			const current = monitor(ctx, source, directory, scoped(source.signal));
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
			const result = await directory.observationOf(room, signal, started);
			if (!result.ok) return result;
			running?.noteHostStatus(identity.externalId, result.observation);
			return liveStatus(result.observation);
		},
	});
}
