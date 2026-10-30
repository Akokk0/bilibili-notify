import type { SourceRunStatus } from "@bilibili-notify/contract";
import type { ExtensionEntry } from "../extensions/loader.js";
import type { SourceRegistry } from "./registry.js";

/** 业务入口的在册闸与展示用的运行状态:展示读宿主启动结论和拓展装载器,不让来源自报。 */
export interface SourceStatusReader {
	running(sourceKey: string): boolean;
	status(sourceKey: string): SourceRunStatus;
}

export function createSourceStatusReader(opts: {
	sources: Pick<SourceRegistry, "get" | "getRunView">;
	extensions?: () => readonly Pick<ExtensionEntry, "id" | "state">[];
}): SourceStatusReader {
	return {
		running: (sourceKey) => opts.sources.get(sourceKey) !== undefined,
		status: (sourceKey) =>
			opts.extensions?.().find((entry) => entry.id === sourceKey)?.state ??
			opts.sources.getRunView(sourceKey)?.status ??
			"unknown",
	};
}
