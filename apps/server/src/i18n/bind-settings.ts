import type { Disposable } from "@bilibili-notify/internal";
import { type I18n, type Locale, textSettingsOf } from "@bilibili-notify/internal/i18n";
import type { ConfigStore } from "../config/store.js";

/**
 * 把核心设置里的语言与口吻接到字典 store 上:当场推一次,之后核心设置一变就再推。
 * 入口在配置读完之后立刻调,所以登录系统与引擎起步时说的话已经是设置里的语言。
 *
 * 收的是 store 的 `set` 而不是 store 本身:入口写 `(change) => i18n.set(change)`,
 * 取字调用的守卫(`scripts/__tests__/i18n-call-sites.test.mjs`)只认 `i18n.set(…)` 这种用法,不许把单例当值递。
 * 不自己比旧值:核心的 `set` 没变就什么也不做,比值只在那一处。缺的格由 `textSettingsOf` 按规则补。
 */
export function bindTextSettings(opts: {
	set: I18n<string, Locale>["set"];
	configStore: Pick<ConfigStore, "getGlobals" | "onChange">;
}): Disposable {
	const apply = (): void => opts.set(textSettingsOf(opts.configStore.getGlobals()));
	apply();
	return opts.configStore.onChange((scope) => {
		if (scope === "globals") apply();
	});
}
