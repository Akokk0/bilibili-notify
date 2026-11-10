import { useT } from "../../i18n";
/**
 * 「源」弹窗:列官方源(内置,不能删)与主人自己加的第三方源,能加能删。
 *
 * 加源**只填地址**:索引自己带 `name`,拿到之后市场那一口报的就是它,拿到之前用域名顶着。
 * 名单整份写回 `globals.marketplace.sources`(补丁对数组是整个换掉的)。第三方源不签名 ——
 * 谁控制了那个地址谁就能换内容,所以**添加那一刻**要把这句话说出来;装每一个第三方条目时
 * 还会再确认一次,那是给手滑的人看的,这里是给不知道自己在干什么的人看的。
 */

import {
	type MarketplaceSourceView,
	normalizeMarketplaceSourceUrl,
} from "@bilibili-notify/contract";
import type { GlobalSettings } from "@bilibili-notify/internal";
import {
	Btn,
	ErrorNote,
	Icon,
	IconButton,
	ModalShell,
	StatusDot,
	TInput,
	WarnNote,
} from "@bilibili-notify/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MARKETPLACE_QUERY_KEY } from "../../hooks/useExtensions";
import { patchCoreSettings, SETTINGS_KEY, useCoreSettings } from "../../hooks/useSettings";
import { newId } from "../../types/domain";

interface SourceRow {
	id: string;
	/** 可选:索引自己带名字,加源时只填地址。 */
	name?: string;
	url: string;
}

function sourcesOf(globals: Pick<GlobalSettings, "marketplace"> | undefined): SourceRow[] {
	return globals?.marketplace?.sources ?? [];
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export function MarketplaceSourcesDialog({
	status,
	onClose,
}: {
	/** 市场那一口报的各源状态(拿到了没、叫什么、为什么没)。 */
	status: readonly MarketplaceSourceView[];
	onClose: () => void;
}) {
	const tx = useT();

	const qc = useQueryClient();
	const globals = useCoreSettings();
	const sources = sourcesOf(globals.data);
	const [url, setUrl] = useState("");
	const [problem, setProblem] = useState<"invalid-url" | "duplicate" | null>(null);

	const save = useMutation({
		mutationFn: (next: SourceRow[]) => patchCoreSettings({ marketplace: { sources: next } }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
			void qc.invalidateQueries({ queryKey: MARKETPLACE_QUERY_KEY });
		},
	});

	const official = status.find((s) => s.official);
	const statusOf = (id: string) => status.find((s) => s.id === id);
	/** 行上印的名字:市场那一口报的(索引里的)优先;还没拿到就用域名顶着。 */
	const nameOf = (source: SourceRow) =>
		statusOf(source.id)?.name ?? source.name ?? hostOf(source.url);

	const add = () => {
		const normalized = normalizeMarketplaceSourceUrl(url);
		if (!normalized.ok) {
			setProblem("invalid-url");
			return;
		}
		if (sources.some((s) => s.url === normalized.url)) {
			setProblem("duplicate");
			return;
		}
		setProblem(null);
		// 名字不用起:索引自己带,拿到之后市场那一口报的就是它。
		save.mutate([...sources, { id: newId(), url: normalized.url }]);
		setUrl("");
	};

	return (
		<ModalShell
			width={560}
			onCancel={onClose}
			title={tx("panelUi.pages.extensions.marketplace-sources-dialog.3")}
			description={tx("panelUi.pages.extensions.marketplace-sources-dialog.4")}
			bodyClassName="px-5 pb-4 pt-4"
		>
			<div className="flex flex-col gap-3.5">
				<ul className="flex flex-col gap-2">
					{official ? (
						<li className="flex items-center gap-2.5 rounded-lg border border-bn-border-subtle px-3 py-2">
							<StatusDot kind={official.ok ? "ok" : "err"} />
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="text-bn-sm font-bold text-bn-text-primary">{official.name}</span>
								<span className="text-bn-2xs text-bn-text-tertiary">
									{official.ok
										? tx("panelUi.pages.extensions.marketplace-sources-dialog.5")
										: official.message}
								</span>
							</div>
						</li>
					) : null}
					{sources.map((source) => {
						const st = statusOf(source.id);
						return (
							<li
								key={source.id}
								className="flex items-center gap-2.5 rounded-lg border border-bn-border-subtle px-3 py-2"
							>
								<StatusDot kind={st ? (st.ok ? "ok" : "err") : "pending"} />
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="text-bn-sm font-bold text-bn-text-primary">
										{nameOf(source)}
										{st?.namespace ? (
											<span className="ml-1.5 font-mono text-bn-2xs font-normal text-bn-text-tertiary">
												{st.namespace}.*
											</span>
										) : null}
									</span>
									<span className="truncate font-mono text-bn-2xs text-bn-text-tertiary">
										{source.url}
									</span>
									{st && !st.ok ? (
										<span className="text-bn-2xs text-bn-danger">{st.message}</span>
									) : null}
								</div>
								<IconButton
									icon={<Icon.trash size={13} />}
									label={tx("panelUi.pages.extensions.marketplace-sources-dialog.6", {
										value0: nameOf(source),
									})}
									size="sm"
									tone="danger"
									onClick={() => save.mutate(sources.filter((s) => s.id !== source.id))}
								/>
							</li>
						);
					})}
				</ul>

				<div className="flex flex-col gap-2 border-t border-bn-border-subtle pt-3">
					<div className="text-bn-xs font-bold text-bn-text-secondary">
						{tx("panelUi.pages.extensions.marketplace-sources-dialog.7")}
					</div>
					<WarnNote size="sm">
						{tx("panelUi.pages.extensions.marketplace-sources-dialog.8")}
					</WarnNote>
					<div className="flex flex-col gap-2 sm:flex-row">
						<TInput
							ariaLabel={tx("panelUi.pages.extensions.marketplace-sources-dialog.9")}
							value={url}
							onChange={setUrl}
							placeholder="owner/repo · https://…/marketplace.json"
							mono
						/>
						<Btn variant="primary" size="sm" disabled={save.isPending} onClick={add}>
							{tx("panelUi.pages.extensions.marketplace-sources-dialog.10")}
						</Btn>
					</div>
					{problem ? (
						<ErrorNote size="sm">
							{problem === "invalid-url"
								? tx("panelUi.pages.extensions.marketplace-sources-dialog.1")
								: tx("panelUi.pages.extensions.marketplace-sources-dialog.2")}
						</ErrorNote>
					) : null}
					{save.isError ? (
						<ErrorNote size="sm">
							{tx("panelUi.pages.extensions.marketplace-sources-dialog.11")}
							{save.error.message}
						</ErrorNote>
					) : null}
				</div>

				<div className="flex justify-end pt-1">
					<Btn variant="outline" size="md" onClick={onClose}>
						{tx("panelUi.pages.extensions.marketplace-sources-dialog.12")}
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}
