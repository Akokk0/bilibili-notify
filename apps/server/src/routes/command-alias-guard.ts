/**
 * 保存指令别名时的冲突检查。
 *
 * 两条指令抢同一个词,运行时只能二选一,而且是**静默**的 —— 主人看到的是某条指令
 * 神秘失灵,他会先怀疑机器人掉线、怀疑权限,唯独想不到是自己上周起的那个别名。
 * 所以拦在保存那一刻,并说清是跟谁撞了。
 *
 * 判定必须和 dispatcher 编译触发词表时**用同一份规则**(`effectiveAliases`):
 * 各写一份的话,这里放行的配置到了那边照样撞,而那边只会记一行日志。
 */

import type { GlobalConfig } from "@bilibili-notify/internal";
import { effectiveAliases } from "../runtime/command-dispatcher.js";

/** 检查只需要主名和内置别名,不需要 handler。 */
export interface AliasCheckCommand {
	name: string;
	aliases?: readonly string[];
}

export type AliasCheckResult = { ok: true } | { ok: false; message: string };

/**
 * @param commands 注册表。给不出时(路由没接上)只能退化成「别名之间互查」,
 *   跟别的指令**内置**别名撞就查不出来了 —— 所以别省。
 */
export function checkCommandAliases(args: {
	current: GlobalConfig;
	patch: Record<string, unknown>;
	commands: readonly AliasCheckCommand[];
}): AliasCheckResult {
	// per-scope 门:这次 patch 没碰 commands 就别插手。否则存别的 tab 会被一份早就
	// 躺在盘上的配置拦住(同 checkApprovalEnable 那条)。
	const incoming = (
		args.patch as {
			commands?: { aliases?: Record<string, string[] | null> | null };
		}
	).commands;
	if (incoming?.aliases === undefined) return { ok: true };

	// deepMerge 语义:传了哪个键就替换哪个键的整份数组,没传的沿用盘上那份,
	// **显式 `null` 是删除** —— 面板上的「恢复默认」就是删掉这个键、回落到内置别名。
	// 照抄进 merged 的话,`effectiveAliases` 会拿到一个 null 当别名表。
	// 整个 aliases 键本身也可以是 null(清掉全部覆盖、回落内置),同一条删除语义
	// 抬高一层 —— 只判 undefined 会让这个合法哨兵穿进 Object.entries 抛 TypeError。
	const merged: Record<string, string[]> =
		incoming.aliases === null ? {} : { ...args.current.commands.aliases };
	for (const [name, list] of Object.entries(incoming.aliases ?? {})) {
		if (list === null) delete merged[name];
		else merged[name] = list;
	}

	const owner = new Map<string, string>();
	for (const spec of args.commands) {
		for (const trigger of [spec.name, ...effectiveAliases(spec, merged)]) {
			// 查重键折小写 —— dispatcher 的 compile()/匹配都是大小写不敏感的,
			// 「Mute」和「mute」运行时是同一个词。守卫若按原样比对,只差大小写的
			// 坏别名就能落盘:当场 reconcile 只记日志,下次重启构造期 compile
			// 直接 throw,独立端就起不来了。报错文案仍用主人写的原样(见下)。
			const prev = owner.get(trigger.toLowerCase());
			if (prev !== undefined) {
				return {
					ok: false,
					message:
						prev === spec.name
							? `「${spec.name}」的别名「${trigger}」和它自己重复了`
							: `别名「${trigger}」被「${spec.name}」和「${prev}」同时占用了，一个词只能归一条指令`,
				};
			}
			owner.set(trigger.toLowerCase(), spec.name);
		}
	}
	return { ok: true };
}
