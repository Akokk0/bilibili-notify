/**
 * 系统页的「私聊指令」卡片 —— 前缀 / 别名 / 总开关。
 *
 * 指令表**不在这里手写**:从 `GET /api/commands` 拉注册表来渲染。注册表本来就是
 * 可序列化的声明,照它渲染的清单永不过期 —— 手写的那份必然与实现脱节,而脱节的
 * 表现是主人照着面板敲一条根本不存在的指令。
 *
 * 这张卡同时解决可发现性:指令是「增量入口,不是 Dashboard 的替代」,前提是主人
 * 得先知道有这么些东西可敲。
 */

import { Btn, GlassBox, Icon, Toggle } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SECTION_ACCENT } from "../config/section-accents";
import { api } from "../services/api";
import type { GlobalConfig, GlobalConfigPatch } from "../types/globals";
import { Field, TInput } from "./forms";

interface CommandEntry {
	name: string;
	defaultAliases: string[];
	aliases: string[];
	usage: string;
	example: string;
	description: string;
	details: string;
}

interface CommandsResponse {
	enabled: boolean;
	prefix: string;
	commands: CommandEntry[];
}

/** 别名在输入框里用空格或逗号分隔。空串 = 一个别名都不要(不是「没配」)。 */
function parseAliases(text: string): string[] {
	return text
		.split(/[\s,，、]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function CommandsSettings({
	draft,
	onPatch,
}: {
	draft: GlobalConfig;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const registry = useQuery({
		queryKey: ["commands"],
		queryFn: () => api.get<CommandsResponse>("/api/commands"),
	});
	const cfg = draft.commands;
	// 输入框保留**原样文本**,数组只在草稿里 —— 只存数组的话,打到一半的那个空格
	// 会被解析吃掉,光标就跳了。
	const [text, setText] = useState<Record<string, string>>({});

	function aliasesOf(cmd: CommandEntry): string[] {
		return cfg.aliases[cmd.name] ?? cmd.defaultAliases;
	}

	/**
	 * 输入框显示什么:原样文本只在**解析后与草稿当前值一致**时才可信 ——
	 * 那时它只是同一份值的另一种写法(多个尾空格、打到一半的逗号),保住它
	 * 光标才不跳。不一致说明草稿在别处被改了(灵动岛「放弃」回滚、恢复默认),
	 * 这份文本已是陈旧孤儿:再显示它等于谎称放弃没生效,下一次击键还会把它
	 * 重新 patch 回草稿。
	 */
	function displayValue(cmd: CommandEntry): string {
		const raw = text[cmd.name];
		const canonical = aliasesOf(cmd);
		if (raw !== undefined) {
			const parsed = parseAliases(raw);
			const same = parsed.length === canonical.length && parsed.every((a, i) => a === canonical[i]);
			if (same) return raw;
		}
		return canonical.join(" ");
	}

	function isOverridden(cmd: CommandEntry): boolean {
		return cfg.aliases[cmd.name] !== undefined;
	}

	function setAliases(name: string, raw: string): void {
		setText((t) => ({ ...t, [name]: raw }));
		onPatch({ commands: { aliases: { [name]: parseAliases(raw) } } });
	}

	function restore(name: string): void {
		setText((t) => {
			const next = { ...t };
			delete next[name];
			return next;
		});
		// `null` = 删掉这个键(JSON Merge Patch 的删除哨兵)→ 回落到代码里内置的别名。
		// 发空数组是**另一件事**:那是「一个别名都不要」。
		onPatch({ commands: { aliases: { [name]: null } } });
	}

	return (
		<GlassBox
			title="Core · 私聊指令"
			subtitle="主人在 IM 私聊里能敲的那几条 · globals.commands"
			accent={SECTION_ACCENT.system}
			icon={<Icon.chat size={14} />}
			badge={cfg.enabled ? `前缀 ${cfg.prefix || "(空)"}` : "已关闭"}
		>
			<Field code="commands.enabled">
				<Toggle
					value={cfg.enabled}
					onChange={(v) => onPatch({ commands: { enabled: v } })}
					ariaLabel="私聊指令总开关"
				/>
			</Field>

			<Field code="commands.prefix">
				<TInput
					value={cfg.prefix}
					onChange={(v) => onPatch({ commands: { prefix: v } })}
					placeholder="/"
					mono
				/>
			</Field>

			<Field code="commands.aliases" full>
				{registry.isLoading ? (
					<div className="text-xs text-bn-text-tertiary">加载指令表中…</div>
				) : registry.error ? (
					<div className="text-xs text-bn-danger-text">
						拉取指令表失败：{String((registry.error as Error).message)}
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{(registry.data?.commands ?? []).map((cmd) => (
							<div
								key={cmd.name}
								className="rounded-md border border-bn-border-subtle bg-bn-surface/60 px-2.5 py-2"
							>
								<div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
									<code className="rounded-sm bg-bn-code-bg px-1.5 py-px font-mono text-[11.5px] font-bold text-bn-text-primary">
										{cfg.prefix}
										{cmd.name}
										{cmd.usage ? ` ${cmd.usage}` : ""}
									</code>
									<span className="text-[11.5px] text-bn-text-tertiary">{cmd.description}</span>
									{isOverridden(cmd) ? (
										<Btn
											variant="ghost"
											size="sm"
											onClick={() => restore(cmd.name)}
											title="回到代码里内置的那几个别名"
										>
											恢复默认
										</Btn>
									) : null}
								</div>
								<TInput
									value={displayValue(cmd)}
									onChange={(v) => setAliases(cmd.name, v)}
									placeholder="别名,用空格分隔;留空则只认主名"
								/>
								{cmd.example ? (
									<div className="mt-1 font-mono text-[11px] text-bn-text-tertiary">
										例：{cfg.prefix}
										{cmd.name} {cmd.example}
									</div>
								) : null}
								{cmd.details ? (
									<div className="mt-1 text-[11px] text-bn-text-tertiary">{cmd.details}</div>
								) : null}
							</div>
						))}
					</div>
				)}
			</Field>
		</GlassBox>
	);
}
