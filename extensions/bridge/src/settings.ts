/**
 * 桥自己的设置 —— **接入名单**(ADR-0012 决策 45)。
 *
 * 一条接入 = 一个 koishi / AstrBot 实例 + 它出示的 token。它**不是连接**:连接是「一个 bot」,
 * 是宿主认识、推送目标能挂上去的东西;而一条接入驮着 N 个 bot。所以接入住拓展自己的设置
 * (`globals.extensions.bridge.settings`,经 `ctx.settings(schema)` 现读),连接从它驮着的
 * bot 里挑(见 `config.ts`)。
 *
 * 写路径只有面板那一条(`PATCH /api/globals`),拓展这头只读。
 */

import { z } from "zod";

export const BRIDGE_KINDS = ["koishi", "astrbot"] as const;

export const BridgeLinkSchema = z.object({
	/** 接入自己的 id —— 会话按它记,连接的 config 拿它回指。 */
	id: z.string().min(1),
	name: z.string().min(1),
	/**
	 * 哪一种桥。**只影响面板怎么说**(装插件的指引、卡片上的名字)——BN 侧对两种桥的
	 * 处理完全相同;桥自报的种类与它对不上时面板会提醒(token 填到另一头去了)。
	 */
	bridgeKind: z.enum(BRIDGE_KINDS),
	/**
	 * 长期 token,桥握手时出示。
	 *
	 * 空串**合法可存**:脱敏备份会把它抹成空串,存不回去就等于备份恢复不了。「没 token
	 * 不许连」是**连接期**的约束(`tokens.ts` 永远不匹配空串),不是存储期的。
	 */
	token: z.string(),
	/** 停用不是吊销:配置全留,桥握手回 503(退避重连)而不是 401。 */
	enabled: z.boolean().default(true),
});

export const BridgeSettingsSchema = z.object({
	links: z.array(BridgeLinkSchema).default([]),
});

export type BridgeLink = z.infer<typeof BridgeLinkSchema>;
export type BridgeSettings = z.infer<typeof BridgeSettingsSchema>;
