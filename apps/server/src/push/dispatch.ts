import {
	type Connection,
	fail,
	ok,
	type PlatformAdapter,
	type Result,
} from "@bilibili-notify/internal";
import { t as serverText } from "../i18n/index.js";
import { resolveSettings } from "./connection-settings.js";

/**
 * 「这条连接归矩阵里的谁管」—— 按连接的 `adapterKey` 找,不按消息里报的平台名找。
 *
 * 桥后面挂着 telegram 时,入站帧报的平台是 `telegram`,而认领它的 adapter 的键是拓展 id ——
 * 拿平台名去问就找不到,而且是**静默**找不到:症状是「群里贴了链接没回卡」,日志上却写着
 * 「连接不存在」。内置的 webhook 那一族(飞书 / 钉钉 / 企微 / 通用)四个平台共用 `"webhook"` 这一个键。
 *
 * 「哪个 adapter 管这条连接」全仓只此一份 —— 推送热路径(`createTargetDispatcher`)也是每次
 * 现问这个函数,不另存索引:拓展是后加载的,拨一下开关就会来去(ADR-0012 决策 29)。
 */
export function adapterForConnection<T extends { readonly adapterKey: string }>(
	adapters: readonly T[],
	connection: Connection,
): T | undefined {
	return adapters.find((adapter) => adapter.adapterKey === connection.adapterKey);
}

/**
 * 找到适配器、并把 `settings` 按它的 `settingsSchema` 解好 —— 回出去的连接,`settings` 是解过的输出。
 * 没有适配器回 `unavailable`(拓展是后加载的,「暂时没有」);设置过不了规则回 `not_configured`
 * (要主人先去改好,等是等不好的)。
 *
 * 所有把连接递给适配器的入口都走它:漏一个就是把盘上原文(可能缺默认值)当成解过的值用。
 */
export function routeConnection<T extends Pick<PlatformAdapter, "adapterKey" | "settingsSchema">>(
	adapters: readonly T[],
	connection: Connection,
): Result<{ adapter: T; connection: Connection }> {
	const found = findAdapter(adapters, connection);
	if (!found.ok) return found;
	return resolveConnection(found.adapter, connection);
}

/** 两步里的第一步:找适配器。没有回 `unavailable`(拓展是后加载的,「暂时没有」)。 */
export function findAdapter<T extends { readonly adapterKey: string }>(
	adapters: readonly T[],
	connection: Connection,
): Result<{ adapter: T }> {
	const adapter = adapterForConnection(adapters, connection);
	if (!adapter) return fail("unavailable", `no platform adapter for ${connection.adapterKey}`);
	return ok({ adapter });
}

/** 两步里的第二步:把 `settings` 按适配器的规则解好。过不了回 `not_configured`。 */
export function resolveConnection<T extends Pick<PlatformAdapter, "settingsSchema">>(
	adapter: T,
	connection: Connection,
): Result<{ adapter: T; connection: Connection }> {
	const resolved = resolveSettings(adapter.settingsSchema, connection.settings);
	if (!resolved.ok) {
		return fail(
			"not_configured",
			serverText("service.push.dispatch.text.1", { value0: resolved.message }),
			{ issues: resolved.issues },
		);
	}
	return ok({ adapter, connection: { ...connection, settings: resolved.settings } });
}
