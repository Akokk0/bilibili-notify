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

import { type CommandSpec, command } from "./command-dispatcher.js";

/** 一次状态快照。字段少是刻意的,见文件头。 */
export interface StatusReport {
	/** 登录态的人话,直接来自 LoginFlow 的快照(「已登录」/「账号登录已失效…」)。 */
	login: string;
	/**
	 * 上次**成功**抓到动态的时刻。`undefined` = 启动以来一次都没成功过。
	 *
	 * 只记成功不记尝试:连着失败三小时的系统若报「1 分钟前抓过」,这一项就从
	 * 「还在跑吗」的答案变成了骗局。
	 */
	lastFetchAt?: number;
	/** 排队等渲染的卡片数。持续不为 0 = 推送在堆积。 */
	renderQueue: number;
	adapters: { name: string; ok: boolean }[];
	/** 全局静音到期时刻,`0` = 没静音。 */
	mutedUntil: number;
}

export interface StatusCommandOptions {
	probe: () => StatusReport;
	reply: (text: string) => Promise<void>;
	/** 可注入的时钟。测试用,生产不传。 */
	now?: () => number;
}

/**
 * 「多久以前」。手机上「14:32」还得自己减一次,「2 分钟前」不用。
 *
 * `undefined` 与「很久以前」必须分开说:前者是刚启动,后者是坏了。
 */
function ago(at: number | undefined, now: number): string {
	if (at === undefined) return "还没抓过";
	const ms = Math.max(0, now - at);
	if (ms < 60_000) return "刚刚";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min} 分钟前`;
	const hour = Math.floor(min / 60);
	if (hour < 24) return `${hour} 小时前`;
	return `${Math.floor(hour / 24)} 天前`;
}

function renderAdapters(adapters: StatusReport["adapters"]): string {
	// 一行空白看起来像功能坏了,而「还没配」是个明确的下一步。
	if (adapters.length === 0) return "还没配适配器";
	const down = adapters.filter((a) => !a.ok);
	if (down.length === 0) return `${adapters.length} 个都连着`;
	// 只点名断掉的那些 —— 连着的不需要主人做任何事。
	return `${down.map((a) => a.name).join("、")} 断了（共 ${adapters.length} 个）`;
}

export function renderStatus(report: StatusReport, now: number): string {
	const lines = [
		`登录：${report.login}`,
		`上次抓取：${ago(report.lastFetchAt, now)}`,
		`推送通道：${renderAdapters(report.adapters)}`,
		`渲染排队：${report.renderQueue}`,
	];
	// 静音只在**真静音时**占一行。它是「怎么没动静」的第一嫌疑 —— 不说的话主人会
	// 顺着查登录、查网络,而真相是他三小时前自己敲的。判定同样是读时现算。
	if (now < report.mutedUntil) lines.push("（正在静音中）");
	return lines.join("\n");
}

export function createStatusCommand(opts: StatusCommandOptions): CommandSpec {
	const now = opts.now ?? Date.now;
	return command({
		name: "status",
		aliases: ["状态"],
		description: "看看现在怎么样",
		run: async () => {
			await opts.reply(renderStatus(opts.probe(), now()));
		},
	});
}
