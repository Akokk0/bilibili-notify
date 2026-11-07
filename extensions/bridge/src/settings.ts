/**
 * 桥自己的设置 —— **接入名单**(ADR-0012 决策 45)。
 *
 * 一条接入 = 一个 koishi / AstrBot 实例 + 它出示的 token。它**不是连接**:连接是「一个 bot」,
 * 是宿主认识、推送目标能挂上去的东西;而一条接入驮着 N 个 bot。所以接入住拓展自己的设置
 * (`config/settings/extensions/bridge.json`,经 `ctx.settings(schema)` 现读),连接从它驮着的
 * bot 里挑(见 `config.ts`)。
 *
 * 写路径只有面板那一条(`/api/ext/bridge/settings`,按项写、带版本号 —— ADR-0019 决策 35),
 * 拓展这头只读。
 *
 * 面板上那张表也从这份规则导出(规则只写一份):给人看的那几格写在 `.meta()` 上,构建照它写进
 * `dist/extension.json` 的 `settings.fields`;栏的顺序就是键的顺序。
 */

import type { SettingsFieldMeta } from "@bilibili-notify/extension";
import { z } from "zod";
import { ASTRBOT_ICON, KOISHI_ICON } from "./kind-icons.js";

export const BRIDGE_KINDS = ["koishi", "astrbot"] as const;

/** 两种桥在面板上的样子:设置里「哪一种桥」的选项,也是视图里「改成 AstrBot」那颗钮的叫法。 */
export const BRIDGE_KIND_FACES = {
	koishi: { label: "koishi", icon: KOISHI_ICON },
	astrbot: { label: "AstrBot", icon: ASTRBOT_ICON },
} as const satisfies Record<(typeof BRIDGE_KINDS)[number], { label: string; icon: string }>;

const BridgeLinkSchema = z.object({
	/** 接入自己的 id —— 会话按它记,连接的 config 拿它回指。BN 生成、不出栏。 */
	id: z.string().min(1),
	/**
	 * 哪一种桥。**只影响面板怎么说**(装插件的指引、卡片上的名字)——BN 侧对两种桥的
	 * 处理完全相同;桥自报的种类与它对不上时面板会提醒(token 填到另一头去了)。
	 */
	bridgeKind: z.enum(BRIDGE_KINDS).meta({
		label: "哪一种桥",
		description: "只影响面板怎么称呼它。两种桥说的是同一套协议,BN 这边的处理完全相同。",
		options: BRIDGE_KIND_FACES,
	} satisfies SettingsFieldMeta),
	name: z
		.string()
		.min(1)
		.meta({ label: "名字", placeholder: "比如「家里那台 koishi」" } satisfies SettingsFieldMeta),
	/**
	 * 长期 token,桥握手时出示。
	 *
	 * 空串**合法可存**:脱敏备份会把它抹成空串,存不回去就等于备份恢复不了。「没 token
	 * 不许连」是**连接期**的约束(`tokens.ts` 永远不匹配空串),不是存储期的。
	 *
	 * 所以它**不能是必填**(BN 按清单校验时,必填的字符串不收空串),缺了就补空串 —— 导出的那格
	 * 也就带着 `"default": ""`。缺了的那条同样连不上,别的接入不受牵连。
	 */
	token: z
		.string()
		.default("")
		.meta({
			label: "token",
			secret: true,
			generate: true,
			monospace: true,
			description: "只在这一刻看得到全文。存下之后面板只显示头尾 —— 忘了就重新生成一个。",
		} satisfies SettingsFieldMeta),
	/** 停用不是吊销:配置全留,桥握手回 503(退避重连)而不是 401。 */
	enabled: z
		.boolean()
		.default(true)
		.meta({ label: "启用" } satisfies SettingsFieldMeta),
});

export const BridgeSettingsSchema = z.object({
	links: z
		.array(BridgeLinkSchema)
		.default([])
		.meta({
			label: "桥接入",
			itemLabel: "接入",
			title: "name",
			mark: "bridgeKind",
			toggle: "enabled",
			description:
				"在这里建一条,把生成的 token 和 BN 地址填进 koishi / AstrBot 的插件设置里,它就会自己连过来。",
			newItemCopy: [{ host: "extensionUrl", label: "BN 地址" }, { field: "token" }],
			removeWarning: "那一头的插件会连不上,从它借来的 bot 建的那些连接也会发不出去。",
		} satisfies SettingsFieldMeta),
});

export type BridgeLink = z.infer<typeof BridgeLinkSchema>;
