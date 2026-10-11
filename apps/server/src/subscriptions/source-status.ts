import type { ExtensionSourceReader } from "../runtime/extension-push-common.js";
import type { SourceRegistry } from "./registry.js";

/** 「来源在跑吗」。这一片只答在不在跑;`failed` / `settings-invalid` 随 3a-39。 */
export interface SourceStatusReader {
	running(sourceKey: string): boolean;
}

export function createSourceStatusReader(opts: {
	sources: Pick<SourceRegistry, "get">;
	/** 拓展订阅来源还没登进这张表(3b),它们在不在跑问装载器;不给 = 没接拓展订阅。 */
	extensions?: Pick<ExtensionSourceReader, "running">;
}): SourceStatusReader {
	return {
		running: (sourceKey) =>
			opts.sources.get(sourceKey) !== undefined || (opts.extensions?.running(sourceKey) ?? false),
	};
}
