/**
 * 模板的历代「旧默认原文」→ 当前默认(0.x 的一次性迁移,⑥c 从配置仓开机时收进来)。
 *
 * 值对得上任何一代旧默认,就判定主人没改过,改写成当前默认;改过的原样保留。覆盖两代:① 占位符语法统一前
 * (alpha.x)的 `{title}` / `{duration}` / `{user}` / `{mastername}` 旧变量默认;② 消息版式引入前「链接内嵌模板」
 * 的 `{url}` / `{link}` 默认。
 *
 * ⚠️ **这张表冻结了,不要再往里加条目。** 它是「改了默认怎么惠及老用户」的上一代解法;今天这件事归
 * `templateDefaultsSeen` 账本 + 规则页的逐字段提示(`packages/internal/src/template-defaults.ts`)。留着是为了
 * 还停在老版本、将来才升级上来的用户 —— 删掉他们就从自动迁移退化成「打开页面看见提示再点一下」。
 */

import { isPlainObject } from "./files.js";
import { ZERO_DEFAULT_TEMPLATES } from "./zero-vocabulary.js";

const OLD_TPL_DEFAULTS: Partial<
	Record<"liveStart" | "liveOngoing" | "liveEnd" | "dynamic" | "dynamicVideo", string[]>
> = {
	liveStart: [
		"{name} 开播了！\n直播间标题：{title}\n直播间链接：{link}",
		"{name} 开播啦，当前粉丝数：{follower}\n{link}",
	],
	liveOngoing: [
		"{name} 仍在直播中（已直播 {duration}）\n标题：{title}\n看过：{watched}",
		"{name} 正在直播，已播 {time}，累计观看：{watched}\n{link}",
	],
	liveEnd: ["{name} 下播了，直播时长 {duration}"],
	dynamic: ["{name}发布了一条动态：{url}"],
	dynamicVideo: ["{name}发布了新视频：{url}"],
};

const OLD_GUARD = {
	captain: "{user} 成为了 {mastername} 的舰长！",
	commander: "{user} 成为了 {mastername} 的提督！",
	governor: "{user} 成为了 {mastername} 的总督！",
} as const;

/** 整份 `defaults.templates` 的 raw → raw。键缺着(由 schema 补默认)的对不上任何旧默认,不用管。 */
export function migrateOldTemplateDefaults(raw: unknown): unknown {
	if (!isPlainObject(raw)) return raw;
	const fresh = ZERO_DEFAULT_TEMPLATES;
	const out: Record<string, unknown> = { ...raw };
	for (const [k, olds] of Object.entries(OLD_TPL_DEFAULTS) as Array<
		[keyof typeof OLD_TPL_DEFAULTS, string[]]
	>) {
		if (typeof out[k] === "string" && olds.includes(out[k])) out[k] = fresh[k];
	}
	const guardBuy = out.guardBuy;
	if (isPlainObject(guardBuy)) {
		const nextGuard: Record<string, unknown> = { ...guardBuy };
		for (const role of ["captain", "commander", "governor"] as const) {
			const tier = nextGuard[role];
			if (isPlainObject(tier) && tier.template === OLD_GUARD[role]) {
				nextGuard[role] = { ...tier, template: fresh.guardBuy[role] };
			}
		}
		out.guardBuy = nextGuard;
	}
	return out;
}
