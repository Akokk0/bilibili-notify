import { t as serverText } from "../i18n/index.js";
import {
	builtinCommandAliases,
	displayedBuiltinCommandAliases,
} from "./builtin-command-aliases.js";
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

import { type AuthState, type Logger, ok } from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import type { SourceLoginView, SourceView } from "../subscriptions/registry.js";
import { errorMessageOf } from "../util/error-message.js";
import { type CommandDef, command } from "./command-dispatcher.js";

/** 一次状态快照。字段少是刻意的,见文件头。 */
export interface StatusReport {
	/**
	 * 带登录口的来源各一行,次序是登记先后:`label` 是来源给人看的名字,`state` 是中立的 `AuthState`,
	 * 一行人话由 {@link renderLogin} 按状态拼。`state` 为 `undefined` = 这个来源的 `auth.state()` 抛了(算 bug)。
	 * 没有带登录的来源就是空数组、没有这一行。取数见 {@link readLogins}。
	 */
	logins: { label: string; state: AuthState | undefined }[];
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
	if (connections.length === 0) return serverText("service.runtime.status-command.text.1");
	const down = connections.filter((a) => !a.ok);
	if (down.length === 0)
		return serverText("service.runtime.status-command.text.2", { count: connections.length });
	// 只点名断掉的那些 —— 连着的不需要主人做任何事。
	return serverText("service.runtime.status-command.text.3", {
		value0: down.map((a) => a.name).join("、"),
		count: connections.length,
	});
}

/** 来源自己的读口抛了时那一行写的话(`health()` 与 `auth.state()` 共用)。 */
const unreadable = () => serverText("service.runtime.status-command.text.4");

/** 登录态的一行人话。`confirming` 没带 `message` 时写「正在确认」;`undefined`(读口抛了)写「状态读不到」。 */
function renderLogin(state: AuthState | undefined): string {
	if (state === undefined) return unreadable();
	switch (state.status) {
		case "logged-in":
			return serverText("service.runtime.status-command.text.5");
		case "logged-out":
			return serverText("service.runtime.status-command.text.6");
		case "awaiting-scan":
			return serverText("service.runtime.status-command.text.7");
		case "confirming":
			return state.message ?? serverText("service.runtime.status-command.text.8");
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
			rows.push({ label, summary: unreadable() });
		}
	}
	return rows;
}

/**
 * 带登录口的来源各交的一行:每个来源现读一次 `auth.state()`(同步、不出网)。和 {@link readSourceHealth} 同一个待遇:
 * `auth.state()` 抛了算 bug,记一行 error、那一行的 `state` 记 `undefined`(渲染成「状态读不到」),别的行照出。
 */
export function readLogins(
	sources: readonly SourceLoginView[],
	logger: Pick<Logger, "error">,
): StatusReport["logins"] {
	return sources.map(({ label, auth }) => {
		try {
			return { label, state: auth.state() };
		} catch (err) {
			logger.error(`[status] 来源「${label}」的 auth.state() 抛错: ${errorMessageOf(err)}`);
			return { label, state: undefined };
		}
	});
}

function renderStatus(report: StatusReport, now: number): string {
	const lines = [
		// 登录排在来源自己的行之前:掉线是「怎么没动静」的头号嫌疑。
		...report.logins.map(
			(l) => `${t("command.status.loginLabel", { label: l.label })}：${renderLogin(l.state)}`,
		),
		// 「多久以前」由来源自己拼(手机上「14:32」还得自己减一次,「2 分钟前」不用)。
		...report.sources.map((s) => `${s.label}：${s.summary}`),
		serverText("service.runtime.status-command.text.9", {
			value0: renderConnections(report.connections),
		}),
		serverText("service.runtime.status-command.text.10", { value0: report.renderQueue }),
	];
	// 静音只在**真静音时**占一行。它是「怎么没动静」的第一嫌疑 —— 不说的话主人会
	// 顺着查登录、查网络,而真相是他三小时前自己敲的。判定同样是读时现算。
	if (now < report.mutedUntil) lines.push(serverText("service.runtime.status-command.text.11"));
	return lines.join("\n");
}

export function createStatusCommand(opts: StatusCommandOptions): CommandDef {
	const now = opts.now ?? Date.now;
	return command({
		name: "status",
		aliases: builtinCommandAliases("status"),
		get displayAliases() {
			return displayedBuiltinCommandAliases("status");
		},
		get description() {
			return serverText("service.runtime.status-command.text.12");
		},
		run: async (_values, { reply }) => {
			await reply(renderStatus(opts.probe(), now()));
			return ok();
		},
	});
}
