import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isWsEvent, type WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";
import { SOURCE_AUTH_QUERY_PREFIX } from "./use-source-auth";
import {
	EXTENSION_BOTS_QUERY_PREFIX,
	EXTENSION_SETTINGS_QUERY_PREFIX,
	EXTENSION_STATUS_QUERY_PREFIX,
	EXTENSIONS_QUERY_KEY,
	extensionBotsKey,
	extensionSettingsKey,
	extensionStatusKey,
} from "./useExtensions";
import { SUBSCRIPTION_TAGS_QUERY_KEY } from "./useSubscriptionTags";

/**
 * 处理 `state` 频道单条 envelope。两种帧:
 *   - `hydrate`(订阅时 + 重连后立即发一次):无脑 invalidate 全部三类 query,让
 *     断线期间错过的 globals/subs/targets 变化能在重连后自动重 fetch — 这是 WS
 *     重连唯一的"赶上 missed change"机制(WS 不重放历史事件)。
 *   - `config-changed`(运行时配置写入):按 scope 精准 invalidate 单一 query。
 *
 *   - `extension-status-changed`(拓展喊 `ctx.statusChanged`):按 `extensionId` 失效那个拓展的状态与 bot 名单
 *     (键从 `useExtensions` 取,与读的那几处同一份)—— 桥那头握完手,拓展页与连接编辑器当场
 *     刷新,不用切页。
 *   - `extension-settings-changed`(设置经 `/api/ext/:id/settings` 写进去了,ADR-0019 决策 35):
 *     按 `extensionId` 失效那个拓展的设置与视图 —— 别的标签页改了名单,这一页当场换上,不用等撞 409。
 *   - `extension-report-discrepancies-changed`(服务端给某个拓展新记了「上报出入」,ADR-0019 决策 60):
 *     只失效拓展表 —— 详情页那个框住在拓展表的那一行上。
 *
 * Server scopes (`config-changed.scope`):
 *   - "subscriptions" → invalidate ["subscriptions"] + 订阅标签表(标签表与订阅同一档,ADR-0034:
 *     PUT 标签表删掉某个标签时订阅上的 id 在同一次写里被去掉,两边一起过期才不会画出悬空的 id)
 *   - "targets"       → invalidate ["targets"]
 *   - "globals"       → invalidate ["settings"] + 拓展表(拓展的开关住在 globals 里)
 *   - "integration-settings" → invalidate ["settings"](各集成的设置挂在 `/api/settings` 下发的那一份里)+ 各拓展的
 *     设置(拓展的设置也是这一档:备份恢复、卸载这类不经设置口的写只发它)
 *   - "connections"   → invalidate ["connections"]
 *   - "secrets"       → no client cache, ignored
 *
 * 另有 `subscription-profiles-changed`(拓展报的资料落进了资料缓存,ADR-0019 决策 7 / 62):失效订阅
 * 列表 —— 资料不是配置,服务端不为它发 `config-changed`。
 *
 * 另有 `problems-changed`(问题表变了):失效订阅列表 —— 每条订阅带着问题表里关于它的那几条。
 *
 * 提取成 export 纯函数让测试能注入测试用 QueryClient(`new QueryClient()`),
 * 不需要渲染 hook + Provider 整套。
 */
export function handleStateEnvelope(env: WsEnvelope, qc: QueryClient): void {
	if (isWsEvent(env, "state", "hydrate")) {
		qc.invalidateQueries({ queryKey: ["settings"] });
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		qc.invalidateQueries({ queryKey: ["targets"] });
		// 标签表同样可能在断线期间被别的标签页(或备份恢复)换掉,没有帧会重放。
		qc.invalidateQueries({ queryKey: SUBSCRIPTION_TAGS_QUERY_KEY });
		// 连接表与拓展表同样是服务端会改的东西(私聊指令建连接、拓展热装卸),而断线期间
		// 的那些变化没有帧会重放 —— 漏掉哪张,哪张就一直停在断线那一刻,界面还一切正常。
		qc.invalidateQueries({ queryKey: ["connections"] });
		qc.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY });
		// 断线期间连上 / 断开的桥没有帧会重放,重连时整个前缀一起失效。
		qc.invalidateQueries({ queryKey: EXTENSION_STATUS_QUERY_PREFIX });
		qc.invalidateQueries({ queryKey: EXTENSION_BOTS_QUERY_PREFIX });
		qc.invalidateQueries({ queryKey: EXTENSION_SETTINGS_QUERY_PREFIX });
		// 各来源的登录状态同理:`auth` 频道的帧也不重放,断线期间登出 / 失效 / 换号都得靠这一步补回来。
		qc.invalidateQueries({ queryKey: SOURCE_AUTH_QUERY_PREFIX });
		return;
	}
	// 拓展喊了「面板数据变了」:只失效那个拓展的 status 与 bot 名单,让页面自己重取。
	if (isWsEvent(env, "state", "extension-status-changed")) {
		const id = env.data?.extensionId;
		if (typeof id !== "string" || id === "") return;
		qc.invalidateQueries({ queryKey: extensionStatusKey(id) });
		qc.invalidateQueries({ queryKey: extensionBotsKey(id) });
		return;
	}
	// 服务端给某个拓展新记了「上报出入」(ADR-0019 决策 60):那个框住在拓展表的那一行上,只让拓展表
	// 过期 —— 视图没变,不去重读它。
	if (isWsEvent(env, "state", "extension-report-discrepancies-changed")) {
		qc.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY });
		return;
	}
	// 拓展的设置写进去了:失效那个拓展的设置与视图(视图可能跟着设置变,宿主不替拓展判)。
	// 帧里只有拓展 id —— 设置里有密钥,不进帧。
	if (isWsEvent(env, "state", "extension-settings-changed")) {
		const id = env.data?.extensionId;
		if (typeof id !== "string" || id === "") return;
		qc.invalidateQueries({ queryKey: extensionSettingsKey(id) });
		qc.invalidateQueries({ queryKey: extensionStatusKey(id) });
		return;
	}
	// 拓展报的资料(名字 / 头像 / 粉丝)落进了资料缓存:订阅列表重取。帧里的订阅 id 不必看 —— 资料是
	// join 进整张表回来的,单拉哪几条没有口。
	if (isWsEvent(env, "state", "subscription-profiles-changed")) {
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		return;
	}
	// 问题表变了:每条订阅带着名下的问题,订阅列表重取。帧里的报告人不必看 —— 问题是 join 进整张表回来的。
	if (isWsEvent(env, "state", "problems-changed")) {
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		return;
	}
	if (!isWsEvent(env, "state", "config-changed")) return;
	const scope = env.data?.scope;
	if (scope === "subscriptions") {
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		qc.invalidateQueries({ queryKey: SUBSCRIPTION_TAGS_QUERY_KEY });
	} else if (scope === "targets") qc.invalidateQueries({ queryKey: ["targets"] });
	else if (scope === "integration-settings") {
		qc.invalidateQueries({ queryKey: ["settings"] });
		// 拓展的设置各在自己的文件里,改了发的是这一档(ADR-0021 决策 42 下 10-01 的 🔗)。备份恢复、卸载这类不经
		// 设置口的写只发这一档;不跟着过期的话,这一页照旧画着旧名单,直到下一发拿着旧版本号撞 409。经设置口写的
		// 那一发会多失效一次 —— 只有开着的那一页真去重读,换一个不漏。
		qc.invalidateQueries({ queryKey: EXTENSION_SETTINGS_QUERY_PREFIX });
	} else if (scope === "globals") {
		qc.invalidateQueries({ queryKey: ["settings"] });
		// 拓展的开关(`enabled`)住在 globals 里,拓展页 / 详情页吃的却是拓展表那一口:别的标签页
		// 把拓展关了,只重读 globals 的话,这一页还把它画成「跑着」,状态那一口的 404 被当成「没交
		// 视图」,卡上一片空白。
		qc.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY });
	}
	// 服务端建 / 改 / 删连接都发这一档(config/store.ts 三处);不接的话别处改了连接,
	// 这一页要等 staleTime 过去或切页才知道。
	else if (scope === "connections") qc.invalidateQueries({ queryKey: ["connections"] });
}

/**
 * Subscribes to the WS `state` channel and invalidates relevant queries when
 * the server reports a config change. Mounted once at the app root so the
 * cache stays fresh across pages without each page re-subscribing.
 */
export function useStateChannel(): void {
	const qc = useQueryClient();
	useEffect(() => {
		subscribeChannels(["state"]);
		return onWsEvent((env) => handleStateEnvelope(env, qc));
	}, [qc]);
}
