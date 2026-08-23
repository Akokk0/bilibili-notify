/**
 * 「覆盖开关卡」模具 —— per-UP 覆盖那类 GlassBox:右上 Toggle 定开关、badge 写
 * 「覆盖中/继承」、关闭时正文换成一行 InheritNote。收编前这套接线在
 * rules/PerUpEditor(9 张)与 Cards(2 张)各拼各的,badge 那行逐字符抄了 11 遍。
 *
 * 开/关时**如何从 baseline 填字段、如何清覆盖**是每张卡自己的业务,全留在
 * `onToggle` 的调用方闭包里 —— 模具只管壳子的长相。
 */

import { GlassBox, Toggle } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { InheritNote } from "./inherit-note";

export interface OverrideBoxProps {
	title: string;
	subtitle?: string;
	/** 角光色,同 GlassBox。 */
	accent?: string;
	icon?: ReactNode;
	enabled: boolean;
	onToggle: (on: boolean) => void;
	/** 关闭(继承)时那句「未启用 · …」的后半句。 */
	inheritNote: ReactNode;
	/** 开启时的字段区。 */
	children: ReactNode;
}

export function OverrideBox({
	title,
	subtitle,
	accent,
	icon,
	enabled,
	onToggle,
	inheritNote,
	children,
}: OverrideBoxProps) {
	return (
		<GlassBox
			title={title}
			subtitle={subtitle}
			accent={accent}
			icon={icon}
			badge={enabled ? "覆盖中" : "继承"}
			right={<Toggle value={enabled} onChange={onToggle} ariaLabel={`覆盖:${title}`} />}
		>
			{enabled ? children : <InheritNote>{inheritNote}</InheritNote>}
		</GlassBox>
	);
}
