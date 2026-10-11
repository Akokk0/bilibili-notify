/**
 * `/status` —— 手机上问一句「现在还好吗」。
 *
 * 这条消息只回答**一个**问题:系统正常吗。所以四项挑的都是「不正常时才有救的东西」:
 * 登录掉了 / 不抓了 / 推不出去 / 卡住了。方案里专门钉过别往里加订阅数、今日推送数
 * 之类 —— 这是在手机上看的,长了就没人读。
 *
 * 取数与渲染分开:{@link StatusReport} 是一份纯数据,渲染是纯函数。否则要验一句文案
 * 就得先起半个服务端。
 */

import type { AuthState, Logger } from "@bilibili-notify/internal";
import type { SourceView } from "../subscriptions/registry.js";
import { errorMessageOf } from "../util/error-message.js";
import { type CommandDef, command } from "./command-dispatcher.js";

/** 一次状态快照。字段少是刻意的,见文件头。 */
export interface StatusReport {
	/** 登录态(中立的 `AuthState`);登录系统还没起来是 `undefined`。一行人话由 {@link renderLogin} 按状态拼。 */
	login: AuthState | undefined;
	/**
	 * 在册来源各一行,次序就是登记先后:`label` 是平台名(描述符的 `label`),`summary` 是来源自己说的那句话
	 * (如「上次抓取 2 分钟前」)。取数见 {@link readSourceHealth}。
	 */
	sources: { label: string; summary: string }[];
	/** 排队等渲染的卡片数。持续不为 0 = 推送在堆积。 */
	renderQueue: number;
	connections: { name: string; ok: boolean }[];
	/** 全局静音到期时刻,`0` = 没静音。 */
	mutedUntil: number;
}

export interface StatusCommandOptions {
	probe: () => StatusReport;
	/** 可注入的时钟。测试用,生产不传。 */
	now?: () => number;
}

function renderConnections(connections: StatusReport["connections"]): string {
	// 一行空白看起来像功能坏了,而「还没配」是个明确的下一步。
	if (connections.length === 0) return "还没配连接";
	const down = connections.filter((a) => !a.ok);
	if (down.length === 0) return `${connections.length} 个都连着`;
	// 只点名断掉的那些 —— 连着的不需要主人做任何事。
	return `${down.map((a) => a.name).join("、")} 断了（共 ${connections.length} 个）`;
}

/** 登录态的一行人话。`confirming` 没带 `message` 时写「正在确认」。 */
export function renderLogin(state: AuthState | undefined): string {
	if (state === undefined) return "还没起来";
	switch (state.status) {
		case "logged-in":
			return "已登录";
		case "logged-out":
			return "没登录";
		case "awaiting-scan":
			return "等待扫码";
		case "confirming":
			return state.message ?? "正在确认";
		case "expired":
		case "error":
			return state.message;
		default: {
			const unreachable: never = state;
			return unreachable;
		}
	}
}

/**
 * 在册来源各交的一行:没有 `health` 的不占行;`health()` 抛了算 bug,记一行 error、那一行写「状态读不到」,
 * 别的行照出。同步、不出网,所以不存在「很慢」。
 */
export function readSourceHealth(
	sources: readonly SourceView[],
	logger: Pick<Logger, "error">,
): StatusReport["sources"] {
	const rows: StatusReport["sources"] = [];
	for (const view of sources) {
		if (!view.health) continue;
		const { label } = view.descriptor;
		try {
			rows.push({ label, summary: view.health().summary });
		} catch (err) {
			logger.error(`[status] 来源「${label}」的 health() 抛错: ${errorMessageOf(err)}`);
			rows.push({ label, summary: "状态读不到" });
		}
	}
	return rows;
}

export function renderStatus(report: StatusReport, now: number): string {
	const lines = [
		`登录：${renderLogin(report.login)}`,
		// 「多久以前」由来源自己拼(手机上「14:32」还得自己减一次,「2 分钟前」不用)。
		...report.sources.map((s) => `${s.label}：${s.summary}`),
		`推送通道：${renderConnections(report.connections)}`,
		`渲染排队：${report.renderQueue}`,
	];
	// 静音只在**真静音时**占一行。它是「怎么没动静」的第一嫌疑 —— 不说的话主人会
	// 顺着查登录、查网络,而真相是他三小时前自己敲的。判定同样是读时现算。
	if (now < report.mutedUntil) lines.push("（正在静音中）");
	return lines.join("\n");
}

export function createStatusCommand(opts: StatusCommandOptions): CommandDef {
	const now = opts.now ?? Date.now;
	return command({
		name: "status",
		aliases: ["状态"],
		description: "看看现在怎么样",
		run: async (_values, { reply }) => {
			await reply(renderStatus(opts.probe(), now()));
		},
	});
}
