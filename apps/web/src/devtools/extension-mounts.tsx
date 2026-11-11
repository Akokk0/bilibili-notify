import type { DevelopmentExtensionsResponse } from "@bilibili-notify/contract";
import { Btn, CheckRow, ErrorNote, HintNote, Icon, ModalShell, TInput } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	extensionBotsKey,
	extensionSettingsKey,
	extensionStatusKey,
	invalidateExtensionTables,
} from "../hooks/useExtensions";
import { useT } from "../i18n";
import { reasonOf } from "../pages/extensions/shared";
import { api } from "../services/api";
import { DevelopmentDirectoryPicker } from "./directory-picker";

const KEY = ["development-extension-mounts"] as const;
const PATH = "/api/dev/extensions";

function useMounts() {
	return useQuery({
		queryKey: KEY,
		queryFn: () => api.get<DevelopmentExtensionsResponse>(PATH),
		retry: false,
		refetchInterval: 2000,
	});
}

/** 随全局开发工具挂载；停在拓展详情等页面时也能重取重载后的数据。 */
export function DevelopmentExtensionSync() {
	const qc = useQueryClient();
	const mounts = useMounts();
	const previous = useRef(new Map<string, number>());
	useEffect(() => {
		if (!Array.isArray(mounts.data?.mounts)) return;
		const next = new Map(mounts.data.mounts.map(({ id, reloads }) => [id, reloads]));
		const changed = [...new Set([...previous.current.keys(), ...next.keys()])].filter(
			(id) => previous.current.get(id) !== next.get(id),
		);
		previous.current = next;
		if (!changed.length) return;
		void invalidateExtensionTables(qc);
		for (const id of changed) {
			void qc.invalidateQueries({ queryKey: extensionStatusKey(id) });
			void qc.invalidateQueries({ queryKey: extensionBotsKey(id) });
			void qc.invalidateQueries({ queryKey: extensionSettingsKey(id) });
		}
	}, [mounts.data, qc]);
	return null;
}

/** 只经App的DEV入口注入，生产端既无按钮也无请求。 */
export function DevelopmentMountButton() {
	const t = useT();
	const mounts = useMounts();
	const [open, setOpen] = useState(false);
	if (!Array.isArray(mounts.data?.mounts)) return null;
	return (
		<>
			<Btn variant="outline" size="sm" icon={<Icon.link size={13} />} onClick={() => setOpen(true)}>
				{t("developmentExtensions.mount")}
			</Btn>
			{open ? <MountDialog onClose={() => setOpen(false)} /> : null}
		</>
	);
}

function MountDialog({ onClose }: { onClose: () => void }) {
	const t = useT();
	const qc = useQueryClient();
	const [directory, setDirectory] = useState("");
	const [watch, setWatch] = useState(true);
	const [browsing, setBrowsing] = useState(false);
	const mount = useMutation({
		mutationFn: () =>
			api.post<DevelopmentExtensionsResponse>(PATH, { directory: directory.trim(), watch }),
		onSuccess: async (response) => {
			qc.setQueryData(KEY, response);
			await invalidateExtensionTables(qc);
			onClose();
		},
	});
	return (
		<ModalShell
			width={browsing ? 640 : 540}
			title={
				browsing ? t("developmentExtensions.chooseDirectory") : t("developmentExtensions.mount")
			}
			description={
				browsing ? t("developmentExtensions.browseHint") : t("developmentExtensions.hint")
			}
			onCancel={browsing ? () => setBrowsing(false) : onClose}
		>
			{browsing ? (
				<DevelopmentDirectoryPicker
					initialDirectory={directory.trim() || undefined}
					onCancel={() => setBrowsing(false)}
					onSelect={(selected) => {
						setDirectory(selected);
						setBrowsing(false);
					}}
				/>
			) : (
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (directory.trim() && !mount.isPending) mount.mutate();
					}}
				>
					<label
						htmlFor="development-extension-directory"
						className="text-bn-base font-semibold text-bn-text-secondary"
					>
						{t("developmentExtensions.directory")}
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<div className="min-w-0 flex-1">
							<TInput
								id="development-extension-directory"
								ariaLabel={t("developmentExtensions.directory")}
								mono
								value={directory}
								onChange={setDirectory}
								disabled={mount.isPending}
							/>
						</div>
						<Btn
							variant="outline"
							icon={<Icon.folder size={15} />}
							disabled={mount.isPending}
							onClick={() => setBrowsing(true)}
						>
							{t("developmentExtensions.browse")}
						</Btn>
					</div>
					<CheckRow checked={watch} onChange={setWatch}>
						{t("developmentExtensions.watch")}
					</CheckRow>
					<HintNote>{t("developmentExtensions.lifecycle")}</HintNote>
					{mount.isError ? <ErrorNote>{reasonOf(mount.error)}</ErrorNote> : null}
					<div className="flex justify-end gap-2">
						<Btn variant="outline" onClick={onClose} disabled={mount.isPending}>
							{t("developmentExtensions.cancel")}
						</Btn>
						<Btn type="submit" variant="primary" disabled={!directory.trim() || mount.isPending}>
							{mount.isPending
								? t("developmentExtensions.mounting")
								: t("developmentExtensions.confirm")}
						</Btn>
					</div>
				</form>
			)}
		</ModalShell>
	);
}

export function DevelopmentMountNote({ id }: { id: string }) {
	const t = useT();
	const qc = useQueryClient();
	const mounts = useMounts();
	const mounted = mounts.data?.mounts?.find((candidate) => candidate.id === id);
	const remove = useMutation({
		mutationFn: () =>
			api.delete<DevelopmentExtensionsResponse>(`${PATH}/${encodeURIComponent(id)}`),
		onSuccess: async (response) => {
			qc.setQueryData(KEY, response);
			await invalidateExtensionTables(qc);
		},
	});
	if (!mounted) return null;
	return (
		<div className="flex flex-col gap-2 border-t border-bn-border-subtle pt-3">
			<div className="text-bn-xs font-semibold text-bn-text-secondary">
				{t("developmentExtensions.label")}
			</div>
			<div className="break-all font-mono text-bn-xs text-bn-text-tertiary">
				{mounted.directory}
			</div>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="text-bn-2xs text-bn-text-tertiary">
					{mounted.watching
						? t("developmentExtensions.watching")
						: t("developmentExtensions.unwatched")}{" "}
					· {t("developmentExtensions.reloads", { count: mounted.reloads })}
				</span>
				<Btn
					variant="outline"
					size="sm"
					disabled={remove.isPending}
					onClick={() => remove.mutate()}
				>
					{t("developmentExtensions.unmount")}
				</Btn>
			</div>
			{mounted.error ? <ErrorNote size="sm">{mounted.error}</ErrorNote> : null}
			{remove.isError ? <ErrorNote size="sm">{reasonOf(remove.error)}</ErrorNote> : null}
		</div>
	);
}
