/**
 * 一条桥连接的 config —— **绑的是哪条接入上的哪个 bot**(ADR-0012 决策 45)。
 *
 * 连接是「一个 bot」:主人在推送目标页「新建连接」里从桥驮着的 bot 里挑一个,面板把
 * `listBots` 交出来的这份 config 原样存进连接(宿主看不懂它,也不该看懂);发送时桥拿它
 * 回指「哪条会话、哪个 bot」。
 *
 * 字段表是**空的**:这份 config 没有一栏是人填的。token 那种要人填的东西住接入(`settings.ts`)。
 *
 * 🔴 这份 schema 从前住在核心的 `packages/internal/src/schema/targets.ts` 里,那时桥是内置的、
 * 连接还是「一条接入」。搬出来之后核心对拓展连接的 `config` 只知道「是个对象」(决策 27)。
 */

import type { ExtensionConfigField } from "@bilibili-notify/extension";
import { z } from "zod";

export const BridgeConnectionConfigSchema = z.object({
	/** 哪条接入(`BridgeLink.id`)。接入删了,这条连接就发不出去 —— 面板上会说。 */
	link: z.string().min(1),
	/** 那条接入上的哪个 bot(`BridgeBot.botId`,桥握手时报的,要求跨重启稳定,协议 §5.2)。 */
	botId: z.string().min(1),
});

export type BridgeConnectionConfig = z.infer<typeof BridgeConnectionConfigSchema>;

/** 没有一栏是人填的 —— 连接是挑出来的,不是填出来的。 */
export const BRIDGE_CONFIG_FIELDS: readonly ExtensionConfigField[] = [];
