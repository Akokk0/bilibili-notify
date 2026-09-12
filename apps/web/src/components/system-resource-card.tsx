import type { ResourceSample, ResourceStatic } from "@bilibili-notify/contract";
import { Donut, ErrorNote, GlassPanel, Icon, LoadingBlock, Pill } from "@bilibili-notify/ui";
import type { ReactNode } from "react";
import { SECTION_ACCENT } from "../config/section-accents";
import type { ResourcesState } from "../hooks/useResourcesChannel";
import { Sparkline } from "../pages/stats/charts";

/**
 * 概览页「系统资源」卡 —— CPU / 内存 / 本体 / 浏览器的实时读数。
 *
 * 两个环是主角:环心报**总**占用,环上把「本体」与「其他」画成首尾相接的两段 ——
 * 「我们占了多少」与「这台机器一共用了多少」在一个环里同时读得出来。文字退成辅助小字。
 *
 * 语气上的一条硬要求:**量不到就说量不到**。首帧算不出 CPU 比例、容器里读不到浏览器
 * 子树、浏览器空闲被关掉 —— 这些都显示成「—」或那一档专门的话,绝不画成 0,
 * 「占 0MB」和「没量到」在排查时是完全相反的两条线索。
 */

/** 与服务端 `HEAP_WARN_RATIO` 同一个数:徽章变色与日志出 warn 必须同时发生。 */
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

/** 「本体」那段的两种颜色;「其他」共用一档静默灰,免得一个环里四种颜色抢戏。 */
const BN_CPU_TONE = "var(--color-bn-blue)";
const BN_MEM_TONE = "var(--color-bn-pink)";
const REST_TONE = "var(--color-bn-inactive)";
/**
 * 「总量量到了,但分不出谁占的」那一档 —— 比「其他」更淡的一圈。
 *
 * 🔴 **不能拿 `REST_TONE` 顶替**:那一档是一句断言(「这些不是我们占的」),整圈涂成它
 * 等于白纸黑字写着「这台机器忙成这样,一点都不是我们」—— 排查时最会把人带偏的一句话。
 */
const UNKNOWN_TONE = "var(--color-bn-text-disabled)";

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

/**
 * 本体 CPU 换算到「宿主机全部核」这个分母上。
 *
 * `procCpu` 的分母是**可用核数**(容器里是 cgroup 配额),`hostCpu` 的分母是整机所有核。
 * 两个不同分母的比例直接相减会得出一段假的「其他」—— 有配额时差得尤其离谱。
 */
function bnCpuOfHost(sample: ResourceSample, statics: ResourceStatic): number | null {
	if (sample.procCpu === null) return null;
	if (statics.hostCores <= 0) return null;
	return (sample.procCpu * statics.cpuBudget) / statics.hostCores;
}

/**
 * 「其他」= 总 − 本体,夹到 0。
 *
 * 两个数不是同一瞬间读出来的,本体偶尔会量得比总量还大。真正把负值挡住的是 `Donut`
 * (它对每段都夹一次);这里夹是为了让这个函数自己算出来的东西就说得通 —— 一段负长度的
 * 弧交出去、指望画的人替我们兜,读代码的人得跑到组件里才知道会发生什么。
 */
function restOf(total: number, bn: number): number {
	return Math.max(0, total - bn);
}

function Gauge({
	title,
	total,
	bn,
	bnTone,
	caption,
	detail,
}: {
	title: string;
	/** 环心那个数,也是两段之和。null = 这一帧还算不出来。 */
	total: number | null;
	/**
	 * 本体那一段。
	 *
	 * 🔴 `null` 是「**量不到**」,不是 0(首帧没有上一次可比、cgroup 里读不到核数)。
	 * 当成 0 画的话本体那段消失、整圈剩下「其他」—— 一句彻头彻尾的假话,而文件头第一条
	 * 要求就是「量不到就说量不到」。这时候只画一整圈「分不出谁占的」。
	 */
	bn: number | null;
	bnTone: string;
	caption: string;
	detail: ReactNode;
}) {
	const segments =
		total === null
			? []
			: bn === null
				? [{ value: total, color: UNKNOWN_TONE }]
				: [
						{ value: bn, color: bnTone },
						{ value: restOf(total, bn), color: REST_TONE },
					];
	return (
		<div className="flex flex-col items-center gap-1.5">
			<Donut
				segments={segments}
				size={132}
				stroke={13}
				title={title}
				label={
					<div className="text-center leading-none">
						<div className="tabular-nums text-bn-hero font-bold text-bn-text-primary">
							{percent(total)}
						</div>
						<div className="mt-1.5 text-bn-2xs text-bn-text-secondary">{caption}</div>
					</div>
				}
			/>
			{/*
			 * 底下这行是环上那段的**色标**。本体量不到时环上没有那一段,色标也就跟着退到
			 * 「分不出」那一档 —— 指着一个环上并不存在的颜色说「本体」同样是在说假话。
			 */}
			<span
				className="inline-flex items-center gap-1 text-bn-xs font-bold"
				style={{ color: bn === null ? UNKNOWN_TONE : bnTone }}
			>
				<span
					className="block h-2 w-2 rounded-sm"
					style={{ background: bn === null ? UNKNOWN_TONE : bnTone }}
				/>
				{detail}
			</span>
		</div>
	);
}

/** 辅助小字里的一格:标签在上、值在下,占一列。 */
function Fact({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="min-w-0">
			<div className="truncate text-bn-2xs text-bn-text-secondary">{label}</div>
			<div className="truncate tabular-nums text-bn-xs font-bold text-bn-text-primary">{value}</div>
		</div>
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
	// 浏览器是我们起的子进程,它占的内存算我们头上 —— 拆开写在小字里。
	const bnMemBytes = ready ? latest.rss + (latest.browserRss ?? 0) : null;
	// 环上那一段与它底下那句小字讲的是同一个数,同一帧算一次。
	const bnCpu = ready ? bnCpuOfHost(latest, statics) : null;
	const memTotal = statics?.memTotal ?? 0;

	return (
		<GlassPanel
			title="系统资源"
			subtitle="实时刷新 · 每 2 秒"
			accent={SECTION_ACCENT.system}
			icon={<Icon.pulse width={15} height={15} />}
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
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-start justify-center gap-x-8 gap-y-5">
						<Gauge
							title="CPU 占用"
							total={latest.hostCpu}
							bn={bnCpu}
							bnTone={BN_CPU_TONE}
							caption="CPU"
							detail={`本体 ${percent(bnCpu)}`}
						/>
						<Gauge
							title="内存占用"
							total={memTotal > 0 ? latest.memUsed / memTotal : null}
							bn={memTotal > 0 && bnMemBytes !== null ? bnMemBytes / memTotal : null}
							bnTone={BN_MEM_TONE}
							caption="内存"
							detail={`本体 ${bytes(bnMemBytes)}`}
						/>
					</div>

					{/* xl 起四列:那一档下这张卡拿到整行 1.6/2.6 的宽度,四个数(内存 / 堆 /
					    常驻 / 浏览器)正好排满一行,三列会把浏览器挤到下一行去陪 sparkline。 */}
					<div className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-bn-border-subtle pt-3 sm:grid-cols-3 xl:grid-cols-4">
						<div className="col-span-2 min-w-0 sm:col-span-3 xl:col-span-4">
							<div className="text-bn-2xs text-bn-text-secondary">处理器</div>
							<div
								className="truncate text-bn-xs font-bold text-bn-text-primary"
								title={statics.cpuModel}
							>
								{statics.cpuModel || "—"} · {statics.hostCores} 核
							</div>
						</div>
						<Fact
							label={statics.memSource === "cgroup" ? "容器配额" : "宿主机内存"}
							value={`${bytes(latest.memUsed)} / ${bytes(memTotal)}`}
						/>
						<Fact
							label="本体堆"
							value={
								<span style={{ color: heapTone(heapRatio ?? 0) }}>
									{bytes(latest.heapUsed)} / {bytes(statics.heapLimit)}
								</span>
							}
						/>
						<Fact label="本体常驻" value={bytes(latest.rss)} />
						<Fact label="浏览器" value={browserText(latest)} />
						<div className="col-span-2 flex flex-col justify-center gap-0.5 sm:col-span-1">
							<Sparkline
								data={state.history.map((s) => s.heapUsed / statics.heapLimit)}
								color={heapTone(heapRatio ?? 0)}
								width={140}
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
