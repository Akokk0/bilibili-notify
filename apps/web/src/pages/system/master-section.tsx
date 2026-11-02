import { isPrivateTarget } from "@bilibili-notify/internal/push-target";
import { GlassBox, Icon } from "@bilibili-notify/ui";
import { Field, TSelect } from "../../components/forms";
import { targetDisplay } from "../../components/target-display";
import { useT } from "../../i18n";
import type { Connection, PushTarget } from "../../types/domain";
import type { GlobalConfig, GlobalConfigPatch } from "../../types/globals";

/** 接收运行异常通知的私聊目标，与来源登录分开。 */
export function MasterSection({
	draft,
	targets,
	connections = [],
	onPatch,
}: {
	draft: Pick<GlobalConfig, "master">;
	targets: PushTarget[];
	connections?: readonly Connection[];
	onPatch: (delta: GlobalConfigPatch) => void;
}) {
	const tx = useT();
	const master = draft.master;
	const masterTarget = master.targetId ? targets.find((t) => t.id === master.targetId) : undefined;
	// 主人目标只许指向私聊目标(ADR-0021 决策 57):下拉只列私聊的;当前存着的值要是已经不满足
	// (指向群,或目标没了),就多显示一行不可选的「已失效」,免得下拉悄悄跳去「未配置」。
	const isStale = master.targetId !== undefined && !isPrivateTarget(masterTarget);
	const masterDisplay = masterTarget ? targetDisplay(masterTarget, connections) : undefined;
	const masterStatus = !master.targetId
		? tx("system.master.unsetStatus")
		: !masterTarget
			? tx("system.master.missing")
			: !isPrivateTarget(masterTarget)
				? tx("system.master.notPrivate")
				: `→ ${masterDisplay?.label} · ${masterDisplay?.description}`;

	return (
		<GlassBox
			title={tx("system.master.title")}
			subtitle={tx("system.master.subtitle")}
			accent="var(--color-bn-pink)"
			icon={<Icon.user size={14} />}
			badge="master"
		>
			<Field code="core.master.targetId">
				<TSelect
					value={master.targetId ?? ""}
					onChange={(v) => onPatch({ master: { targetId: v || undefined } })}
					options={[
						{ value: "", label: tx("system.master.unset") },
						...(isStale && master.targetId
							? [{ value: master.targetId, label: tx("system.master.stale"), disabled: true }]
							: []),
						...targets.filter((t) => isPrivateTarget(t)).map((t) => targetDisplay(t, connections)),
					]}
				/>
			</Field>
			<div className="mt-1.5 text-bn-xs text-bn-text-secondary">{masterStatus}</div>
		</GlassBox>
	);
}
