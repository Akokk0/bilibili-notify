/**
 * 「源」弹窗:列官方源(内置,不能删)与主人自己加的第三方源,能加能删。
 *
 * 名单整份写回 `globals.marketplace.sources`(补丁对数组是整个换掉的)。第三方源不签名 ——
 * 谁控制了那个地址谁就能换内容,所以**添加那一刻**要把这句话说出来;装每一个第三方条目时
 * 还会再确认一次,那是给手滑的人看的,这里是给不知道自己在干什么的人看的。
 */

import type { MarketplaceSourceDTO } from "@bilibili-notify/contract";
import type { GlobalConfig } from "@bilibili-notify/internal";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../services/api";

interface SourceRow {
	id: string;
	name: string;
	url: string;
}

function sourcesOf(globals: GlobalConfig | undefined): SourceRow[] {
	return globals?.marketplace?.sources ?? [];
}

function newId(): string {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function MarketplaceSourcesDialog({
	status,
	onClose,
}: {
	/** 市场那一口报的各源状态(拿到了没、为什么没)。 */
	status: readonly MarketplaceSourceDTO[];
	onClose: () => void;
}) {
	const qc = useQueryClient();
	const globals = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const sources = sourcesOf(globals.data);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [problem, setProblem] = useState<string | null>(null);

	const save = useMutation({
		mutationFn: (next: SourceRow[]) =>
			api.patch("/api/globals", { marketplace: { sources: next } }),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["globals"] });
			void qc.invalidateQueries({ queryKey: ["marketplace"] });
		},
	});

	const official = status.find((s) => s.official);
	const statusOf = (id: string) => status.find((s) => s.id === id);

	const add = () => {
		const trimmedName = name.trim();
		const trimmedUrl = url.trim();
		if (!trimmedName) return setProblem("给这个源起个名字");
		if (!/^https:\/\/[^\s/]+/.test(trimmedUrl)) return setProblem("索引地址必须是 https:// 开头");
		if (sources.some((s) => s.url === trimmedUrl)) return setProblem("这个地址已经加过了");
		setProblem(null);
		save.mutate([...sources, { id: newId(), name: trimmedName, url: trimmedUrl }]);
		setName("");
		setUrl("");
	};

	return (
		<ModalShell
			width={560}
			onCancel={onClose}
			title="拓展市场的源"
			description="每个源是一份 marketplace.json,列它能装的拓展。官方源是内置的;自己加的源由那个地址的主人说了算。"
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
									{official.ok ? "内置,签名验过" : official.err}
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
										{source.name}
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
										<span className="text-bn-2xs text-bn-danger">{st.err}</span>
									) : null}
								</div>
								<IconButton
									icon={<Icon.trash size={13} />}
									label={`删掉 ${source.name}`}
									size="sm"
									tone="danger"
									onClick={() => save.mutate(sources.filter((s) => s.id !== source.id))}
								/>
							</li>
						);
					})}
				</ul>

				<div className="flex flex-col gap-2 border-t border-bn-border-subtle pt-3">
					<div className="text-bn-xs font-bold text-bn-text-secondary">加一个源</div>
					<WarnNote size="sm">
						BN 不审核第三方源里的东西:装它们等于让那个源的作者在 BN 进程里跑代码。只加信得过的。
					</WarnNote>
					<div className="flex flex-col gap-2 sm:flex-row">
						<TInput
							ariaLabel="源的名字"
							value={name}
							onChange={setName}
							placeholder="名字"
							width={140}
							full={false}
						/>
						<TInput
							ariaLabel="索引地址"
							value={url}
							onChange={setUrl}
							placeholder="https://…/marketplace.json"
							mono
						/>
						<Btn variant="primary" size="sm" disabled={save.isPending} onClick={add}>
							加进来
						</Btn>
					</div>
					{problem ? <ErrorNote size="sm">{problem}</ErrorNote> : null}
					{save.isError ? <ErrorNote size="sm">没存上:{save.error.message}</ErrorNote> : null}
				</div>

				<div className="flex justify-end pt-1">
					<Btn variant="outline" size="md" onClick={onClose}>
						关闭
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}
