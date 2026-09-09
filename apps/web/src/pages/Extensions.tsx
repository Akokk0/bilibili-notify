import type {
	ExtensionDTO,
	ExtensionStateDTO,
	ExtensionsResponse,
} from "@bilibili-notify/contract";
import {
	EmptyNote,
	ErrorNote,
	GlassPanel,
	HintNote,
	LoadingBlock,
	Pill,
	StatusDot,
	Toggle,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../services/api";

/**
 * `/extensions` —— 装了哪些拓展、开没开、跑没跑起来。
 *
 * **卡片上的每一个字都来自服务端**(`GET /api/ext` → 拓展自己的清单):前端再抄一份的话,
 * 装进来一个我们没见过的拓展,它的卡片就是个灰方章。同理这一页**没有写死的拓展名单** ——
 * 盘上有什么就是什么。
 *
 * 开关不在这儿开专门的端点:它住 `globals.extensions.<id>.enabled`,与别的全局设置走
 * 同一条 `PATCH /api/globals`(ADR-0012)。
 */

/** 状态 → 说给主人听的那句话 + 状态点的档位。**开关与状态是两件事**,所以两样都印。 */
const STATE_META: Record<
	ExtensionStateDTO,
	{ label: string; dot: "ok" | "off" | "warn" | "err"; severity: "none" | "warn" | "err" }
> = {
	running: { label: "运行中", dot: "ok", severity: "none" },
	disabled: { label: "已停用", dot: "off", severity: "none" },
	blocked: { label: "已自动停用", dot: "warn", severity: "warn" },
	failed: { label: "加载失败", dot: "err", severity: "err" },
	unreadable: { label: "清单读不出来", dot: "err", severity: "err" },
	incompatible: { label: "版本不合", dot: "warn", severity: "warn" },
};

/** 它开的是哪一口 —— 清单里的机器词,印给人看要换句话。 */
const PROVIDES_LABEL: Record<string, string> = {
	push: "推送源",
	subscription: "订阅源",
};

function StateLine({ ext }: { ext: ExtensionDTO }) {
	const meta = STATE_META[ext.state];
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
			<span className="flex items-center gap-1.5 text-bn-sm text-bn-text-secondary">
				<StatusDot kind={meta.dot} />
				{meta.label}
			</span>
			{ext.version ? (
				<span className="font-mono text-bn-xs text-bn-text-tertiary">v{ext.version}</span>
			) : null}
			{(ext.provides ?? []).map((provide) => (
				<Pill key={provide} subtle color="var(--color-bn-pink)">
					{PROVIDES_LABEL[provide] ?? provide}
				</Pill>
			))}
		</div>
	);
}

/**
 * 「为什么没跑起来」。分红黄两档不是口味:清单坏了 / 加载炸了要主人去动手,而连败自动
 * 停用与版本不合是「换一版就好」,同一个红盒会让前者被当成后者放着不管。
 */
function StateDetail({ ext }: { ext: ExtensionDTO }) {
	if (!ext.detail) return null;
	const { severity } = STATE_META[ext.state];
	if (severity === "err") return <ErrorNote size="sm">{ext.detail}</ErrorNote>;
	if (severity === "warn") return <WarnNote size="sm">{ext.detail}</WarnNote>;
	return null;
}

export default function Extensions() {
	const qc = useQueryClient();
	const listed = useQuery({
		queryKey: ["extensions"],
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
	});

	const toggle = useMutation({
		// 🔴 补丁**只带自己那一格**。配置是 JSON Merge Patch,整张 `extensions` 表发出去
		// 的话,别处刚拨的开关会被这一发按回旧值 —— 两边都不报错。
		mutationFn: (next: { id: string; enabled: boolean }) =>
			api.patch("/api/globals", { extensions: { [next.id]: { enabled: next.enabled } } }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["extensions"] });
			void qc.invalidateQueries({ queryKey: ["globals"] });
		},
	});

	if (listed.isPending) return <LoadingBlock label="正在读取拓展" />;

	const extensions = listed.data?.extensions ?? [];

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/*
			 * ⚠️ 这句话是**必须**的,不是装饰:热装卸还没做(ADR-0012 决策 10 说得到,
			 * 地基只实现了开机时按开关决定装不装载)。不说的话,主人拨完开关看不出任何
			 * 变化,只会反复拨它找原因。
			 */}
			<HintNote>
				拓展是装进来的,不编在主程序里。拨动开关会立刻存下来,但要
				<strong className="text-bn-text-secondary">重启后生效</strong> —— 换掉一份正在跑的代码
				这件事,得等进程重来一次。
			</HintNote>

			{extensions.length === 0 ? (
				<EmptyNote>还没有装任何拓展</EmptyNote>
			) : (
				<div className="grid gap-4 md:grid-cols-2">
					{extensions.map((ext) => (
						<GlassPanel
							key={ext.id}
							title={ext.name}
							subtitle={ext.description}
							accent="var(--color-bn-pink)"
							right={
								<Toggle
									ariaLabel={ext.name}
									value={ext.enabled}
									onChange={(on) => toggle.mutate({ id: ext.id, enabled: on })}
								/>
							}
						>
							<div className="flex flex-col gap-2">
								<StateLine ext={ext} />
								<StateDetail ext={ext} />
							</div>
						</GlassPanel>
					))}
				</div>
			)}
		</div>
	);
}
