/**
 * 推送目标的词表与纯谓词 —— 目标是什么形态、发不发、能不能回复、是不是暂停。
 *
 * 零依赖:只许 `import type`,值级 import 只能指向零依赖名单里的同伴。
 * 面板与 contract 经 `@bilibili-notify/internal/push-target` 取值。
 */

import type { PushTarget } from "./schema/targets.js";

/**
 * 推送目标的会话种类。`schema/targets.ts` 的 `PushTargetScopeSchema` 从这里取值 ——
 * 词表住零依赖模块,前端才拿得到运行时的那一份(与 `features.ts` 的 FEATURE_KEYS 同一套安排)。
 */
export const PUSH_TARGET_SCOPES = ["group", "private", "channel"] as const;
export type PushTargetScope = (typeof PUSH_TARGET_SCOPES)[number];

/**
 * 推送目标的两支形态 —— `session` 是一个会话(有地址、收得到入站),
 * `endpoint` 是一个单向出站终点(地址烧在连接的 config 里,目标只是个壳)。
 */
export const PUSH_TARGET_KINDS = ["session", "endpoint"] as const;
export type PushTargetKind = (typeof PUSH_TARGET_KINDS)[number];

/**
 * 这个目标是不是一个私聊会话 —— 「主人目标只许指向私聊」(ADR-0021 决策 57)的唯一判据。
 * 服务端的保存闸、发送时复检、迁移和面板的下拉共用这一处;目标不存在算否。
 * 住零依赖的 push-target.ts:面板拿得到(根入口会把 zod 拽进 bundle)。
 */
export function isPrivateTarget(
	target: PushTarget | undefined,
): target is Extract<PushTarget, { kind: "session" }> {
	return target?.kind === "session" && target.scope === "private";
}

/**
 * 单发 @全体 要不要发给这个目标 —— 入参是它所挂那条连接的 `atAll` 能力(适配器的回答)。
 *
 * 不是「不支持」就发:「还不知道」(以及取不到能力的 `undefined`)照发 —— 发错只是多一条消息,
 * 而误判成不发,真能 @全体 的群就再也收不到了。派发器的 `supportsAtAll` 与订阅抽屉里的 @全体 开关
 * 读的是这同一份判断,界面上说跳过就得真的跳过。入参按形状收,不为一个类型把 schema 拖进这个零依赖模块。
 */
export function shouldSendAtAll(
	support: { state: "supported" | "unsupported" | "unknown" } | undefined,
): boolean {
	return support?.state !== "unsupported";
}

/**
 * 这条连接收不收得到主人的回复 —— 入参是它的 `inbound` 能力。锐评审批(要靠主人回一句 y)的开关读它。
 *
 * 只有「支持」才算:「还不知道」(以及 `undefined`)**不能开**。开错了是整期草稿都生成、都私聊,
 * 然后一直等到超时作废,一份也发不出去,而配置页上看着一切正常;不让开只是多问主人一句。
 */
export function canReceiveReply(
	support: { state: "supported" | "unsupported" | "unknown" } | undefined,
): boolean {
	return support?.state === "supported";
}

/**
 * 链接解析设置里列不列这个连接名下的群 —— 入参是它的 `inbound` 能力。
 *
 * 不是「不支持」就列:「还不知道」(以及 `undefined`)照列。今天对拓展连接就是一律列出,
 * 少列了主人就没处设;多列了只是一个收不到消息的群摆在那儿,无害。
 */
export function listsForLinkPreview(
	support: { state: "supported" | "unsupported" | "unknown" } | undefined,
): boolean {
	return support?.state !== "unsupported";
}

/**
 * 「这个推送目标现在算不算暂停」。目标自己的开关关了,或它挂在一条已停用的连接下面
 * (投递层对这两种情况一律回不可达),都算。
 *
 * 住在这里而不是服务端:面板上的「已停用」标记与运行时的「跳过」必须是同一句话 ——
 * 前端只看 `target.enabled` 的话,连接停用的目标在选择器里显示为启用,发的时候却被
 * 跳过。入参按形状收,免得为了两个类型把 schema 拖进这个零依赖模块。
 */
export function isTargetPaused(
	target: { enabled: boolean; connectionId: string },
	connections: readonly { id: string; enabled: boolean }[],
): boolean {
	if (!target.enabled) return true;
	return !connections.find((a) => a.id === target.connectionId)?.enabled;
}

/**
 * 一个目标是哪个平台 —— 取自它挂着的那条连接;连接不在了就是 `undefined`。
 *
 * 它住在这里只因为面板运行时要用,而这个文件是面板能引的零依赖子路径;出口整理那一片会把
 * 这类小函数一起搬走。入参按形状收(与 {@link isTargetPaused} 同一套安排)。
 */
export function platformOfTarget(
	target: { connectionId: string },
	connections: readonly { id: string; platform: string }[],
): string | undefined {
	return connections.find((c) => c.id === target.connectionId)?.platform;
}
