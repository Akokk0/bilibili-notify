import type {
	ExtensionDTO,
	ExtensionsResponse,
	MarketplaceEntryDTO,
} from "@bilibili-notify/contract";
import {
	Btn,
	EmptyNote,
	ErrorNote,
	GlassBox,
	Icon,
	LoadingBlock,
	Pill,
	StatusDot,
	Toggle,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../services/api";
import { onlineBotCount, useBridgeStatus } from "./extensions/bridge-status";
import { ExtensionInstallDialog } from "./extensions/install-dialog";
import { ExtensionInstallOutcome } from "./extensions/install-outcome";
import {
	MarketplaceInstallConfirm,
	MarketplaceSection,
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
 * 版式照设计稿 V1 的「Main」那块画板:页头一行 + 按口子分两节,每节一排卡;卡 = 头
 * (图标 / 名字 / 状态徽章 / 开关)+ 一段描述 + 「N 条连接 · N 个 bot 在线」+ 右下「管理 ›」。
 *
 * 这一页**不认得任何具体拓展**(ADR-0012),唯一的例外是那句「N 个 bot 在线」——
 * 它读的是桥交上来的活口状态,形状只有桥有(见 `bridge-status.ts` 顶上那段)。
 */

/**
 * 连接表里这一页要看的那几格。整张 `Connection` 是业务域的,这里只数「谁名下有几条」,
 * 不需要认得别的字段。
 */
interface ConnectionRow {
	kind?: string;
	extensionId?: string;
}

type Provides = NonNullable<ExtensionDTO["provides"]>[number];

/** 拓展只开两口(ADR-0012):推送源接进「推送目标」,订阅源接进「订阅 UP 主」。 */
const SECTIONS: ReadonlyArray<{ code: Provides; label: string; empty: string }> = [
	{
		code: "push",
		label: "推送源",
		empty: "还没有推送源拓展。现在能推的只有直连的那些目标。",
	},
	{
		code: "subscription",
		label: "订阅源",
		empty: "还没有订阅源拓展。BN 现在只看 B 站。",
	},
];

/** 一节的标题行:小标题 + 一条发丝线。 */
function SectionHead({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-bn-xs font-bold tracking-[0.04em] text-bn-text-tertiary">{label}</span>
			<span className="h-px flex-1 bg-bn-border-subtle" />
		</div>
	);
}

/**
 * 「从它借来的 bot 建了几条连接」(一条连接就是一个 bot,ADR-0012 决策 45)。任何开推送源
 * 那一口的拓展都有连接,按 `provides` 判就够,不必认得是谁;别的连接(直连的 OneBot)不算数。
 * 0 也要报 —— 那正是「装好了但还没接上」。桥的接入(token 那条)不在这儿数,它在详情页。
 */
function ConnectionCount({ ext, rows }: { ext: ExtensionDTO; rows: ConnectionRow[] }) {
	const mine = rows.filter((row) => row.kind === "extension" && row.extensionId === ext.id);
	return (
		<div className="flex items-baseline gap-[5px]">
			<span className="text-bn-xl font-bold leading-none text-bn-text-primary">{mine.length}</span>
			<span className="text-bn-xs text-bn-text-tertiary">条连接</span>
		</div>
	);
}

/**
 * 「N 个 bot 在线」—— 桥现在真的驮着几个。**只有桥有这句**:bot 是桥那份状态里的东西,
 * 别的推送源拓展没有这个概念。拓展关着 / 没跑起来时不说 —— 数不出来的数字不该假装是 0。
 */
function BridgeLiveCount({ ext }: { ext: ExtensionDTO }) {
	const status = useBridgeStatus(ext.id, ext.enabled);
	if (!ext.enabled || !status.data) return null;
	return (
		<>
			<span className="h-4 w-px bg-bn-border-subtle" />
			<div className="flex items-center gap-1.5">
				<StatusDot kind="ok" />
				<span className="text-bn-xs text-bn-text-secondary">
					<strong className="font-bold">{onlineBotCount(status.data)}</strong> 个 bot 在线
				</span>
			</div>
		</>
	);
}

function ExtensionCard({
	ext,
	rows,
	onToggle,
	update,
	onUpdate,
	updating,
}: {
	ext: ExtensionDTO;
	rows: ConnectionRow[];
	onToggle: (enabled: boolean) => void;
	/** 市场里这条有更新的那一版(ADR-0013)。没有就不画。 */
	update?: MarketplaceEntryDTO;
	onUpdate?: () => void;
	updating?: boolean;
}) {
	const meta = EXTENSION_STATE_META[ext.state];
	const pushes = (ext.provides ?? []).includes("push");
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
				<ExtensionStateDetail ext={ext} />
				{update ? (
					<div className="flex items-center gap-2">
						<Pill subtle size="sm">
							有新版 v{update.version}
						</Pill>
						<Btn variant="outline" size="sm" disabled={updating} onClick={onUpdate}>
							更新
						</Btn>
					</div>
				) : null}
				{pushes ? (
					<div className="flex items-center gap-3.5 pt-0.5">
						<ConnectionCount ext={ext} rows={rows} />
						{ext.id === "bridge" ? <BridgeLiveCount ext={ext} /> : null}
					</div>
				) : null}
				{/* 详情页是拓展自己那块面板的唯一去处;叫「管理」—— 进去是要动手改东西的。 */}
				<div className="mt-auto flex justify-end">
					<Link
						to={`/extensions/${ext.id}`}
						className="inline-flex items-center gap-1 text-bn-sm font-bold text-bn-pink transition-opacity hover:opacity-80"
					>
						管理
						<Icon.chevronRight size={13} />
					</Link>
				</div>
			</div>
		</GlassBox>
	);
}

export default function Extensions() {
	const listed = useQuery({
		queryKey: ["extensions"],
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
	});
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
	const updates = new Map(
		(market.data?.extensions ?? [])
			.filter((entry) => entry.state === "updatable")
			.map((entry) => [entry.id, entry] as const),
	);

	if (listed.isPending) return <LoadingBlock label="正在读取拓展" />;
	/*
	 * 🔴 **「读不到」不许画成「没有」**:表读不出来时下面两节会说「还没有推送源拓展 /
	 * 还没有订阅源拓展」并顺带断言「现在能推的只有直连的那些目标」—— 两句都是假话,而且
	 * 请主人去装一个他其实已经装了的东西。
	 */
	if (listed.isError) {
		return (
			<div className="bn-anim-page-in flex flex-col gap-3">
				<ErrorNote>读不到装了哪些拓展:{reasonOf(listed.error)}</ErrorNote>
			</div>
		);
	}

	const extensions = listed.data?.extensions ?? [];
	// 归不了口的那些(清单读不出来 / 版本不合 → 没有 provides)。它们**不许消失**:
	// 消失的东西没法排查,而这一页正是主人来看「它怎么了」的地方。
	const homeless = extensions.filter((ext) => (ext.provides ?? []).length === 0);
	const rows = connections.data ?? [];

	const grid = (items: ExtensionDTO[]) => (
		<div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
			{items.map((ext) => (
				<ExtensionCard
					key={ext.id}
					ext={ext}
					rows={rows}
					onToggle={(enabled) => toggle.mutate({ id: ext.id, enabled })}
					update={updates.get(ext.id)}
					updating={installer.install.isPending}
					// 🔴 走 `start` 而不是直接 `install.mutate`:第三方那道确认框住在它里面。更新
					// 与装落地的是同一件事(把一份 BN 不担保的代码放进 BN 进程里跑),自己接
					// mutate 等于给第三方源开一条「抬个版本号即可零确认装新代码」的路。
					onUpdate={() => {
						const entry = updates.get(ext.id);
						if (entry) installer.start(entry);
					}}
				/>
			))}
		</div>
	);

	return (
		<div className="bn-anim-page-in flex flex-col gap-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<div className="text-bn-xl font-bold tracking-tight text-bn-text-primary">拓展</div>
					<div className="mt-[3px] text-bn-xs text-bn-text-secondary">
						给 BN 接上外面的东西。装进来才有,本体一个都不带 —— 开了才生效。
					</div>
				</div>
				{/* 本体一个拓展都不带,「怎么装」得有个门;它不属于任何一口,所以在页头。 */}
				<Btn
					variant="primary"
					size="sm"
					icon={<Icon.plus size={13} />}
					onClick={() => setInstalling(true)}
				>
					装拓展
				</Btn>
			</div>

			<ExtensionToggleError toggle={toggle} />
			{installer.errors.length > 0 ? (
				<ErrorNote size="sm">更新不了:{installer.errors.join(";")}</ErrorNote>
			) : null}
			<ExtensionInstallOutcome done={installer.done} />

			{SECTIONS.map((section) => {
				const mine = extensions.filter((ext) => (ext.provides ?? []).includes(section.code));
				return (
					<div key={section.code} className="flex flex-col gap-2.5">
						<SectionHead label={section.label} />
						{mine.length === 0 ? <EmptyNote>{section.empty}</EmptyNote> : grid(mine)}
					</div>
				);
			})}

			{homeless.length > 0 ? (
				<div className="flex flex-col gap-2.5">
					<SectionHead label="没归到口上的" />
					{grid(homeless)}
				</div>
			) : null}

			<MarketplaceSection installer={installer} />

			{/* 第三方那道确认框:装与更新共用页面这一份 installer,所以由页面来画。 */}
			<MarketplaceInstallConfirm installer={installer} />
			{installing ? <ExtensionInstallDialog onClose={() => setInstalling(false)} /> : null}
		</div>
	);
}
