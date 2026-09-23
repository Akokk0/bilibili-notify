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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ExtensionViewBoundary } from "../components/error-boundary";
import { EXTENSIONS_QUERY_KEY, useExtensions } from "../hooks/useExtensions";
import { api } from "../services/api";
import { isExtensionSubscription, type Subscription } from "../types/domain";
import { CardMotionStage } from "./extensions/card-motion-stage";
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
import { EXT_CARD_ANCHOR } from "./extensions/install-flight";
import { LegacyFormatNote } from "./extensions/legacy-format-note";
import { MarketplaceInstallConfirm, useMarketplaceInstall } from "./extensions/marketplace-section";
import { ReportProblemsBox } from "./extensions/report-problems";
import {
	ExtensionIcon,
	ExtensionStateDetail,
	ExtensionToggleError,
	PARAGRAPH_CLS,
	reasonOf,
	useExtensionToggle,
} from "./extensions/shared";
import { StagedCodeNote, stagedFactsOf } from "./extensions/staged-code-note";
import { EXTENSION_STATE_META } from "./extensions/state-meta";

/**
 * `/extensions/:id` —— 一个拓展自己那一页。版式照设计稿 V1 的「BridgeDetail」:面包屑、
 * 一张头卡、然后是拓展自己那一节 —— **页面级的兄弟节点**,不套在头卡肚子里。
 *
 * 头卡是**通用的**(名字 / 图标 / 说明 / 状态 / 开关,全来自清单);正文按**契约档位**分岔
 * (ADR-0019 决策 18 / 19):v2 照声明画 —— 头卡里是视图的页级积木,「配置」里是照清单画的
 * 设置;v1 没有面板,头卡里是「老格式,去市场更新之后才能在这里管理」那块提示与更新入口
 * (决策 44)。这一页**不认得任何具体拓展**:桥的那一页手写过,迁到 v2 之后退役了(决策 19)。
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
	/*
	 * 老格式拓展头卡里那颗「更新」走的是市场那一份(ADR-0019 决策 44)—— 确认框、换装都挂在它上面,
	 * 所以由页面持有:更新成了之后它变成 v2、那块提示随之卸掉,这一份不能跟着没。
	 *
	 * 「装完那句话」(`ExtensionInstallOutcome`)这一页**不画**:更新成了之后头卡自己就换了脸 ——
	 * 跑着的那份多出「新版等着换上」那块(同样两条出路),关着的直接成了 v2、长出「配置」。再摆一份
	 * 就是同一块提示、同两颗钮出两遍。
	 */
	const installer = useMarketplaceInstall();
	/*
	 * 卸掉之后它名下的订阅**保留**、暂停(ADR-0019 决策 10)—— 确认框得说清有几条,否则主人会以为
	 * 它们跟着没了。与订阅页同一个键:那边刚改过的,这边直接用缓存。只在框开着、或有「上报问题」
	 * 要按订阅 id 印名字时才去读 —— 详情页每进一次都拉一遍整张订阅表,换来的只是框里那一句。
	 */
	const hasReportProblems =
		(listed.data?.extensions.find((one) => one.id === id)?.reportProblems ?? []).length > 0;
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subs"),
		enabled: confirming || hasReportProblems,
	});
	const keptSubs = (subsQuery.data ?? []).filter(
		(sub) => isExtensionSubscription(sub) && sub.extensionId === id,
	).length;

	/**
	 * 删完**离开这一页** —— 留在原地的话它立刻变成「没有装名叫 X 的拓展」,看起来像出了错。
	 *
	 * 失败时框留在原地并把服务端那句话原样摆出来:「还有 N 条连接在用它」是用户唯一能
	 * 照着做的线索,换成自编的「删除失败」等于让人对着黑盒按第二下。
	 */
	const remove = useMutation({
		mutationFn: () => api.delete<{ ok: true }>(`/api/ext/${id}`),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY });
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
	/*
	 * 盘上有一份这个进程干净地换不上的新代码(ADR-0012 决策 47)—— 跑着旧的、开着却没跑、关着
	 * 三档都算;关着的只给「重启 BN」(只重载会把它跑起来)。没有就一颗钮都不给:生产上不给随手
	 * 漏模块的口子。`restart` 与 `staged` 是同一版服务端才有的两格,老服务端两格都没有,这块也就不画。
	 */
	const staged = stagedFactsOf(ext);
	const restart = listed.data?.restart;
	// 按档位分,不按 id —— 认得某个具体拓展,就是「本体不认得拓展」那条的破口。
	const declarative = ext.apiVersion === 2;
	// 老格式:这一版还认、照样跑,但这一页管不了它 —— 得说清怎么办(ADR-0019 决策 44)。
	const legacy = ext.apiVersion === 1;
	/*
	 * 没东西可配的拓展**不摆「配置」那一档** —— 点进去是空的,比不摆更糟。v1 一律没有;v2 看
	 * 清单里有没有设置项(决策 25)。所以一个既没面板又没文档的拓展这里一档都没有,正文整块不画。
	 */
	const hasConfig = declarative && settingsFieldsOf(ext).length > 0;
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

			{/*
			 * 换装的落点靠这个属性找(`install-flight.tsx`),与列表页那张卡同一个;包一层是因为
			 * GlassBox 不透传 data-*。老格式拓展在这儿就地更新,球得落在这张头卡上。
			 */}
			<div {...{ [EXT_CARD_ANCHOR]: ext.id }}>
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
						{/* 排在正文前面:这是等着主人拿主意的事,积木是看的。 */}
						{staged && restart ? (
							<StagedCodeNote id={ext.id} restart={restart} {...staged} />
						) : null}
						{/*
						 * 照拓展声明画的两块各包一层边界:那是拓展交来的视图,炸了只换掉那一块 —— 头卡的
						 * 名字、开关、删除钮与页上别的部分照常(`error-boundary.tsx`)。
						 */}
						{declarative ? (
							<ExtensionViewBoundary resetKey={ext.id}>
								<DeclarativeHead ext={ext} />
							</ExtensionViewBoundary>
						) : legacy ? (
							<LegacyFormatNote ext={ext} installer={installer} />
						) : (
							<p className={PARAGRAPH_CLS}>
								{ext.version ? `v${ext.version} · ` : ""}
								这个拓展没有交上来自己的面板。
							</p>
						)}
					</div>

					{/*
					 * 危险动作单独一行、摆在最底下 —— 别和开关挤在页头,误点的代价不对等。
					 * 上面那块正文一样都没画的时候(v2 拓展没跑 / 只有设置项、没交视图),`:empty` 的正文
					 * 后面这一行就不再留上边距与分隔线 —— 否则头卡里是两根线夹着一条空白带。
					 */}
					<div className="mt-3 flex items-center justify-between gap-3 border-t border-bn-border-subtle pt-3 [:empty+&]:mt-0 [:empty+&]:border-t-0 [:empty+&]:pt-0">
						<span className="text-bn-2xs text-bn-text-tertiary">
							{/*
							 * v2 头卡正文让给了积木,版本号挪到这一句的开头(决策 24 的五处之一);v1 的正文
							 * 让给了「老格式」那块提示,版本号同样挪到这儿。
							 */}
							{(declarative || legacy) && ext.version ? `v${ext.version} · ` : ""}
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
			</div>

			{/* 订阅源报上来、BN 没照单全收的几条(决策 60)—— 有才出现。 */}
			<ReportProblemsBox ext={ext} subs={subsQuery.data} />

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
				<ExtensionViewBoundary resetKey={ext.id}>
					<DeclarativeConfig ext={ext} />
				</ExtensionViewBoundary>
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
								。随时能从拓展市场再装回来。
							</p>
							{keptSubs > 0 ? (
								<p className={`mt-2 ${PARAGRAPH_CLS}`}>有 {keptSubs} 条订阅会保留(暂停)</p>
							) : null}
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

			{/*
			 * 第三方来源的更新先过这道确认框。只在真有一条等着确认时才挂:这个框自己要问市场
			 * (印源的名字),常挂着的话每进一次详情页都去拉一遍索引,v2 拓展根本用不上。
			 */}
			{installer.confirming ? <MarketplaceInstallConfirm installer={installer} /> : null}
			{/* 更新的换装 —— 演完自己收摊,失败 / 减少动态时当场收摊。 */}
			<CardMotionStage />
		</div>
	);
}
