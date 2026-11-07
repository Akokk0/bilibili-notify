import { t } from "./i18n.js";

/**
 * B 站报给主人的问题:每条问题「要不要私聊、取哪句」集中在这里,逻辑里不写整句。字在字典里
 * (`bilibili.problem.*`),这里只取字;取字都包在函数里 —— 出字那一刻读当前语言,不在模块加载时定死。
 *
 * 句子平实、只说事与平台这一侧自己会怎么做:不称呼主人、不自称女仆、不点自己的名、不写宿主的界面与操作
 * (面板哪一页、哪条指令、哪个开关、重启)。私聊时由宿主按当前口吻加「<名字>报告：」的引子(ADR-0037 决策 15),
 * 登录问题也不在这里:由宿主看来源的登录状态报与清(`subscriptions/login-problems.ts`)。
 *
 * 每条问题一个条目:
 * - `text`:进问题表、(私聊的话)说给主人的那一句;
 * - `notify`:要不要私聊主人(`false` = 只进表);风控那一条按撞上的路分别给;
 * - `recovery`:清掉时、当初真私聊过的话,核心补的那一句「恢复时怎么说」。只进表的条目不会被用到,所以不带。
 */
export const PROBLEM_TEXTS = {
	/**
	 * 风控:进表;要不要私聊看是哪一路撞上的(这一条的 `notify` 按路给,调用点各取自己那一格) ——
	 * 拉动态被风控私聊;直播预检被拦只进表,等动态那一路也撞上了才补那一句。
	 */
	riskControlled: {
		notify: { dynamic: true, live: false, profile: false },
		text: () => t("bilibili.problem.riskControlled"),
		recovery: () => t("bilibili.problem.riskControlledRecovered"),
	},
	/** 拉动态失败(风控以外的错误码,每 5 分钟自动重试):只进表,不私聊。 */
	dynamicFetchFailed: {
		notify: false,
		// 没有 B 站数字码的失败(回应形状不对)传标准码,不让句子里出现 undefined
		text: (code: number | string) => t("bilibili.problem.dynamicFetchFailed", { code }),
	},
	/** 补关注失败:只进表,报一次就不再报,直到下一次关注同步成功。 */
	followFailed: {
		notify: false,
		text: (reason: string) => t("bilibili.problem.followFailed", { reason }),
	},
	/** 没开通直播间:只进表,等它开通或离开直播监听范围。 */
	liveRoomNotFound: {
		notify: false,
		text: () => t("bilibili.problem.liveRoomNotFound"),
	},
	/** 直播间停止监听(取信息失败、弹幕连不上、重连用尽):私聊 + 进表。`reason` 是停下的原因。 */
	liveMonitorStopped: {
		notify: true,
		text: (roomId: string, reason: string) =>
			t("bilibili.problem.liveMonitorStopped", { roomId, reason }),
		recovery: (roomId: string) => t("bilibili.problem.liveMonitorRecovered", { roomId }),
	},
	/** 直播间停止监听时填进 `liveMonitorStopped.text` 的原因(调用点各取一条)。 */
	liveStopReasons: {
		/** 取直播间信息失败(含开播 / 下播 / 周期那几拍取信息失败)。 */
		roomInfo: () => t("bilibili.problem.liveStopReason.roomInfo"),
		/** 弹幕连接没建起来。 */
		danmakuConnect: () => t("bilibili.problem.liveStopReason.danmakuConnect"),
		/** 重连的秒级退避用完,放弃监听。 */
		gaveUp: () => t("bilibili.problem.liveStopReason.gaveUp"),
	},
	/**
	 * 设置读不懂的原因那半句:自己那一格坏了 / 整个设置文件读不懂。`reason` 是 zod 或 JSON 解析的原话,
	 * 不带文件内容;格名用面板上的叫法、括号里带键名。
	 */
	settingsCause: {
		cell: (label: string, key: string, reason: string) =>
			t("bilibili.problem.settingsCause.cell", { label, key, reason }),
		file: (reason: string) => t("bilibili.problem.settingsCause.file", { reason }),
	},
	/** 动态那一格读不懂(或整个文件读不懂):只进表,不私聊。 */
	dynamicSettingsInvalid: {
		notify: false,
		text: (cause: string) => t("bilibili.problem.dynamicSettingsInvalid", { cause }),
	},
	/** 登录检查那一格读不懂(或整个文件读不懂):只进表,不私聊。 */
	loginCheckSettingsInvalid: {
		notify: false,
		text: (cause: string) => t("bilibili.problem.loginCheckSettingsInvalid", { cause }),
	},
	/** 直播间受限(加密、付费、测试房、没权限):私聊 + 进表。`reason` 是 B 站给的原因。 */
	liveRoomRestricted: {
		notify: true,
		text: (roomId: string, reason: string) =>
			t("bilibili.problem.liveRoomRestricted", { roomId, reason }),
		recovery: (roomId: string) => t("bilibili.problem.liveRoomRecovered", { roomId }),
	},
	/** 这一轮没取到直播状态:只进表,不停监听;下一轮成功时清掉。 */
	liveStatusUnavailable: {
		notify: false,
		text: (roomId: string) => t("bilibili.problem.liveStatusUnavailable", { roomId }),
	},
} as const;
