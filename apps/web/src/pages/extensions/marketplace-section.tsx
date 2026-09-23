/**
 * 拓展页上的「拓展市场」一节(ADR-0013)。
 *
 * 索引由服务端拉、验、算状态(`/api/ext/marketplace`);这里只**照着 `state` 画**:能装的给
 * 「装」、有新版的给「更新」、装着的标已装、别处装的说清不是从这儿装的、契约不合的说先升级
 * BN、撤回的标红。官方条目一键装;第三方条目**装之前先确认** —— 它会在 BN 进程里跑代码,
 * BN 不担保它,而添加源那一次的提示是给「不知道自己在干什么」的人看的,这一次是给「知道但
 * 手滑」的人看的,两句话不重复。
 */

import type {
	ExtensionInstallResponse,
	MarketplaceEntryDTO,
	MarketplaceResponse,
} from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	IconButton,
	LoadingBlock,
	Pill,
	Spinner,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { EXTENSIONS_QUERY_KEY, MARKETPLACE_QUERY_KEY } from "../../hooks/useExtensions";
import { api } from "../../services/api";
import { EXT_UPDATE_BUTTON, useCardMotionStore } from "./card-motion";
import { errorsOf } from "./install-errors";
import { MarketplaceSourcesDialog } from "./marketplace-sources-dialog";

export function useMarketplace() {
	return useQuery({
		queryKey: MARKETPLACE_QUERY_KEY,
		queryFn: () => api.get<MarketplaceResponse>("/api/ext/marketplace"),
		retry: false,
	});
}

/** 装 / 更新的这一发。请求本身只要 `source` + `id`;`kind` / `from` 是演动画与说失败那句话要的。 */
interface InstallRequest {
	source: string;
	id: string;
	kind: "install" | "update";
	/** 起飞位置 —— 在**点下去那一刻**量:装成之后市场那张卡当场消失,那时再量就没得量了。 */
	from?: DOMRect;
}

/**
 * 从市场装一条。装完的回答与传包装**同一个形状**,所以「装完那句话」也共用同一块。
 * 装完拓展表与市场都重取:热装的那份已经在跑,市场那条的状态也该从「装」变成「已装」。
 *
 * 🔴 **「确认第三方」这一道住在这里,不住在某个按钮旁边**:装与更新是两颗不同的钮、
 * 在几块不同的地方(市场那一节 / 已装卡片上 / 老格式拓展的详情页),而它们落地的是同一件事
 * —— 把一份 BN 不担保的代码放进 BN 进程里跑。哪一颗钮自己接 `install.mutate`,哪一颗就绕过
 * 了这道门,而且构建、类型、别的测试全绿:第三方源只要把版本号抬一格就能零确认装进新代码。
 */
export function useMarketplaceInstall() {
	const qc = useQueryClient();
	const [done, setDone] = useState<ExtensionInstallResponse | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	/** 等着确认的那条第三方,连同点下去那一刻量的起飞位置 —— 确认时带着它们发。 */
	const [confirming, setConfirming] = useState<{
		entry: MarketplaceEntryDTO;
		from?: DOMRect;
	} | null>(null);
	const play = useCardMotionStore((state) => state.play);
	/*
	 * 页面还在不在。请求的回调挂在 mutation 上,页面拆了照样会跑:装成那一刻页面已经切走的话,
	 * 放进那一格的传送没人演、也没人收,回到拓展页就从一个早就不在的起点再飞一遍。所以拆了就不往
	 * 那一格里放东西。(在 effect 里置真而不是初值给真:StrictMode 会先拆一次再装回来。)
	 */
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	/*
	 * 演哪一段、从哪儿起飞,都跟着**这一发**走(`InstallRequest` 的 `kind` / `from`),不放在跨次
	 * 共享的格子里 —— 第三方那条隔着一道确认框,共享的格子会被中间别的一下改掉或留下残渣。
	 *
	 * 两段动画开演的时机不一样:
	 * - **传送(装)装成才演**:落点是装成之后才出现的那张卡,之前无处可落;失败不演。
	 * - **换装(更新)请求一出门就演**:卡本来就在,下载那几秒正是「蓄」—— 等装完才开演的话,
	 *   那几秒页面上只有一颗灰掉的钮。落定用的 `settle` 由 `onMutate` 交出来,装成 / 没装成时从
	 *   那儿取,演的那头据此画勾或淡出。页面拆了再落定也无妨:那一段已随页面一起收掉,没人在等。
	 */
	const install = useMutation({
		mutationFn: ({ source, id }: InstallRequest) =>
			api.post<ExtensionInstallResponse>("/api/ext/marketplace/install", { source, id }),
		onMutate: ({ id, kind, from }) => {
			setErrors([]);
			setDone(null);
			if (kind !== "update" || !mounted.current) return undefined;
			let settle: (landed: boolean) => void = () => {};
			// 换装没有起点也演 —— 球从卡片上方落下。
			const outcome = new Promise<boolean>((resolve) => {
				settle = resolve;
			});
			play({ kind: "update", id, from, outcome });
			return { settle };
		},
		onSuccess: (res, { kind, from }, started) => {
			setDone(res);
			started?.settle(true);
			// 装的传送非得有起点(从市场那张卡飞过来)。
			if (kind === "install" && from && mounted.current) {
				play({ kind: "install", id: res.id, from });
			}
			void qc.invalidateQueries({ queryKey: EXTENSIONS_QUERY_KEY });
			void qc.invalidateQueries({ queryKey: MARKETPLACE_QUERY_KEY });
		},
		onError: (err, _request, started) => {
			setErrors(errorsOf(err));
			started?.settle(false);
		},
	});
	const send = (entry: MarketplaceEntryDTO, from?: DOMRect) =>
		install.mutate({
			source: entry.source,
			id: entry.id,
			kind: entry.state === "updatable" ? "update" : "install",
			from,
		});
	/** 装 / 更新的唯一入口:官方一键,第三方先过确认框。 */
	const start = (entry: MarketplaceEntryDTO, from?: DOMRect) => {
		if (entry.official) send(entry, from);
		else setConfirming({ entry, from });
	};
	return {
		install,
		done,
		errors,
		/*
		 * 刚才那一发是**装**还是**更新**。两者落地的是同一发请求(所以同一个 mutation),但失败时
		 * 要说的话不一样 —— 从市场装一个新的却被告知「更新不了」,主人会去找一个他根本没装过的
		 * 旧版本。取的是**发出去的那一发**:第三方那条点下去只是弹确认框,取消了也不该把上一发
		 * 失败的那句话改口。
		 */
		action: install.variables?.kind ?? "install",
		start,
		confirming: confirming?.entry ?? null,
		confirm: () => {
			if (!confirming) return;
			send(confirming.entry, confirming.from);
			setConfirming(null);
		},
		cancel: () => setConfirming(null),
	};
}

export type MarketplaceInstaller = ReturnType<typeof useMarketplaceInstall>;

/**
 * 第三方那道确认框。由**持有那份 installer 的页面**画,画一次 —— 两处都画会弹两个
 * 一模一样的弹窗。
 *
 * 两句话不重复:添加源那一次是给「不知道自己在干什么」的人看的,这一次是给「知道但
 * 手滑」的人看的。
 */
export function MarketplaceInstallConfirm({ installer }: { installer: MarketplaceInstaller }) {
	const market = useMarketplace();
	const entry = installer.confirming;
	if (!entry) return null;
	const sourceName = market.data?.sources.find((s) => s.id === entry.source)?.name ?? entry.source;
	const updating = entry.state === "updatable";
	return (
		<ConfirmDialog
			danger
			title={
				updating
					? `更新第三方拓展「${entry.name}」到 v${entry.version}?`
					: `装第三方拓展「${entry.name}」?`
			}
			message={`它来自「${sourceName}」,不是 BN 发的:BN 只保证装到盘上的是那个源写的那个包,不审核它做什么 —— 装了它就在 BN 进程里跑代码。`}
			confirmLabel={updating ? "照样更新" : "照样装"}
			onCancel={installer.cancel}
			onConfirm={installer.confirm}
		/>
	);
}

/** 「撤回了」那句红字 —— 市场那一节的卡与更新入口说的是同一种警告,长一个样。 */
const REVOKED_TEXT_CLS = "text-bn-2xs font-bold text-bn-danger";

/**
 * 「有新版 vX」+「更新」—— 已装卡片(列表页)与老格式拓展的头卡(详情页,ADR-0019 决策 44)
 * **共用这一块**。按下去在那一刻量这颗钮的位置交出去:更新的换装,球从这儿起飞。
 *
 * 🔴 **走 `start` 而不是直接 `install.mutate`**:第三方那道确认框住在它里面。更新与装落地的是
 * 同一件事(把一份 BN 不担保的代码放进 BN 进程里跑),哪一处自己接 mutate,就给第三方源开了
 * 一条「抬个版本号即可零确认装新代码」的路 —— 所以两处用的是同一颗钮,不各接各的。
 *
 * 装着那版被撤回、而市场里有能换过去的新版时(`installed.revoked`),红字也长在**这一块**里:
 * 两处入口都得既标红、又给钮 —— 那正是最该更新的时候。老服务端没有这一格,缺了就当没撤回。
 */
export function MarketplaceUpdateOffer({
	entry,
	installer,
}: {
	/** 市场里这条 `updatable` 的那一版。 */
	entry: MarketplaceEntryDTO;
	installer: MarketplaceInstaller;
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
			{entry.installed?.revoked === true ? (
				<span className={REVOKED_TEXT_CLS}>装着的这一版被撤回了</span>
			) : null}
			<Pill subtle size="sm">
				有新版 v{entry.version}
			</Pill>
			<Btn
				variant="outline"
				size="sm"
				disabled={installer.install.isPending}
				onClick={(event) => installer.start(entry, event.currentTarget.getBoundingClientRect())}
				{...{ [EXT_UPDATE_BUTTON]: "" }}
			>
				更新
			</Btn>
		</div>
	);
}

/**
 * 拓展页上市场那一节的锚点。别处的「去拓展市场」带着它跳过来:这一节在拓展页最底下,只到页顶
 * 的话主人还得自己往下翻一屏。锚点由拓展页挂(这一节不管路由),滚动见 `useScrollToHash`。
 */
export const MARKETPLACE_SECTION_HASH = "#marketplace";

/**
 * 装了的不在市场里露面 —— 它已经在上面那一排卡里了,同一件东西同时摆在两处,看起来像装了两份
 * (主人 2026-09-12 指出)。
 *
 * 🔴 **更新入口不在这儿丢**:「有新版 vX」+「更新」钮长在**已装那张卡**上(`Extensions.tsx`,
 * 老格式的拓展在详情页头卡里还有一颗),吃的同样是这份索引里 `updatable` 那一档。所以把可更新的
 * 也滤掉,并不会让人更新不了。装着那版被撤回、又有新版可换的(`updatable` + `installed.revoked`)
 * 同理:那句红字跟着更新钮长在已装卡上({@link MarketplaceUpdateOffer}),不在这儿再画一张。
 */
const INSTALLED_STATES: ReadonlySet<MarketplaceEntryDTO["state"]> = new Set([
	"installed",
	"updatable",
	"installed-elsewhere",
]);

function EntryAction({
	entry,
	busy,
	installing,
	onInstall,
}: {
	entry: MarketplaceEntryDTO;
	busy: boolean;
	/** 正在装的是**这一条**。`busy` 是「有别的在装、先别点」,两件事。 */
	installing: boolean;
	onInstall: () => void;
}) {
	switch (entry.state) {
		case "installable":
			return (
				<Btn
					variant="primary"
					size="sm"
					disabled={busy}
					icon={<Icon.download size={13} />}
					onClick={onInstall}
				>
					{installing ? "装着…" : "安装"}
				</Btn>
			);
		// 这三档走不到这里 —— 已装的在上面被滤掉了(见 INSTALLED_STATES)。留着空分支是为了
		// 让这个 switch 仍然穷尽:以后加新 state 时 TS 才拦得住漏画。
		case "installed":
		case "updatable":
		case "installed-elsewhere":
			return null;
		case "incompatible":
			// 档位对、小号高的(ADR-0019 决策 59)只说「v2」的话,主人会以为这台 BN 明明认 v2。
			return (
				<span className="text-bn-2xs text-bn-text-tertiary">
					要宿主契约 v{entry.apiVersion}
					{entry.apiRevision ? ` 小号 ${entry.apiRevision}` : ""},先升级 BN
				</span>
			);
		case "revoked":
			return <span className={REVOKED_TEXT_CLS}>这一版已被撤回</span>;
	}
}

function EntryCard({
	entry,
	sourceName,
	busy,
	installing,
	onInstall,
}: {
	entry: MarketplaceEntryDTO;
	sourceName: string;
	busy: boolean;
	installing: boolean;
	/** 收的是**这张卡当时在屏幕上的位置** —— 装成之后它就没了,那时再量来不及。 */
	onInstall: (from: DOMRect) => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	return (
		<div ref={box} className="relative h-full">
			{/*
			 * 「正在装」那一圈 —— 转圈只用库里那件(`Spinner`),页面不许自己写 animate-spin
			 * (`library-reuse-conformance` 拦着)。画在**卡上**而不是按钮里:那颗钮是粉实心的,
			 * 粉环摆上去糊成一片;而且按传送的比喻,该转的本来就是卡自己。
			 */}
			{installing ? (
				<div className="pointer-events-none absolute inset-0 z-bn-raised grid place-items-center rounded-bn-card bg-bn-surface/55">
					<Spinner size={44} thickness={3} />
				</div>
			) : null}
			<GlassBox
				className="h-full"
				title={entry.name}
				subtitle={`v${entry.version}${entry.prerelease ? " · 预发布" : ""}`}
				badge={entry.official ? "官方" : `来自 ${sourceName}`}
				accent={entry.official ? "var(--color-bn-pink)" : "var(--color-bn-text-tertiary)"}
				icon={<Icon.extension size={18} />}
			>
				<div className="flex h-full flex-col gap-2.5">
					{entry.description ? (
						<p className="text-bn-sm leading-[1.6] text-bn-text-secondary">{entry.description}</p>
					) : null}
					{entry.notes ? <p className="text-bn-2xs text-bn-text-tertiary">{entry.notes}</p> : null}
					<div className="mt-auto flex items-center justify-end gap-2.5 pt-0.5">
						<EntryAction
							entry={entry}
							busy={busy}
							installing={installing}
							onInstall={() => {
								const rect = box.current?.getBoundingClientRect();
								if (rect) onInstall(rect);
							}}
						/>
					</div>
				</div>
			</GlassBox>
		</div>
	);
}

export function MarketplaceSection({
	installer,
}: {
	/**
	 * 页面级那一份「从市场装」——「装完那句话」、错误与那道确认框全由**页面**画(已装卡片
	 * 上的更新钮走的是同一份 state),这一节只出那一排卡与那两颗钮。
	 *
	 * 🔴 **必填**:自己起一份的话,这一节点「装」与卡片上点「更新」就落在两份互不相干的
	 * state 上 —— 弹两个一模一样的确认框、装完那句话出两遍,而且两边都不报错。
	 */
	installer: MarketplaceInstaller;
}) {
	const qc = useQueryClient();
	const market = useMarketplace();
	const { install, start } = installer;
	const [managingSources, setManagingSources] = useState(false);

	const data = market.data;
	const sourceName = (id: string) => data?.sources.find((s) => s.id === id)?.name ?? id;
	const failed = data?.sources.filter((s) => !s.ok) ?? [];
	const thirdPartyCount = data?.sources.filter((s) => !s.official).length ?? 0;
	const shown = (data?.extensions ?? []).filter((entry) => !INSTALLED_STATES.has(entry.state));

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center justify-between gap-3">
				<div className="text-bn-xs font-bold uppercase tracking-[0.08em] text-bn-text-tertiary">
					拓展市场
				</div>
				<div className="flex items-center gap-1.5">
					<IconButton
						icon={<Icon.refresh size={13} />}
						label="重新拉索引"
						size="sm"
						onClick={() => {
							void qc.fetchQuery({
								queryKey: MARKETPLACE_QUERY_KEY,
								queryFn: () => api.get<MarketplaceResponse>("/api/ext/marketplace?refresh=1"),
							});
						}}
					/>
					<Btn
						variant="outline"
						size="sm"
						icon={<Icon.globe size={13} />}
						onClick={() => setManagingSources(true)}
					>
						市场源{thirdPartyCount > 0 ? ` · ${thirdPartyCount}` : ""}
					</Btn>
				</div>
			</div>

			{market.isPending ? <LoadingBlock variant="inset" label="正在拉市场索引" /> : null}
			{market.isError ? <ErrorNote size="sm">市场问不到:{market.error.message}</ErrorNote> : null}

			{data && !data.available && thirdPartyCount === 0 ? (
				<HintNote>
					这个构建没有官方源(没有内置信任公钥,fork
					出去自己构建的就是这样)。可以在「源」里加一个第三方源。
				</HintNote>
			) : null}

			{failed.map((source) => (
				<ErrorNote key={source.id} size="sm">
					源「{source.name}」:{source.err}
				</ErrorNote>
			))}

			{shown.length > 0 ? (
				<div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
					{shown.map((entry) => (
						<EntryCard
							key={`${entry.source}/${entry.id}`}
							entry={entry}
							sourceName={sourceName(entry.source)}
							busy={install.isPending}
							installing={install.isPending && install.variables?.id === entry.id}
							onInstall={(from) => start(entry, from)}
						/>
					))}
				</div>
			) : null}
			{data &&
			shown.length === 0 &&
			failed.length === 0 &&
			(data.available || thirdPartyCount > 0) ? (
				// 「都装上了」与「源里本来就是空的」是两件事,别合成一句 —— 前者是好消息。
				<EmptyNote>
					{data.extensions.length > 0 ? "市场里的拓展都装上了" : "市场里现在没有能装的拓展"}
				</EmptyNote>
			) : null}

			{managingSources ? (
				<MarketplaceSourcesDialog
					status={data?.sources ?? []}
					onClose={() => setManagingSources(false)}
				/>
			) : null}
		</div>
	);
}
