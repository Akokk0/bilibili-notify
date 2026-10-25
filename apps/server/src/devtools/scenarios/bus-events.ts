import type { MessageBus } from "@bilibili-notify/internal";
import type { DevScenarioDef } from "../registry.js";

/**
 * A5:直接往 MessageBus 上**发射**一条引擎错误。
 *
 * 发射不是转发:这里没有第二条通道,不存在「bus ↔ 别的通道」的回环(那条铁律见
 * `runtime/message-bus.ts`)。消费方是真的:`engine-error` → 主人私聊 + 面板右上角告警。
 */
export interface BusEventDeps {
	bus: MessageBus;
}

const SOURCES = [
	{ value: "live-engine", label: "live-engine · 直播" },
	{ value: "post-delivery", label: "post-delivery · 作品投递" },
	{ value: "push", label: "push · 推送" },
	{ value: "image", label: "image · 渲染" },
	{ value: "ai", label: "ai · AI" },
	{ value: "link-previewer", label: "link-previewer · 链接预览" },
];

const DEFAULT_MESSAGE = "devtools 造的一条引擎错误 —— 看主人私聊与右上角告警。";

export function busEventScenarios(deps: BusEventDeps): DevScenarioDef[] {
	const engineError: DevScenarioDef = {
		id: "engine.error",
		group: "event",
		title: "引擎错误",
		icon: "warning",
		desc: "往总线上发一条 engine-error:主人会收到私聊,面板右上角出告警条。",
		params: [
			{ key: "source", label: "来源", kind: "enum", options: SOURCES, default: "live-engine" },
			{ key: "message", label: "正文", kind: "text", default: DEFAULT_MESSAGE },
		],
		run(params) {
			const source = String(params.source ?? "live-engine");
			const message =
				typeof params.message === "string" && params.message !== ""
					? params.message
					: DEFAULT_MESSAGE;
			deps.bus.emit("engine-error", { source, message });
			return { summary: `已发射 engine-error(${source})。` };
		},
	};

	return [engineError];
}
