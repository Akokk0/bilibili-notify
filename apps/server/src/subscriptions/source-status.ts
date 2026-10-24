import type { SourceRegistry } from "./registry.js";

/** 「来源在跑吗」。这一片只答在不在跑;`failed` / `settings-invalid` 随 3a-39。 */
export interface SourceStatusReader {
	running(sourceKey: string): boolean;
}

export function createSourceStatusReader(opts: {
	sources: Pick<SourceRegistry, "get">;
}): SourceStatusReader {
	return {
		running: (sourceKey) => opts.sources.get(sourceKey) !== undefined,
	};
}
