import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useExtensions } from "../hooks/useExtensions";
import { api } from "../services/api";
import { BridgeAddressRow, BridgeConnections } from "./extensions/bridge-panel";
import { ExtensionDocs } from "./extensions/docs-panel";
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
	const listed = useExtensions();
	const toggle = useExtensionToggle();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [confirming, setConfirming] = useState(false);

	/**
	 * 删完**离开这一页** —— 留在原地的话它立刻变成「没有装名叫 X 的拓展」,看起来像出了错。
	 *
	 * 失败时框留在原地并把服务端那句话原样摆出来:「还有 N 条连接在用它」是用户唯一能
	 * 照着做的线索,换成自编的「删除失败」等于让人对着黑盒按第二下。
	 */
	const remove = useMutation({
		mutationFn: () => api.delete<{ ok: true }>(`/api/ext/${id}`),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["extensions"] });
			navigate("/extensions");
		},
	});

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

				{/* 危险动作单独一行、摆在最底下 —— 别和开关挤在页头,误点的代价不对等。 */}
				<div className="mt-3 flex items-center justify-between gap-3 border-t border-bn-border-subtle pt-3">
					<span className="text-bn-2xs text-bn-text-tertiary">
						卸掉它:盘上那份与它自己的设置都会没,随时能再装回来。
					</span>
					<Btn
						variant="danger-outline"
						size="sm"
						icon={<Icon.trash size={13} />}
						onClick={() => setConfirming(true)}
					>
						删除拓展
					</Btn>
				</div>
			</GlassBox>

			{isBridge ? <BridgeConnections extensionId={id} enabled={ext.enabled} /> : null}

			{/* 说明摆在最底下:来这一页多半是为了管连接,别让一页 README 把工作区挤下去。 */}
			<ExtensionDocs extensionId={id} />

			{confirming ? (
				<ConfirmDialog
					title={`删掉「${ext.name}」?`}
					message={
						<>
							<p className={PARAGRAPH_CLS}>
								盘上那份会被抹掉,<strong>删掉它的设置也会一起没</strong>
								{isBridge ? "(桥的话就是所有接入与 token,koishi 那侧要重填一遍)" : ""}
								。随时能从拓展市场再装回来。
							</p>
							{remove.isError ? (
								<ErrorNote size="sm" className="mt-2.5">
									{reasonOf(remove.error)}
								</ErrorNote>
							) : null}
						</>
					}
					confirmLabel={remove.isPending ? "正在删…" : "删掉它"}
					danger
					onConfirm={() => {
						if (!remove.isPending) remove.mutate();
					}}
					onCancel={() => setConfirming(false)}
				/>
			) : null}
		</div>
	);
}
