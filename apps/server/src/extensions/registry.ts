import { BRIDGE_EXTENSION_ID } from "@bilibili-notify/internal";

/**
 * 一个拓展模块。**编进产物**,不是运行时装载的插件 —— 独立端是单进程自包含 bundle,
 * `boot.ts` 那个动态加载点只加载自家的下一个版本。所以「启用」只是一个配置开关
 * (`globals.extensions.<id>.enabled`),不是加载代码。
 *
 * 这张表就是那份「一处 import 清单」:新模块进来只改这里 + 它自己的目录。哪天真做运行时
 * 插件,换掉的是这张表怎么填,而不是模块与核心之间的契约。
 */
export interface ExtensionDef {
	id: string;
	name: string;
	/** 一句话说清它是干嘛的 —— 拓展页卡片上印的就是这句。 */
	description: string;
}

export const EXTENSIONS: readonly ExtensionDef[] = [
	{
		id: BRIDGE_EXTENSION_ID,
		name: "机器人框架桥接",
		description:
			"把 koishi / AstrBot 里已经配好的机器人借给 BN 用:它们主动连过来,推送与私聊指令都走它们的账号发。",
	},
];
