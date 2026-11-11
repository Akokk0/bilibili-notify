import type { DevelopmentDirectoriesResponse } from "@bilibili-notify/contract";
import {
	Btn,
	EmptyNote,
	ErrorNote,
	HintNote,
	Icon,
	LoadingBlock,
	MenuItem,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useT } from "../i18n";
import { reasonOf } from "../pages/extensions/shared";
import { api } from "../services/api";

/** 挂载弹窗中的浏览步骤；外层ModalShell由整个流程持续持有。 */
export function DevelopmentDirectoryPicker({
	initialDirectory,
	onSelect,
	onCancel,
}: {
	initialDirectory?: string;
	onSelect: (directory: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [path, setPath] = useState(initialDirectory);
	const listing = useQuery({
		queryKey: ["development-directories", path],
		queryFn: () =>
			api.get<DevelopmentDirectoriesResponse>(
				`/api/dev/directories${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
			),
		retry: false,
	});
	const directory = listing.data;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap gap-2">
				<Btn
					variant="outline"
					size="sm"
					icon={<Icon.arrowUp size={15} />}
					disabled={!directory?.parent || listing.isFetching}
					onClick={() => directory?.parent && setPath(directory.parent)}
				>
					{t("developmentExtensions.up")}
				</Btn>
				<Btn
					variant="outline"
					size="sm"
					icon={<Icon.home size={15} />}
					onClick={() => (path === undefined ? void listing.refetch() : setPath(undefined))}
				>
					{t("developmentExtensions.workspace")}
				</Btn>
			</div>
			{directory || path ? (
				<div className="break-all rounded-md bg-bn-surface-muted p-3 font-mono text-bn-xs text-bn-text-secondary">
					{directory?.directory ?? path}
				</div>
			) : null}
			{listing.isPending ? (
				<LoadingBlock variant="inset" label={t("developmentExtensions.loadingDirectories")} />
			) : listing.isError ? (
				<ErrorNote>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span>{reasonOf(listing.error)}</span>
						<Btn variant="outline" size="sm" onClick={() => void listing.refetch()}>
							{t("developmentExtensions.retry")}
						</Btn>
					</div>
				</ErrorNote>
			) : directory ? (
				<>
					<HintNote>
						{directory.hasManifest
							? t("developmentExtensions.hasManifest")
							: t("developmentExtensions.noManifest")}
					</HintNote>
					<div className="max-h-[min(45vh,360px)] overflow-y-auto">
						{directory.entries.length ? (
							directory.entries.map((entry) => (
								<MenuItem
									key={entry.path}
									icon={<Icon.folder size={16} />}
									onClick={() => setPath(entry.path)}
								>
									<span className="min-w-0 flex-1 break-all text-left">{entry.name}</span>
									<Icon.chevronRight size={14} />
								</MenuItem>
							))
						) : (
							<EmptyNote>{t("developmentExtensions.emptyDirectories")}</EmptyNote>
						)}
					</div>
				</>
			) : null}
			<div className="flex flex-wrap justify-end gap-2">
				<Btn variant="outline" onClick={onCancel}>
					{t("developmentExtensions.cancel")}
				</Btn>
				<Btn
					variant="primary"
					disabled={!directory || listing.isFetching || listing.isError}
					onClick={() => directory && onSelect(directory.directory)}
				>
					{t("developmentExtensions.useDirectory")}
				</Btn>
			</div>
		</div>
	);
}
