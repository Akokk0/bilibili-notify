import type { ExtensionsResponse } from "@bilibili-notify/contract";
import { EmptyNote, ErrorNote, GlassBox, Icon, LoadingBlock, Toggle } from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../services/api";
import { BridgeAddressRow, BridgeConnections } from "./extensions/bridge-panel";
import {
	ExtensionIcon,
	ExtensionStateDetail,
	ExtensionToggleError,
	PARAGRAPH_CLS,
	reasonOf,
	useExtensionToggle,
} from "./extensions/shared";
import { EXTENSION_STATE_META } from "./extensions/state-meta";

/**
 * `/extensions/:id` —— 一个拓展自己那一页。版式照设计稿 V1 的「BridgeDetail」:面包屑、
 * 一张头卡、然后是拓展自己那一节 —— **页面级的兄弟节点**,不套在头卡肚子里。
 *
 * 头卡是**通用的**(名字 / 图标 / 说明 / 状态 / 开关,全来自清单);正文是拓展自己交上来的
 * 面板数据,而它的形状 ADR-0012 决策 36 **刻意没约束** —— 所以眼下按 id 分岔,只有桥有。
 * 等第二个拓展也要面板时,再从两个真实例子里抽形状。
 *
 * 开关也摆在这儿:点进来正是为了摆弄它,只能回列表去拨的话这一页就是块只读展板。
 */
export default function ExtensionDetail() {
	const { id = "" } = useParams<{ id: string }>();
	const listed = useQuery({
		queryKey: ["extensions"],
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
	});
	const toggle = useExtensionToggle();

	if (listed.isPending) return <LoadingBlock label="正在读取拓展" />;
	/*
	 * 🔴 **「读不到」不许画成「没这个」**:表读不出来时 `find` 也交出 undefined,而底下
	 * 那句「没有装名叫 X 的拓展」是结论 —— 主人会照着它去重装一个其实好好装着的拓展。
	 */
	if (listed.isError) {
		return (
			<div className="bn-anim-page-in flex flex-col gap-3">
				<ErrorNote>读不到装了哪些拓展:{reasonOf(listed.error)}</ErrorNote>
				<Link to="/extensions" className="text-bn-sm text-bn-pink">
					← 回拓展列表
				</Link>
			</div>
		);
	}

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
	const isBridge = id === "bridge";
	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			<div className="flex items-center gap-1.5 text-bn-xs text-bn-text-tertiary">
				<Link to="/extensions" className="text-bn-pink hover:opacity-80">
					拓展
				</Link>
				<Icon.chevronRight size={12} />
				<span className="font-bold text-bn-text-secondary">{ext.name}</span>
			</div>

			<GlassBox
				title={ext.name}
				badge={meta.label}
				subtitle={ext.description}
				accent={meta.accent}
				icon={<ExtensionIcon svg={ext.icon} />}
				right={
					<Toggle
						ariaLabel={ext.name}
						value={ext.enabled}
						onChange={(on) => toggle.mutate({ id: ext.id, enabled: on })}
					/>
				}
			>
				<div className="flex flex-col gap-2.5">
					<ExtensionToggleError toggle={toggle} />
					<ExtensionStateDetail ext={ext} />
					{isBridge ? (
						<BridgeAddressRow extensionId={id} />
					) : (
						<p className={PARAGRAPH_CLS}>
							{ext.version ? `v${ext.version} · ` : ""}
							这个拓展没有交上来自己的面板。
						</p>
					)}
				</div>
			</GlassBox>

			{isBridge ? <BridgeConnections extensionId={id} enabled={ext.enabled} /> : null}
		</div>
	);
}
