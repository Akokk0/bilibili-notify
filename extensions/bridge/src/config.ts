/**
 * 一条桥接入的 config —— **两份声明**(ADR-0012 决策 19 / 33)。
 *
 * zod 那份给机器校验、字段表那份给人填表,宿主在注册那一刻逐格对表,对不上直接拒绝加载。
 * 它们本来就不是一回事:合成一份要么把字段表逼成一门 DSL,要么让校验退化成只剩类型检查。
 *
 * 🔴 **这份 schema 从前住在核心的 `packages/internal/src/schema/targets.ts` 里** ——
 * 那时桥是内置的,核心认识它的 config 形状。搬出来之后核心对拓展连接的 `config` 只知道
 * 「是个对象」,形状归拓展自己(决策 27)。
 */

import type { ExtensionConfigField } from "@bilibili-notify/extension";
import { z } from "zod";

/**
 * 桥接入的连接配置。
 *
 * **桥主动连我们**,不是我们连桥:面板生成一个长期 token,插件那头填「BN 地址 + token」。
 * 所以这里没有地址 —— 地址在桥那边。重连退避也归插件。
 */
export const BridgeConnectionConfigSchema = z.object({
	/**
	 * 长期 token,桥握手时出示。
	 *
	 * 空串**合法可存**:与 onebot 的 `accessToken`、官机的 `appSecret` 同一套建模 ——
	 * 脱敏备份会把它抹成空串,存不回去就等于备份恢复不了(官机那格栽过一次)。
	 * 「没 token 不许连」是**连接期**的约束,不是存储期的。
	 */
	token: z.string(),
	/**
	 * 哪一种桥。**只影响面板怎么说**(装插件的指引、卡片上的名字)——BN 侧对两种桥的
	 * 处理完全相同,所以它住 config 而不是长成 `connector` 的第二档:两个桥说同一套协议,
	 * 分两档就是两份几乎一样的 schema branch,而且每来一个新桥都要改核心词表发一次版。
	 */
	bridgeKind: z.enum(["koishi", "astrbot"]),
});

export type BridgeConnectionConfig = z.infer<typeof BridgeConnectionConfigSchema>;

/**
 * 面板照这张表画表单。
 *
 * 🔴 `token` 的 `secret: true` 不只是「输入框打码」—— 它同时是**备份脱敏的依据**
 * (决策 33)。脱敏本来靠一份键名黑名单,而拓展的 config 键名归拓展自己起;不声明的话
 * 这个 token 会**原样躺在主人发出去求助的备份文件里**。
 */
export const BRIDGE_CONFIG_FIELDS: readonly ExtensionConfigField[] = [
	{
		kind: "select",
		code: "bridgeKind",
		label: "桥的种类",
		hint: "只影响面板怎么称呼它;两种桥说的是同一套协议。",
		required: true,
		options: [
			{ value: "koishi", label: "Koishi" },
			{ value: "astrbot", label: "AstrBot" },
		],
	},
	{
		kind: "text",
		code: "token",
		label: "接入 token",
		hint: "填进插件那一侧,连同 BN 的地址。桥主动连过来,BN 不去连桥。",
		required: true,
		mono: true,
		secret: true,
	},
];
