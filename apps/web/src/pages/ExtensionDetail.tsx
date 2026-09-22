import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	TabBar,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useExtensions } from "../hooks/useExtensions";
import { api } from "../services/api";
import { BridgeAddressRow, BridgeConnections } from "./extensions/bridge-panel";
import {
	DeclarativeConfig,
	DeclarativeHead,
	settingsFieldsOf,
} from "./extensions/declarative/extension-page";
import {
	EXTENSION_DOC_LABEL,
	type ExtensionDocKind,
	ExtensionDocPane,
	ExtensionDocsFailureNote,
	extensionDocIcon,
	useExtensionDocs,
} from "./extensions/docs-panel";
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
 * 头卡是**通用的**(名字 / 图标 / 说明 / 状态 / 开关,全来自清单);正文按**契约档位**分岔
 * (ADR-0019 决策 18 / 19):v2 照声明画 —— 头卡里是视图的页级积木,「配置」里是照清单画的
 * 设置;v1 只剩桥,那一页是手写的,迁过去之前一格不动。
 *
 * 开关也摆在这儿:点进来正是为了摆弄它,只能回列表去拨的话这一页就是块只读展板。
 *
 * **正文分 tab:配置 / 说明 / 更新日志。** 文档曾经直接摞在配置底下,而说明动辄一整页 ——
 * 配置区被一堵正文压着,更新日志被挤出视野。头卡不进 tab:它是身份、开关与卸载,换哪一档
 * 都得看得见。只剩一档时整条 tab 不出现 —— 一个按钮的 tab 条只会让人以为还有别的可点。
 */
/** 页面级的三档。配置那一档只在拓展真交了面板时才有。 */
type DetailTab = "config" | ExtensionDocKind;

export default function ExtensionDetail() {
	const { id = "" } = useParams<{ id: string }>();
	const listed = useExtensions();
	const toggle = useExtensionToggle();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const docs = useExtensionDocs(id);
	const [picked, setPicked] = useState<DetailTab | null>(null);

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
	// 按档位分,不按 id:桥迁到 v2 之后还叫 bridge,那时它就该走照声明画的那一页。
	const declarative = ext.apiVersion === 2;
	const isBridge = id === "bridge" && !declarative;
	/*
	 * 没东西可配的拓展**不摆「配置」那一档** —— 点进去是空的,比不摆更糟。v1 只有桥有;v2 看
	 * 清单里有没有设置项(决策 25)。所以一个既没面板又没文档的拓展这里一档都没有,正文整块不画。
	 */
	const hasConfig = isBridge || (declarative && settingsFieldsOf(ext).length > 0);
	const tabs: DetailTab[] = [...(hasConfig ? (["config"] as const) : []), ...docs.kinds];
	/* 选中项每次都从「现在有哪几档」里挑:重取之后那一档可能没了,停在空档上就是一整块白。 */
	const tab: DetailTab | null =
		tabs.length === 0 ? null : picked && tabs.includes(picked) ? picked : tabs[0];
	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/*
			 * 🔴 **返回得看得出来是能点的。** 这一格一直是粉色可点的,但只有颜色没有动作提示 ——
			 * 主人反馈普通用户根本不知道点「拓展」两个字能回上一级。加一枚**常驻**的左箭头:
			 * hover 才出现的提示救不了「不知道能点」—— 那是发现问题,不是反馈问题。读屏器念的
			 * 是整句「返回拓展列表」,与这一页空态 / 错误态里那句是同一个词。
			 */}
			<div className="flex items-center gap-1.5 text-bn-xs text-bn-text-tertiary">
				<Link
					to="/extensions"
					aria-label="返回拓展列表"
					className="flex items-center gap-1 font-bold text-bn-pink transition hover:underline hover:opacity-80"
				>
					<Icon.arrowLeft size={12} />
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
					) : declarative ? (
						<DeclarativeHead ext={ext} />
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
						{/* v2 头卡正文让给了积木,版本号挪到这一句的开头(决策 24 的五处之一)。 */}
						{declarative && ext.version ? `v${ext.version} · ` : ""}
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

			{tab && tabs.length > 1 ? (
				<TabBar<DetailTab>
					items={tabs.map((t) =>
						t === "config"
							? { id: t, label: "配置", icon: <Icon.gear size={14} /> }
							: { id: t, label: EXTENSION_DOC_LABEL[t], icon: extensionDocIcon(t, 14) },
					)}
					value={tab}
					onChange={setPicked}
				/>
			) : null}

			{/* 读不到文档这件事哪一档都该看得见 —— 它说的是整个拓展的文档拿不到。 */}
			{docs.failure ? <ExtensionDocsFailureNote failure={docs.failure} /> : null}

			{tab === "config" ? (
				declarative ? (
					<DeclarativeConfig ext={ext} />
				) : (
					<BridgeConnections extensionId={id} enabled={ext.enabled} />
				)
			) : tab ? (
				<ExtensionDocPane kind={tab} text={docs.text[tab] as string} />
			) : null}

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
