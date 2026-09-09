import type { ExtensionDTO, ExtensionsResponse } from "@bilibili-notify/contract";
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
import { Link } from "react-router-dom";
import { api } from "../services/api";
import { EXTENSION_STATE_META } from "./extensions/state-meta";

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

/** 它开的是哪一口 —— 清单里的机器词,印给人看要换句话。 */
const PROVIDES_LABEL: Record<string, string> = {
	push: "推送源",
	subscription: "订阅源",
};

function StateLine({ ext }: { ext: ExtensionDTO }) {
	const meta = EXTENSION_STATE_META[ext.state];
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
	const { severity } = EXTENSION_STATE_META[ext.state];
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
			 * ⚠️ 这句话是**必须**的,不是装饰:开关热、代码不热(ADR-0012 决策 10)。两半
			 * 都要说 —— 只说前半,主人换完代码会以为拨一下开关就够;只说后半,他会为一次
			 * 停用去重启整个进程,还顺手把别的推送一起停了。
			 */}
			<HintNote>
				拓展是装进来的,不编在主程序里。拨动开关
				<strong className="text-bn-text-secondary">立刻生效</strong>:关掉当场收摊(正连着的
				插件会被断开,配置全留),打开就地装起来。装进来一个新拓展、或者换掉一份拓展的代码,
				才要重启一次 —— 已经加载的代码在进程里换不掉。
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
								{/* 详情页那块是拓展自己交上来的面板数据 —— 没有入口的话只能手敲地址。 */}
								<Link
									to={`/extensions/${ext.id}`}
									className="self-start text-bn-xs text-bn-text-tertiary hover:text-bn-pink"
								>
									详情 →
								</Link>
							</div>
						</GlassPanel>
					))}
				</div>
			)}
		</div>
	);
}
