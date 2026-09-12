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
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../services/api";
import { errorsOf } from "./install-errors";
import { MarketplaceSourcesDialog } from "./marketplace-sources-dialog";

export function useMarketplace() {
	return useQuery({
		queryKey: ["marketplace"],
		queryFn: () => api.get<MarketplaceResponse>("/api/ext/marketplace"),
		retry: false,
	});
}

/**
 * 从市场装一条。装完的回答与传包装**同一个形状**,所以「装完那句话」也共用同一块。
 * 装完拓展表与市场都重取:热装的那份已经在跑,市场那条的状态也该从「装」变成「已装」。
 *
 * 🔴 **「确认第三方」这一道住在这里,不住在某个按钮旁边**:装与更新是两颗不同的钮、
 * 在两块不同的地方(市场那一节 / 已装卡片上),而它们落地的是同一件事 —— 把一份 BN
 * 不担保的代码放进 BN 进程里跑。哪一颗钮自己接 `install.mutate`,哪一颗就绕过了这道门,
 * 而且构建、类型、别的测试全绿:第三方源只要把版本号抬一格就能零确认装进新代码。
 */
export function useMarketplaceInstall() {
	const qc = useQueryClient();
	const [done, setDone] = useState<ExtensionInstallResponse | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [confirming, setConfirming] = useState<MarketplaceEntryDTO | null>(null);
	/*
	 * 刚才那一下是**装**还是**更新**。两者落地的是同一发请求(所以同一个 mutation),
	 * 但失败时要说的话不一样 —— 从市场装一个新的却被告知「更新不了」,主人会去找一个
	 * 他根本没装过的旧版本。这一格只为那句话存在。
	 */
	const [action, setAction] = useState<"install" | "update">("install");
	const install = useMutation({
		mutationFn: (input: { source: string; id: string }) =>
			api.post<ExtensionInstallResponse>("/api/ext/marketplace/install", input),
		onMutate: () => {
			setErrors([]);
			setDone(null);
		},
		onSuccess: (res) => {
			setDone(res);
			void qc.invalidateQueries({ queryKey: ["extensions"] });
			void qc.invalidateQueries({ queryKey: ["marketplace"] });
		},
		onError: (err) => setErrors(errorsOf(err)),
	});
	/** 装 / 更新的唯一入口:官方一键,第三方先过确认框。 */
	const start = (entry: MarketplaceEntryDTO) => {
		setAction(entry.state === "updatable" ? "update" : "install");
		if (entry.official) install.mutate({ source: entry.source, id: entry.id });
		else setConfirming(entry);
	};
	return {
		install,
		done,
		errors,
		action,
		start,
		confirming,
		confirm: () => {
			if (!confirming) return;
			install.mutate({ source: confirming.source, id: confirming.id });
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

function EntryAction({
	entry,
	busy,
	onInstall,
}: {
	entry: MarketplaceEntryDTO;
	busy: boolean;
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
					安装
				</Btn>
			);
		case "updatable":
			return (
				<>
					<span className="text-bn-2xs text-bn-text-tertiary">
						已装 v{entry.installed?.version}
					</span>
					<Btn variant="primary" size="sm" disabled={busy} onClick={onInstall}>
						更新到 v{entry.version}
					</Btn>
				</>
			);
		case "installed":
			return (
				<Pill subtle size="sm" color="var(--color-bn-success)">
					已装
				</Pill>
			);
		case "installed-elsewhere":
			return (
				<span className="text-bn-2xs text-bn-text-tertiary">
					已装 v{entry.installed?.version ?? "?"},不是从这里装的 —— 不提示更新
				</span>
			);
		case "incompatible":
			return (
				<span className="text-bn-2xs text-bn-text-tertiary">
					要宿主契约 v{entry.apiVersion},先升级 BN
				</span>
			);
		case "revoked":
			return <span className="text-bn-2xs font-bold text-bn-danger">这一版已被撤回</span>;
	}
}

function EntryCard({
	entry,
	sourceName,
	busy,
	onInstall,
}: {
	entry: MarketplaceEntryDTO;
	sourceName: string;
	busy: boolean;
	onInstall: () => void;
}) {
	return (
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
					<EntryAction entry={entry} busy={busy} onInstall={onInstall} />
				</div>
			</div>
		</GlassBox>
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
								queryKey: ["marketplace"],
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

			{data && data.extensions.length > 0 ? (
				<div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
					{data.extensions.map((entry) => (
						<EntryCard
							key={`${entry.source}/${entry.id}`}
							entry={entry}
							sourceName={sourceName(entry.source)}
							busy={install.isPending}
							onInstall={() => start(entry)}
						/>
					))}
				</div>
			) : null}
			{data &&
			data.extensions.length === 0 &&
			failed.length === 0 &&
			(data.available || thirdPartyCount > 0) ? (
				<EmptyNote>市场里现在没有能装的拓展</EmptyNote>
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
