import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { EmptyNote, GlassBox, LoadingBlock, StatusDot } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../services/api";
import { BridgeConnections } from "./extensions/bridge-panel";
import { EXTENSION_STATE_META } from "./extensions/state-meta";

/**
 * `/extensions/:id` —— 一个拓展自己那一页。
 *
 * 头上那块是**通用的**(名字 / 说明 / 版本 / 跑没跑起来,全来自清单);底下那块是拓展
 * 自己交上来的面板数据,而它的形状 ADR-0012 决策 36 **刻意没约束** —— 所以眼下按 id 分岔,
 * 只有桥有一块。等第二个拓展也要面板时,再从两个真实例子里抽形状。
 */
export default function ExtensionDetail() {
	const { id = "" } = useParams<{ id: string }>();
	const listed = useQuery({
		queryKey: ["extensions"],
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
	});

	if (listed.isPending) return <LoadingBlock label="正在读取拓展" />;

	const ext = (listed.data?.extensions ?? []).find((candidate) => candidate.id === id);
	if (!ext) {
		// 地址栏是能手敲的,拓展也可能刚被删掉 —— 白屏的话主人分不清是「没这个」还是「坏了」。
		return (
			<div className="bn-anim-page-in flex flex-col gap-3">
				<EmptyNote>没有装名叫 {id} 的拓展</EmptyNote>
				<Link to="/extensions" className="text-bn-sm text-bn-pink">
					← 回拓展列表
				</Link>
			</div>
		);
	}

	const meta = EXTENSION_STATE_META[ext.state];
	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			<Link to="/extensions" className="text-bn-sm text-bn-text-tertiary hover:text-bn-pink">
				← 拓展
			</Link>
			<GlassBox
				title={ext.name}
				subtitle={ext.description}
				badge={
					<span className="flex items-center gap-1.5">
						<StatusDot kind={meta.dot} />
						{meta.label}
					</span>
				}
			>
				<div className="flex flex-col gap-4">
					{ext.version ? (
						<span className="font-mono text-bn-xs text-bn-text-tertiary">v{ext.version}</span>
					) : null}
					{id === "bridge" ? <BridgeConnections extensionId={id} /> : null}
				</div>
			</GlassBox>
		</div>
	);
}
