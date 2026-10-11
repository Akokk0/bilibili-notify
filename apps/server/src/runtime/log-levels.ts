import type { Disposable } from "@bilibili-notify/internal";
import type { ConfigStore } from "../config/store.js";
import type { NodeServiceContext } from "./service-context.js";

/**
 * 把核心设置里的日志等级接到上下文上:当场推一次,之后 `level` / `levels` 变了再推。
 * 入口在配置读完之后立刻调,所以引擎与登录系统起步时各日志器的等级已经是设置里那一格。
 *
 * 门开在 `level` 与 `levels` 两格上,**不要写成整段 `logging` 比**:保留天数、内存自检开关各有各的读法,不在这里热推。
 */
export function bindLogLevels(opts: {
	serviceCtx: Pick<NodeServiceContext, "applyLogLevels">;
	configStore: Pick<ConfigStore, "getGlobals" | "onChange">;
}): Disposable {
	const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
	const apply = (): { level: string; levels: Record<string, string> } => {
		const { level, levels } = opts.configStore.getGlobals().logging;
		opts.serviceCtx.applyLogLevels({ level, levels });
		return { level, levels };
	};
	let last = apply();
	return opts.configStore.onChange((scope) => {
		if (scope !== "globals") return;
		const { level, levels } = opts.configStore.getGlobals().logging;
		if (eq(last.level, level) && eq(last.levels, levels)) return;
		last = apply();
	});
}
