/**
 * 系统页的「链接解析」卡片 —— 群里贴 B 站视频链接自动回一张视频卡片。
 *
 * 两个控件各自直接 patch 草稿(与其他系统设置一样走灵动岛保存)。这功能默认关:
 * 开着就意味着同群任何人都能让机器人出图,所以开关必须是主人自己按下去的。
 */

import { GlassBox, Icon, TNum, Toggle } from "@bilibili-notify/ui";
import { SECTION_ACCENT } from "../config/section-accents";
import type { GlobalConfig, GlobalConfigPatch } from "../types/globals";
import { Field } from "./forms";

export function LinkParsingSettings({
	draft,
	onPatch,
}: {
	draft: GlobalConfig;
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const cfg = draft.linkParsing;
	return (
		<GlassBox
			title="Core · 链接解析"
			subtitle="群里贴 B 站视频链接,自动回一张视频卡片 · globals.linkParsing"
			accent={SECTION_ACCENT.system}
			icon={<Icon.link size={14} />}
			badge={cfg.enabled ? `冷却 ${cfg.cooldownSeconds} 秒` : "已关闭"}
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
		</GlassBox>
	);
}
