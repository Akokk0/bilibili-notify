/**
 * 「从推送目标里勾几个」的胶囊选择器 —— 链接解析白名单与周报「发送到」共用这一份。
 *
 * 同一件事只该有一种长相:ToneChip 平铺、平台图标 + 目标名,点一下切换。**停用的目标
 * 照列照勾**,只在胶囊里标一句「已停用」—— 停用是暂停不是消失(主人定的:两处选择器
 * 行为一致);藏掉的话用户看不出它还在白名单里,恢复启用那天它就悄悄生效了。
 *
 * 纯展示件:取数、过滤(哪些平台 / 哪种 scope 能选)、颜色都由调用方定。缠着 api /
 * react-query 的取数留在调用方,所以它住 web 不进 `packages/ui`。
 */

import { EmptyNote, Pill, PlatformIcon, ToneChip } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import type { PushTarget } from "../types/domain";

export function TargetChipPicker({
	targets,
	selected,
	onToggle,
	tone,
	empty,
}: {
	targets: readonly PushTarget[];
	/** 已选的目标 id。 */
	selected: readonly string[];
	onToggle: (targetId: string) => void;
	/** 选中态的语义色(hex 或 `var()`),由所在功能定。 */
	tone: string;
	/** 一个候选都没有时显示的话;不给就什么都不画。 */
	empty?: ReactNode;
}) {
	if (targets.length === 0) {
		return empty ? (
			<EmptyNote size="sm" className="w-full">
				{empty}
			</EmptyNote>
		) : null;
	}
	const chosen = new Set(selected);
	return (
		<div className="flex flex-wrap gap-2">
			{targets.map((t) => (
				<ToneChip key={t.id} tone={tone} active={chosen.has(t.id)} onClick={() => onToggle(t.id)}>
					<PlatformIcon platform={t.platform} size={13} />
					{t.name}
					{t.enabled ? null : (
						<Pill size="sm" subtle color="var(--color-bn-inactive)">
							已停用
						</Pill>
					)}
				</ToneChip>
			))}
		</div>
	);
}
