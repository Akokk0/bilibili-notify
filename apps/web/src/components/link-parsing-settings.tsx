/**
 * 系统页的「链接解析」卡片 —— 群里贴 B 站视频链接自动回一张视频卡片。
 *
 * 控件各自直接 patch 草稿(与其他系统设置一样走灵动岛保存)。这功能默认关:开着就
 * 意味着同群任何人都能让机器人出图,所以开关必须是主人自己按下去的。
 *
 * 生效范围两档:「所有群」= 机器人在的所有群,不要求群配成推送目标;「仅以下群」= 从推送
 * 目标里勾。白名单存的是目标 id(`{ targetId }` 对象,给将来按群差异化留位),候选只列群类
 * 目标;停用的照列照勾并标「已停用」(与周报「发送到」同一个选择器、同一条规矩)。
 */

import { INBOUND_CAPABLE_PLATFORMS } from "@bilibili-notify/internal/constants";
import { GlassBox, HintNote, Icon, Picker, TNum, Toggle } from "@bilibili-notify/ui";
import { Link } from "react-router-dom";
import { SECTION_ACCENT } from "../config/section-accents";
import type { PushTarget } from "../types/domain";
import type { GlobalConfig, GlobalConfigPatch } from "../types/globals";
import { Field } from "./forms";
import { TargetChipPicker } from "./target-chip-picker";

type LinkParsingScope = GlobalConfig["linkParsing"]["scope"];

const SCOPE_OPTIONS: Array<{ value: LinkParsingScope; label: string; color: string }> = [
	{ value: "all", label: "所有群", color: SECTION_ACCENT.system },
	{ value: "selected", label: "仅以下群", color: SECTION_ACCENT.system },
];

/** 能被勾进白名单的目标:群类,且平台收得到入站消息(webhook 只出不进,勾了也没用)。 */
function isWhitelistCandidate(t: PushTarget): boolean {
	return (
		t.scope === "group" && (INBOUND_CAPABLE_PLATFORMS as readonly string[]).includes(t.platform)
	);
}

export function LinkParsingSettings({
	draft,
	onPatch,
	targets,
}: {
	draft: GlobalConfig;
	onPatch: (delta: GlobalConfigPatch) => void;
	/** 推送目标表(由页面取数),这里只挑群类的列出来。 */
	targets: readonly PushTarget[];
}) {
	const cfg = draft.linkParsing;
	const candidates = targets.filter(isWhitelistCandidate);
	const chosen = cfg.targets.map((t) => t.targetId);
	// 数组整份发:配置补丁对数组不做逐元素 diff,发一半会把另一半冲掉。
	const toggleTarget = (targetId: string) => {
		const next = chosen.includes(targetId)
			? cfg.targets.filter((t) => t.targetId !== targetId)
			: [...cfg.targets, { targetId }];
		onPatch({ linkParsing: { targets: next } });
	};

	const badge = !cfg.enabled
		? "已关闭"
		: cfg.scope === "selected"
			? `冷却 ${cfg.cooldownSeconds} 秒 · ${cfg.targets.length} 个群`
			: `冷却 ${cfg.cooldownSeconds} 秒`;

	return (
		<GlassBox
			title="Core · 链接解析"
			subtitle="群里贴 B 站视频链接,自动回一张视频卡片 · globals.linkParsing"
			accent={SECTION_ACCENT.system}
			icon={<Icon.link size={14} />}
			badge={badge}
		>
			<Field code="linkParsing.enabled">
				<Toggle
					value={cfg.enabled}
					onChange={(v) => onPatch({ linkParsing: { enabled: v } })}
					ariaLabel="链接解析总开关"
				/>
			</Field>

			<Field code="linkParsing.cooldownSeconds">
				<TNum
					value={cfg.cooldownSeconds}
					onChange={(v) => onPatch({ linkParsing: { cooldownSeconds: v } })}
					min={0}
					max={3600}
					suffix="秒"
				/>
			</Field>

			<Field code="linkParsing.scope">
				<Picker
					value={cfg.scope}
					onChange={(scope) => onPatch({ linkParsing: { scope } })}
					options={SCOPE_OPTIONS}
				/>
			</Field>

			{cfg.scope === "selected" ? (
				<Field code="linkParsing.targets" full>
					<TargetChipPicker
						targets={candidates}
						selected={chosen}
						onToggle={toggleTarget}
						tone={SECTION_ACCENT.system}
						empty={
							<>
								还没有群类推送目标,先去
								<Link to="/targets" className="mx-0.5 font-semibold text-bn-pink">
									推送目标
								</Link>
								页添加一个群
							</>
						}
					/>
					{candidates.length > 0 && chosen.length === 0 ? (
						<HintNote className="mt-2">还没选群,当前不会在任何群解析链接</HintNote>
					) : null}
				</Field>
			) : null}
		</GlassBox>
	);
}
