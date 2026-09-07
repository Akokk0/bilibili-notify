import type { ResourceSample, ResourceStatic, ResourcesHydrate } from "@bilibili-notify/contract";
import { useEffect, useState } from "react";
import type { WsEnvelope } from "../services/ws";
import { onWsEvent, subscribeChannels, unsubscribeChannels } from "../services/wsSingleton";

/**
 * `resources` 频道 —— 概览页「系统资源」卡的数据源。
 *
 * 只在卡挂着时订阅,离开这一页就退订(服务端据此决定还量不量,浏览器子树那一项要起
 * 子进程)。断线重连时服务端会重新 hydrate,不用这边补什么。
 */

/**
 * 前端留多少个样本:5 分钟 ÷ 2 秒 = 150,与服务端缓冲同长。
 * 这一页可以开着一整天,不封顶就是一个一路涨的数组。
 */
export const HISTORY_KEEP = 150;

export interface ResourcesState {
	/** 还没收到 hydrate 时是 null —— 卡按「读取中」画。 */
	static: ResourceStatic | null;
	history: ResourceSample[];
}

export const EMPTY_RESOURCES: ResourcesState = { static: null, history: [] };

/**
 * 一条 envelope 落地成新状态。纯函数,好在测试里直接喂帧。
 *
 * 认不出的帧**原样返回同一个对象**,别造一个内容相同的新对象 —— React 靠引用判重渲染。
 */
export function reduceResources(
	state: ResourcesState,
	env: { event: string; data: unknown },
): ResourcesState {
	if (env.event === "hydrate") {
		const data = env.data as ResourcesHydrate;
		// 整份换掉,不与断线前的接在一起:断线那几分钟是空的,拼起来的曲线会把一段
		// 不存在的平直读成「稳定」。
		return { static: data.static, history: data.history.slice(-HISTORY_KEEP) };
	}
	if (env.event === "sample") {
		// 没有静态量就算不出占比(堆上限从 hydrate 来),画出来的环是假的 —— 丢掉。
		if (!state.static) return state;
		const history = [...state.history, env.data as ResourceSample];
		return {
			static: state.static,
			history: history.length > HISTORY_KEEP ? history.slice(-HISTORY_KEEP) : history,
		};
	}
	return state;
}

/**
 * 订阅 `resources` 频道并把帧落进本地状态。挂载即订、卸载即退订。
 */
export function useResourcesChannel(): ResourcesState {
	const [state, setState] = useState<ResourcesState>(EMPTY_RESOURCES);
	useEffect(() => {
		subscribeChannels(["resources"]);
		const off = onWsEvent((env: WsEnvelope) => {
			if (env.type !== "resources") return;
			// WsEnvelope 的 event 是可选的(不信任服务端形状那一层的防御);没有 event
			// 的帧本来就落不了地,给个空串走到 reducer 的兜底分支。
			setState((prev) => reduceResources(prev, { event: env.event ?? "", data: env.data }));
		});
		return () => {
			off();
			// 退订是有意义的:服务端只在有人订着时才采浏览器子树(要起子进程)。
			unsubscribeChannels(["resources"]);
		};
	}, []);
	return state;
}
