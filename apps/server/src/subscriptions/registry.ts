import type { Disposable, Source, SourceContext } from "@bilibili-notify/internal";
import { createRegistry } from "../integrations/registry.js";
import { stopQuietly } from "../integrations/stop-quietly.js";
import { errorMessageOf } from "../util/error-message.js";

/** 登记表对外给的来源视图:不含 start / stop(启停只归登记表)。今天就是 `{ descriptor }`。 */
export type SourceView = Omit<Source, "start" | "stop">;

/**
 * 订阅来源的登记表:一个来源键一个主人。
 */
export interface SourceRegistry {
	/**
	 * 认领键 → `await source.start(ctx)` → 回一个撤下它的把手。键被占了就抛;`start` 抛了:
	 * 把键放掉、错原样抛出去(登记失败不留半个)。把手 `dispose`:放键,再调 `source.stop()`
	 * (不等它,失败只记 warn)。
	 */
	register(sourceKey: string, source: Source, ctx: SourceContext): Promise<Disposable>;
	/** 现在谁认领着这个键;没人 = undefined。 */
	get(sourceKey: string): SourceView | undefined;
}

export function createSourceRegistry(): SourceRegistry {
	const table = createRegistry<SourceView>(
		(key) => `source for key "${key}" is already registered`,
	);
	return {
		get: (sourceKey) => table.get(sourceKey),
		async register(sourceKey, source, ctx) {
			const claim = table.claim(sourceKey, { descriptor: source.descriptor });
			try {
				await source.start(ctx);
			} catch (err) {
				claim.dispose();
				throw err;
			}
			let removed = false;
			return {
				dispose() {
					if (removed) return;
					removed = true;
					claim.dispose();
					stopQuietly(
						() => source.stop(),
						(err) => ctx.logger.warn(`[source] ${sourceKey} stop 失败: ${errorMessageOf(err)}`),
					);
				},
			};
		},
	};
}
