import type { PushAdapter, PushTarget } from "@bilibili-notify/internal";

/**
 * Simple in-memory adapter+target registry for the koishi side.
 * The standalone side uses ConfigStore; the koishi side synthesizes adapters
 * and targets from the legacy flat config and holds them here.
 */
export class TargetRegistry {
	private readonly adapters: Map<string, PushAdapter> = new Map();
	private readonly targets: Map<string, PushTarget> = new Map();

	// ---- targets ---------------------------------------------------------

	get(id: string): PushTarget | undefined {
		return this.targets.get(id);
	}

	set(target: PushTarget): void {
		this.targets.set(target.id, target);
	}

	delete(id: string): void {
		this.targets.delete(id);
	}

	all(): PushTarget[] {
		return [...this.targets.values()];
	}

	// ---- adapters --------------------------------------------------------

	setAdapter(adapter: PushAdapter): void {
		this.adapters.set(adapter.id, adapter);
	}

	getAdapter(id: string): PushAdapter | undefined {
		return this.adapters.get(id);
	}

	allAdapters(): PushAdapter[] {
		return [...this.adapters.values()];
	}

	// ---- lookup helpers --------------------------------------------------

	/** Find an existing koishi-bot adapter matching the (botPlatform, selfId?) pair. */
	findKoishiBotAdapter(botPlatform: string, selfId?: string): PushAdapter | undefined {
		for (const a of this.adapters.values()) {
			if (a.platform !== "koishi-bot") continue;
			if (a.config.botPlatform !== botPlatform) continue;
			if (selfId && a.config.selfId && a.config.selfId !== selfId) continue;
			return a;
		}
		return undefined;
	}

	/** Find a koishi-bot target on a given adapter + channel. */
	findTargetByChannel(adapterId: string, channelId: string): PushTarget | undefined {
		for (const t of this.targets.values()) {
			if (t.adapterId !== adapterId) continue;
			if (t.platform !== "koishi-bot") continue;
			if (t.session.channelId === channelId) return t;
		}
		return undefined;
	}

	clear(): void {
		this.adapters.clear();
		this.targets.clear();
	}
}
