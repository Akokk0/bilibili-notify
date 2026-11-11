import type { ExtensionEntryView, MarketplaceEntryView } from "@bilibili-notify/contract";
import {
	BELOW_HEADER_TOP,
	Btn,
	EmptyNote,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Picker,
	Pill,
	Toggle,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
	DevelopmentMountButtonSlot,
	DevelopmentMountNoteSlot,
} from "../components/development-extension-ui";
import { useExtensions } from "../hooks/useExtensions";
import { useScrollToHash } from "../hooks/useScrollToHash";
import { useT } from "../i18n";
import { api } from "../services/api";
import { useCardMotionStore } from "./extensions/card-motion";
import { CardMotionStage } from "./extensions/card-motion-stage";
import { ExtensionSummary } from "./extensions/declarative/extension-page";
import { ExtensionInstallDialog } from "./extensions/install-dialog";
import { cardSelector, EXT_CARD_ANCHOR, reducedMotion } from "./extensions/install-flight";
import { ExtensionInstallOutcome } from "./extensions/install-outcome";
import {
	MARKETPLACE_SECTION_HASH,
	MarketplaceInstallConfirm,
	type MarketplaceInstaller,
	MarketplaceSection,
	MarketplaceUpdateOffer,
	useMarketplace,
	useMarketplaceInstall,
} from "./extensions/marketplace-section";
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
 * `/extensions` —— 装了哪些拓展、各开在哪一口、开没开。
 *
 * 版式照 ADR-0025 决策 13:页头按口单选筛选,每个拓展一张卡;卡 = 头
 * (图标 / 名字 / 状态徽章 / 开关)+ 一段描述 + 「N 条连接 · 视图交来的那一行」+ 右下「管理 ›」。
 *
 * 这一页**不认得任何具体拓展**(ADR-0012):「N 条连接」按 `provides` 数,后面那一行由拓展
 * 自己的视图交(`summary`,ADR-0019 决策 25)—— 桥的「N 个 bot 在线」就是这么来的。
 */

/**
 * 连接表里这一页要看的那几格。整张 `Connection` 是业务域的,这里只数「谁名下有几条」,
 * 不需要认得别的字段。
 */
interface ConnectionRow {
	adapterKey?: string;
}

type Provides = NonNullable<ExtensionEntryView["provides"]>[number];

function useProvidesLabels() {
	const t = useT();
	return {
		push: t("extensions.provides.push"),
		subscription: t("extensions.provides.subscription"),
	} satisfies Record<Provides, string>;
}

/**
 * 「从它借来的 bot 建了几条连接」(一条连接就是一个 bot,ADR-0012 决策 45)。任何开推送源
 * 那一口的拓展都有连接,按 `provides` 判就够,不必认得是谁;别的连接(直连的 OneBot)不算数。
 * 0 也要报 —— 那正是「装好了但还没接上」。桥的接入(token 那条)不在这儿数,它在详情页。
 */
function ConnectionCount({ count }: { count: number }) {
	const t = useT();
	return (
		<div className="flex items-baseline gap-[5px]">
			<span className="text-bn-xl font-bold leading-none text-bn-text-primary">{count}</span>
			<span className="text-bn-xs text-bn-text-tertiary">
				{t("extensions.connectionCount", { count })}
			</span>
		</div>
	);
}

/** 整张连接表数一遍:谁名下几条。逐卡各扫一遍全表的话,装了 N 个拓展就扫 N 遍。 */
function countByExtension(rows: readonly ConnectionRow[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		// 内置适配器的键进不了拓展 id(保留 id),所以不必先筛掉内置的。
		if (row.adapterKey === undefined) continue;
		counts.set(row.adapterKey, (counts.get(row.adapterKey) ?? 0) + 1);
	}
	return counts;
}

function ExtensionCard({
	ext,
	count,
	onToggle,
	update,
	installer,
	elsewhere,
}: {
	ext: ExtensionEntryView;
	/** 从它借来的 bot 建了几条连接。 */
	count: number;
	onToggle: (enabled: boolean) => void;
	/** 市场里这条有更新的那一版(ADR-0013)。没有就不画。 */
	update?: MarketplaceEntryView;
	/** 页面那一份「从市场装」—— 更新钮走的是它(第三方那道确认框在里面)。 */
	installer: MarketplaceInstaller;
	/**
	 * 市场里也有这个 id,但装着的这份不是从那儿来的(手动传包装的最常见)。
	 *
	 * 🔴 **这句话只能在这里说**:已装的拓展不在市场那一节露面了,而这一档偏偏既不提示
	 * 更新、又确实有另一份可拿 —— 不说的话,主人既不知道市场里有,也不知道这张卡为什么
	 * 从来不提示更新。**不许画成「更新」钮**:按下去等于换成一份来路不同的代码。
	 */
	elsewhere?: { entry: MarketplaceEntryView; sourceName: string };
}) {
	const t = useT();
	const labels = useProvidesLabels();
	const meta = EXTENSION_STATE_META[ext.state];
	const pushes = (ext.provides ?? []).includes("push");
	const declarative = ext.apiVersion !== undefined;
	return (
		<GlassBox
			className="h-full"
			title={ext.name}
			badge={meta.label}
			subtitle={ext.version ? `v${ext.version}` : undefined}
			accent={meta.accent}
			icon={<ExtensionIcon svg={ext.icon} />}
			right={<Toggle ariaLabel={ext.name} value={ext.enabled} onChange={(on) => onToggle(on)} />}
		>
			<div className="flex h-full flex-col gap-3">
				{ext.description ? <p className={PARAGRAPH_CLS}>{ext.description}</p> : null}
				<div className="flex flex-wrap gap-1">
					{ext.provides === undefined ? (
						<Pill subtle size="sm">
							{t("extensions.provides.unknown")}
						</Pill>
					) : ext.provides.length === 0 ? (
						<Pill subtle size="sm">
							{t("extensions.provides.empty")}
						</Pill>
					) : (
						ext.provides.map((code) => (
							<Pill key={code} subtle size="sm">
								{labels[code]}
							</Pill>
						))
					)}
				</div>
				<ExtensionStateDetail ext={ext} />
				<DevelopmentMountNoteSlot id={ext.id} />
				{/*
				 * 盘上有新版等着换上(ADR-0012 决策 47),而徽章说的是别的 —— 跑着旧的是「已启用」
				 * (它确实在跑),关着的是「已停用」—— 所以另说一句。出路(重启 BN / 只重载)只在
				 * 详情页,卡上不摆按钮;开着却没跑的那一档徽章自己就说了(「新版等着换上」)。
				 */}
				{ext.staged && ext.state !== "staged" ? (
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<Pill subtle size="sm" color="var(--color-bn-warning)">
							{/* 版本号没变只可能出在跑着的那一档(关着的 `version` 本来就是盘上那一版)。 */}
							{ext.state === "running" && ext.staged.version === ext.version
								? t("extensions.staged.same")
								: t("extensions.staged.version", { version: ext.staged.version })}
						</Pill>
						<span className="text-bn-2xs text-bn-text-tertiary">
							{t("extensions.staged.manage")}
						</span>
					</div>
				) : null}
				{update ? <MarketplaceUpdateOffer entry={update} installer={installer} /> : null}
				{elsewhere ? (
					<p className="text-bn-2xs text-bn-text-tertiary">
						{t("extensions.elsewhere", {
							source: elsewhere.sourceName,
							version: elsewhere.entry.version,
						})}
					</p>
				) : null}
				{pushes ? (
					<div className="flex items-center gap-3.5 pt-0.5">
						<ConnectionCount count={count} />
						{declarative ? <ExtensionSummary ext={ext} divider /> : null}
					</div>
				) : declarative ? (
					// 订阅源没有「N 条连接」那一行,它的 summary 自己撑起一行。
					<ExtensionSummary ext={ext} standalone />
				) : null}
				{/* 详情页是拓展自己那块面板的唯一去处;叫「管理」—— 进去是要动手改东西的。 */}
				<div className="mt-auto flex justify-end">
					<Link
						to={`/extensions/${ext.id}`}
						className="inline-flex items-center gap-1 text-bn-sm font-bold text-bn-pink transition-opacity hover:opacity-80"
					>
						{t("extensions.manage")}
						<Icon.chevronRight size={13} />
					</Link>
				</div>
			</div>
		</GlassBox>
	);
}

export default function Extensions() {
	const t = useT();
	const labels = useProvidesLabels();
	const listed = useExtensions();
	const [filter, setFilter] = useState<"all" | Provides>("all");
	// 连接表 —— 只为卡片上那句「N 条连接」。**与拓展表分开取**:拓展没跑起来时它照样在,
	// 而「配了但那个拓展没起来」正是最该看见的一种。
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<ConnectionRow[]>("/api/connections"),
	});
	const toggle = useExtensionToggle();
	const [installing, setInstalling] = useState(false);
	// 市场(ADR-0013):已装卡片上的「有新版」从这儿来;装从市场装的那一套与下面那一节共用。
	const market = useMarketplace();
	const installer = useMarketplaceInstall();
	const motion = useCardMotionStore((state) => state.motion);
	const [landingId, setLandingId] = useState<string | null>(null);
	useEffect(() => {
		if (installer.action !== "install" || !installer.done) return;
		setFilter("all");
		setLandingId(installer.done.id);
	}, [installer.action, installer.done]);
	useEffect(() => {
		if (motion?.kind !== "install") return;
		setFilter("all");
		setLandingId(motion.id);
	}, [motion]);
	useEffect(() => {
		if (!landingId || installing || filter !== "all") return;
		if (!listed.data?.extensions.some((ext) => ext.id === landingId)) return;
		const card = document.querySelector<HTMLElement>(cardSelector(landingId));
		if (!card) return;
		// 普通市场传送自己先滚落点;减少动态和上传没有这一步,由页面定位。
		if (motion?.kind !== "install" || reducedMotion()) {
			card.scrollIntoView?.({ block: "nearest", behavior: "instant" });
		}
		setLandingId(null);
	}, [landingId, installing, filter, listed.data, motion]);
	// 别处的「去拓展市场」带着 #marketplace 跳过来:市场那一节在最底下,上面的卡片各自异步撑开,
	// 市场自己的索引也晚到 —— 到齐时再补滚一次。
	// 🔴 「到齐」要连拓展表一起算:拓展表回来之前这一页只画「正在读取」,锚点还没挂上。只看市场
	// 索引的话,索引先到那一刻滚不到东西,锚点挂上时又没人再叫它,一下都不滚。
	const marketAnchor = useRef<HTMLDivElement>(null);
	useScrollToHash(
		MARKETPLACE_SECTION_HASH,
		marketAnchor,
		listed.data !== undefined && market.data !== undefined,
	);
	const updates = new Map(
		(market.data?.extensions ?? [])
			.filter((entry) => entry.state === "updatable")
			.map((entry) => [entry.id, entry] as const),
	);
	// 同一份索引里的另一档:装着的这份来路与市场那条对不上。市场那一节不画已装的了,
	// 这句话的唯一去处就是卡片。
	const sourceNameOf = (id: string) =>
		market.data?.sources.find((source) => source.id === id)?.name ?? id;
	const elsewhere = new Map(
		(market.data?.extensions ?? [])
			.filter((entry) => entry.state === "installed-elsewhere")
			.map((entry) => [entry.id, { entry, sourceName: sourceNameOf(entry.source) }] as const),
	);

	if (listed.isPending) return <LoadingBlock label={t("extensions.loading")} />;
	/*
	 * 🔴 **「读不到」不许画成「没有」**:表读不出来时不能拿空态断言没有安装拓展。
	 */
	if (listed.isError) {
		return (
			<div className="bn-anim-page-in flex flex-col gap-3">
				<ErrorNote>{t("extensions.readFailed", { reason: reasonOf(listed.error) })}</ErrorNote>
			</div>
		);
	}

	const extensions = listed.data?.extensions ?? [];
	const visible = extensions.filter((ext) => filter === "all" || ext.provides?.includes(filter));
	const unknownCount = extensions.filter((ext) => ext.provides === undefined).length;
	const counts = countByExtension(connections.data ?? []);

	const grid = (items: ExtensionEntryView[]) => (
		<div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
			{items.map((ext) => (
				// 传送的落点靠这个属性找(`install-flight.tsx`)。包一层是因为 GlassBox 不透传
				// data-*,而动画要量的正是这张卡在屏幕上的位置。
				<div key={ext.id} className="h-full" {...{ [EXT_CARD_ANCHOR]: ext.id }}>
					<ExtensionCard
						ext={ext}
						count={counts.get(ext.id) ?? 0}
						onToggle={(enabled) => toggle.mutate({ id: ext.id, enabled })}
						update={updates.get(ext.id)}
						installer={installer}
						elsewhere={elsewhere.get(ext.id)}
					/>
				</div>
			))}
		</div>
	);

	return (
		<div className="bn-anim-page-in flex flex-col gap-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<div className="text-bn-xl font-bold tracking-tight text-bn-text-primary">
						{t("extensions.title")}
					</div>
					<div className="mt-[3px] text-bn-xs text-bn-text-secondary">
						{t("extensions.subtitle")}
					</div>
				</div>
				{/* 本体一个拓展都不带,「怎么装」得有个门;它不属于任何一口,所以在页头。 */}
				<div className="flex flex-wrap justify-end gap-2">
					<DevelopmentMountButtonSlot />
					<Btn
						variant="primary"
						size="sm"
						icon={<Icon.plus size={13} />}
						onClick={() => setInstalling(true)}
					>
						{t("extensions.install")}
					</Btn>
				</div>
			</div>

			<ExtensionToggleError toggle={toggle} />
			{/*
			 * 这一发既接已装卡片上的「更新」,也接市场那一节的「装」—— 说哪一句得看**刚才
			 * 那一下是哪一件事**。一律印「更新不了」的话,从市场装一个新的失败了,主人会
			 * 去找一个他根本没装过的旧版本。
			 */}
			{installer.errors.length > 0 ? (
				<ErrorNote size="sm">
					{installer.action === "update"
						? t("extensions.updateFailed")
						: t("extensions.installFailed")}
					{installer.errors.join(";")}
				</ErrorNote>
			) : null}
			<ExtensionInstallOutcome done={installer.done} />

			<Picker
				value={filter}
				onChange={setFilter}
				options={[
					{ value: "all", label: t("extensions.filter.all", { count: extensions.length }) },
					...Object.entries(labels).map(([code, label]) => ({
						value: code as Provides,
						label: t("extensions.filter.count", {
							label,
							count: extensions.filter((ext) => ext.provides?.includes(code as Provides)).length,
						}),
					})),
				]}
			/>
			{visible.length > 0 ? (
				grid(visible)
			) : (
				<EmptyNote>
					{extensions.length === 0 ? t("extensions.empty") : t("extensions.filter.empty")}
				</EmptyNote>
			)}
			{filter !== "all" && unknownCount > 0 ? (
				<p className="text-bn-xs text-bn-text-secondary">
					{t("extensions.filter.unknown", { count: unknownCount })}
				</p>
			) : null}

			<div ref={marketAnchor} style={{ scrollMarginTop: BELOW_HEADER_TOP }}>
				<MarketplaceSection installer={installer} />
			</div>

			{/* 第三方那道确认框:装与更新共用页面这一份 installer,所以由页面来画。 */}
			<MarketplaceInstallConfirm installer={installer} />

			{/* 装成之后的传送、更新成了的换装 —— 演完自己收摊,失败 / 减少动态时当场收摊。 */}
			<CardMotionStage />
			{installing ? (
				<ExtensionInstallDialog
					onClose={() => setInstalling(false)}
					onInstalled={(id) => {
						setFilter("all");
						setLandingId(id);
					}}
				/>
			) : null}
		</div>
	);
}
