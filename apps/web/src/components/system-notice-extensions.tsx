import type { ExtensionDTO, MarketplaceEntryView } from "@bilibili-notify/contract";
import { Btn, HintNote, Icon, IconButton } from "@bilibili-notify/ui";
import { useT } from "../i18n";
import { useMarketplace } from "../pages/extensions/marketplace-section";
import { errorTextOf } from "../services/error-text";

export function NoticeExtensionList({
	extensions,
	disabled,
	onNavigate,
	onUpdate,
}: {
	extensions: ExtensionDTO[];
	disabled: boolean;
	onNavigate: (to: string) => void;
	onUpdate: (entry: MarketplaceEntryView, sourceName: string) => void;
}) {
	const tx = useT();
	const market = useMarketplace();
	return (
		<div className="py-3">
			<h2 className="mb-2 text-bn-sm font-bold text-bn-text-primary">
				{tx("lifecycle.incompatibleCount", { count: extensions.length })}
			</h2>
			{market.isError ? (
				<HintNote className="my-2">
					{tx("lifecycle.updateReadFailed")}
					<p className="my-1 break-all">{errorTextOf(market.error)}</p>
					<Btn size="sm" variant="outline" onClick={() => void market.refetch()}>
						{tx("lifecycle.retry")}
					</Btn>
				</HintNote>
			) : null}
			{extensions.map((ext) => {
				const update = market.isError
					? undefined
					: market.data?.extensions.find(
							(entry) => entry.id === ext.id && entry.state === "updatable",
						);
				return (
					<div key={ext.id} className="flex items-center justify-between gap-3 py-2">
						<div className="min-w-0">
							<div className="break-all text-bn-text-primary">{ext.name}</div>
							{ext.detail ? <div className="break-all text-bn-xs">{ext.detail}</div> : null}
						</div>
						<div className="flex shrink-0 items-center gap-1">
							{update ? (
								<Btn
									size="sm"
									variant="outline"
									disabled={disabled}
									onClick={() =>
										onUpdate(
											update,
											market.data?.sources.find((source) => source.id === update.source)?.name ??
												update.source,
										)
									}
								>
									{tx("lifecycle.updateExtension")}
								</Btn>
							) : null}
							<IconButton
								size="lg"
								className="max-sm:h-11 max-sm:w-11"
								icon={<Icon.chevronRight size={14} />}
								label={tx("lifecycle.manageExtension", { name: ext.name })}
								disabled={disabled}
								onClick={() => onNavigate(`/extensions/${encodeURIComponent(ext.id)}`)}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
