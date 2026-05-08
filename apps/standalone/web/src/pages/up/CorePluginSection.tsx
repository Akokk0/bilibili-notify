import { useNavigate } from "react-router-dom";
import { Btn } from "../../components/atoms";
import { GlassBox } from "../../components/glass-box";
import type { PushTarget } from "../../types/domain";
import type { GlobalConfig } from "../../types/globals";

/**
 * Read-only summary panel embedded at the top of the Subs page. Mirrors
 * `.bn-design/variation-ac-plugins.jsx#CorePluginSection`'s collapsed shape:
 * five SummaryStat chips covering the highest-signal `globals.app` + master
 * fields. Editing lives on the Rules page so we don't duplicate the form
 * surface — the right-side "调整" button hops the user there.
 *
 * Fields the design source shows that are deliberately omitted:
 *   - dynamicUrl / dynamicVideoUrlToBV / pushImgsInDynamic — these
 *     DynamicEngine flags aren't part of GlobalConfig.app yet (plan §3 single-
 *     source-schema rule). Surface them in UI only after schema lands.
 *   - master.platform / master.masterAccount — replaced by master.targetId
 *     (plan §2.1) which references a PushTarget row instead of a free-form
 *     platform string.
 */

const LOG_LEVEL_LABEL: Record<GlobalConfig["app"]["logLevel"], string> = {
	error: "ERROR",
	info: "INFO",
	debug: "DEBUG",
};

interface Props {
	globals: GlobalConfig | undefined;
	targets: PushTarget[];
}

export function CorePluginSection({ globals, targets }: Props) {
	const navigate = useNavigate();
	const masterTarget = globals?.master?.targetId
		? targets.find((t) => t.id === globals.master.targetId)
		: undefined;
	const masterLabel = !globals?.master?.targetId
		? "未配置"
		: masterTarget
			? masterTarget.name
			: "目标已删除";

	return (
		<GlassBox
			title="订阅总开关 · Core"
			subtitle="全局抓取频率、Master 账号、历史保留"
			accent="#FB7299"
			icon="核"
			badge="全局"
			right={
				<Btn size="sm" variant="outline" onClick={() => navigate("/rules")}>
					调整 →
				</Btn>
			}
			dense
		>
			<div className="flex flex-wrap gap-x-5 gap-y-1 py-1 text-[12px]">
				<SummaryStat label="检查频率" value={globals?.app.dynamicCron ?? "—"} mono />
				<SummaryStat
					label="日志等级"
					value={globals ? LOG_LEVEL_LABEL[globals.app.logLevel] : "—"}
				/>
				<SummaryStat label="Master 账号" value={masterLabel} accent={!masterTarget} />
				<SummaryStat
					label="健康检查"
					value={globals ? `${globals.app.healthCheckMinutes}min` : "—"}
				/>
				<SummaryStat
					label="历史留存"
					value={globals ? `${globals.app.historyRetentionDays}天` : "—"}
				/>
			</div>
		</GlassBox>
	);
}

function SummaryStat({
	label,
	value,
	mono,
	accent,
}: {
	label: string;
	value: string;
	mono?: boolean;
	accent?: boolean;
}) {
	return (
		<div className="flex items-baseline gap-1.5">
			<span className="text-[11px] text-bn-text-tertiary">{label}</span>
			<span
				className={`text-[12.5px] font-bold ${
					accent ? "text-bn-text-tertiary" : "text-bn-text-primary"
				} ${mono ? "font-mono" : ""}`}
			>
				{value}
			</span>
		</div>
	);
}
