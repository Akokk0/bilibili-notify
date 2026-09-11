import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels } from "../services/wsSingleton";

/**
 * 处理 `state` 频道单条 envelope。两种帧:
 *   - `hydrate`(订阅时 + 重连后立即发一次):无脑 invalidate 全部三类 query,让
 *     断线期间错过的 globals/subs/targets 变化能在重连后自动重 fetch — 这是 WS
 *     重连唯一的"赶上 missed change"机制(WS 不重放历史事件)。
 *   - `config-changed`(运行时配置写入):按 scope 精准 invalidate 单一 query。
 *
 *   - `extension-changed`(拓展喊 `ctx.statusChanged`):按 id 失效 ["extension-status", id] 与
 *     ["extension-bots", id] —— 桥那头握完手,拓展页与连接编辑器当场刷新,不用切页。
 *
 * Server scopes (`config-changed.scope`):
 *   - "subscriptions" → invalidate ["subscriptions"]
 *   - "targets"       → invalidate ["targets"]
 *   - "globals"       → invalidate ["globals"]
 *   - "connections"   → invalidate ["connections"]
 *   - "secrets"       → no client cache, ignored
 *
 * 提取成 export 纯函数让测试能注入测试用 QueryClient(`new QueryClient()`),
 * 不需要渲染 hook + Provider 整套。
 */
export function handleStateEnvelope(env: WsEnvelope, qc: QueryClient): void {
	if (env.type !== "state") return;
	if (env.event === "hydrate") {
		qc.invalidateQueries({ queryKey: ["globals"] });
		qc.invalidateQueries({ queryKey: ["subscriptions"] });
		qc.invalidateQueries({ queryKey: ["targets"] });
		// 连接表与拓展表同样是服务端会改的东西(私聊指令建连接、拓展热装卸),而断线期间
		// 的那些变化没有帧会重放 —— 漏掉哪张,哪张就一直停在断线那一刻,界面还一切正常。
		qc.invalidateQueries({ queryKey: ["connections"] });
		qc.invalidateQueries({ queryKey: ["extensions"] });
		// 断线期间连上 / 断开的桥没有帧会重放,重连时整个前缀一起失效。
		qc.invalidateQueries({ queryKey: ["extension-status"] });
		qc.invalidateQueries({ queryKey: ["extension-bots"] });
		return;
	}
	// 拓展喊了「面板数据变了」:只失效那个拓展的 status 与 bot 名单,让页面自己重取。
	if (env.event === "extension-changed") {
		const id = (env.data as { id?: unknown } | undefined)?.id;
		if (typeof id !== "string" || id === "") return;
		qc.invalidateQueries({ queryKey: ["extension-status", id] });
		qc.invalidateQueries({ queryKey: ["extension-bots", id] });
		return;
	}
	if (env.event !== "config-changed") return;
	const scope = (env.data as { scope?: string } | undefined)?.scope;
	if (scope === "subscriptions") qc.invalidateQueries({ queryKey: ["subscriptions"] });
	else if (scope === "targets") qc.invalidateQueries({ queryKey: ["targets"] });
	else if (scope === "globals") qc.invalidateQueries({ queryKey: ["globals"] });
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
