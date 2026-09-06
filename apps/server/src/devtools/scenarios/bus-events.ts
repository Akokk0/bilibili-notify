import type { MessageBus } from "@bilibili-notify/internal";
import type { DevScenarioDef } from "../registry.js";

/**
 * A5:引擎错误 / 登录失效 / 登录恢复 —— 直接往 MessageBus 上**发射**一条事件。
 *
 * 发射不是转发:这里没有第二条通道,不存在「bus ↔ 别的通道」的回环(那条铁律见
 * `runtime/message-bus.ts`)。消费方全是真的:`engine-error` → 主人私聊 + 面板右上角告警;
 * `auth-lost` → 动态检测停摆、直播监听拆掉、主人私聊;`auth-restored` → 各引擎按当前订阅
 * 重新播种。所以 lost 之后记得 restored,不然引擎就真的停在那儿了。
 */
export interface BusEventDeps {
	bus: MessageBus;
}

const SOURCES = [
	{ value: "live-engine", label: "live-engine · 直播" },
	{ value: "dynamic-engine", label: "dynamic-engine · 动态" },
	{ value: "push", label: "push · 推送" },
	{ value: "image", label: "image · 渲染" },
	{ value: "ai", label: "ai · AI" },
	{ value: "link-parser", label: "link-parser · 链接解析" },
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
			deps.bus.emit("engine-error", source, message);
			return { summary: `已发射 engine-error(${source})。` };
		},
	};

	const authLost: DevScenarioDef = {
		id: "auth.lost",
		group: "event",
		title: "登录失效",
		icon: "logout",
		desc: "往总线上发 auth-lost:动态检测停摆、直播监听拆掉、主人收私聊、面板顶栏变未登录。引擎会真的停 —— 看完记得发「登录恢复」。",
		params: [],
		run() {
			deps.bus.emit("auth-lost");
			return { summary: "已发射 auth-lost。引擎现在停着,看完记得发「登录恢复」。" };
		},
	};

	const authRestored: DevScenarioDef = {
		id: "auth.restored",
		group: "event",
		title: "登录恢复",
		icon: "check",
		desc: "往总线上发 auth-restored:各引擎按当前订阅重新播种(动态 cron 重启、直播重连)。",
		params: [],
		run() {
			deps.bus.emit("auth-restored");
			return { summary: "已发射 auth-restored,引擎重新播种。" };
		},
	};

	return [engineError, authLost, authRestored];
}
