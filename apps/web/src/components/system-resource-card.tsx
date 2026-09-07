import type { ResourceSample } from "@bilibili-notify/contract";
import { Donut, ErrorNote, GlassPanel, Icon, LoadingBlock, Pill } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { SECTION_ACCENT } from "../config/section-accents";
import type { ResourcesState } from "../hooks/useResourcesChannel";
import { Sparkline } from "../pages/stats/charts";

/**
 * 概览页「系统资源」卡 —— CPU / 内存 / 本体 / 浏览器的实时读数。
 *
 * 语气上的一条硬要求:**量不到就说量不到**。首帧算不出 CPU 比例、容器里读不到浏览器
 * 子树、浏览器空闲被关掉 —— 这些都显示成「—」或那一档专门的话,绝不画成 0,
 * 「占 0MB」和「没量到」在排查时是完全相反的两条线索。
 */

/** 与服务端 `HEAP_WARN_RATIO` 同一个数:环变色与日志出 warn 必须同时发生。 */
const HEAP_WARN_RATIO = 0.85;
/** 再往上就只剩几十兆的余量,红。 */
const HEAP_DANGER_RATIO = 0.95;

export function heapTone(ratio: number): string {
	if (ratio >= HEAP_DANGER_RATIO) return "var(--color-bn-danger)";
	if (ratio >= HEAP_WARN_RATIO) return "var(--color-bn-warning)";
	return "var(--color-bn-pink)";
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** 字节转人话。GB 起保留一位小数,MB 取整 —— 卡上那一列不该跳字宽。 */
function bytes(n: number | null): string {
	if (n === null) return "—";
	if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
	return `${Math.round(n / MB)} MB`;
}

function percent(ratio: number | null): string {
	return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

/** 浏览器那一行说什么 —— 四态四句话,合并成「有 / 没有」会把后两种说成「没有」。 */
function browserText(sample: ResourceSample): string {
	switch (sample.browserState) {
		case "running":
			return bytes(sample.browserRss);
		case "closed":
			return "空闲已关";
		case "remote":
			return "远程";
		default:
			return "未接入";
	}
}

function Row({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-3 border-b border-bn-border-subtle py-1.5 last:border-b-0">
			<span className="text-bn-xs text-bn-text-secondary">{label}</span>
			<span className="tabular-nums text-bn-sm font-bold text-bn-text-primary">{value}</span>
		</div>
	);
}

function Gauge({
	title,
	value,
	color,
	caption,
}: {
	title: string;
	value: number | null;
	color: string;
	caption: string;
}) {
	return (
		<Donut
			value={value ?? 0}
			size={104}
			stroke={11}
			color={color}
			title={title}
			label={
				<div className="text-center leading-none">
					<div className="tabular-nums text-bn-xl font-bold text-bn-text-primary">
						{percent(value)}
					</div>
					<div className="mt-1 text-bn-2xs text-bn-text-secondary">{caption}</div>
				</div>
			}
		/>
	);
}

export function SystemResourceCard({
	state,
	reachable,
}: {
	state: ResourcesState;
	reachable: boolean;
}) {
	const latest = state.history.at(-1);
	const statics = state.static;
	const ready = reachable && statics && latest;
	const heapRatio = ready ? latest.heapUsed / statics.heapLimit : null;

	return (
		<GlassPanel
			title="系统资源"
			subtitle="实时刷新 · 每 2 秒"
			accent={SECTION_ACCENT.system}
			right={
				reachable ? (
					ready ? (
						<Pill color={heapTone(heapRatio ?? 0)} subtle size="sm">
							堆 {percent(heapRatio)}
						</Pill>
					) : undefined
				) : (
					<Pill color="var(--color-bn-danger)" subtle size="sm">
						失联
					</Pill>
				)
			}
		>
			{!reachable ? (
				<ErrorNote>
					后端 API 当前失联,资源读数已停止刷新 ——
					这里不拿最后一次的快照继续画,那会让人以为一切正常。
				</ErrorNote>
			) : !ready ? (
				<LoadingBlock variant="inset" label="正在读取系统资源" hint="第一帧到了就开始画" />
			) : (
				<div className="flex flex-col items-center gap-4 xl:flex-row xl:items-stretch">
					<div className="min-w-0 flex-1">
						<div className="mb-1 flex items-center gap-1.5 text-bn-sm font-bold text-bn-text-primary">
							<Icon.sliders size={13} />
							CPU
						</div>
						<div
							className="mb-1.5 truncate text-bn-xs text-bn-text-tertiary"
							title={statics.cpuModel}
						>
							{statics.cpuModel || "—"}
						</div>
						<Row label="核数" value={statics.hostCores} />
						<Row label="宿主机使用率" value={percent(latest.hostCpu)} />
						<Row label="本体" value={percent(latest.procCpu)} />

						<div className="mt-3 mb-1 flex items-center gap-1.5 text-bn-sm font-bold text-bn-text-primary">
							<Icon.check size={13} />
							内存
						</div>
						<Row
							label={statics.memSource === "cgroup" ? "容器配额" : "宿主机总量"}
							value={bytes(statics.memTotal)}
						/>
						<Row label="已用" value={bytes(latest.memUsed)} />
						<Row label="本体堆" value={`${bytes(latest.heapUsed)} / ${bytes(statics.heapLimit)}`} />
						<Row label="本体常驻" value={bytes(latest.rss)} />
						<Row label="浏览器" value={browserText(latest)} />
					</div>

					<div className="flex flex-none flex-col items-center justify-center gap-3">
						<Gauge
							title="CPU 占用"
							value={latest.procCpu}
							color="var(--color-bn-blue)"
							caption="本体 CPU"
						/>
						<Gauge
							title="堆占用"
							value={heapRatio}
							color={heapTone(heapRatio ?? 0)}
							caption="本体堆"
						/>
						<div className="flex flex-col items-center gap-0.5">
							<Sparkline
								data={state.history.map((s) => s.heapUsed / statics.heapLimit)}
								color={heapTone(heapRatio ?? 0)}
								width={104}
								height={22}
							/>
							<span className="text-bn-2xs text-bn-text-tertiary">近 5 分钟堆占用</span>
						</div>
					</div>
				</div>
			)}
		</GlassPanel>
	);
}
