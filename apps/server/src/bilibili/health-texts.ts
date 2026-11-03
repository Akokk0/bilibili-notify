import { t as serverText } from "../i18n/index.js";
/**
 * B 站来源 `health()` 的那一句话。集中放这里:`status` 指令里 B 站那一行读什么,改这一个文件。
 *
 * 口吻平实:这一行排在「登录」「推送通道」「渲染排队」中间,是状态读数。不提登录(登录有自己的一行)。
 */

export const HEALTH_TEXTS = {
	/** 抓过:`ago` 是 `formatAgo` 的相对时间(「2 分钟前」「刚刚」)。 */
	fetched: (ago: string): string => serverText("bilibili.health-texts.text.1", { value0: ago }),
	/** 动态轮询在、但还没成功抓过(刚启动、没有订阅开着动态、或一直失败)。 */
	get neverFetched() {
		return serverText("bilibili.health-texts.text.2");
	},
	/** 动态那一格设置读不懂、动态停着。原因的细节在问题表里,这一行不重复。 */
	get dynamicStopped() {
		return serverText("bilibili.health-texts.text.3");
	},
} as const;
