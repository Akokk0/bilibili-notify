import type { SubscriptionTag } from "@bilibili-notify/contract";
import { Btn, CheckRow, EmptyNote, ErrorNote, Input, ModalShell } from "@bilibili-notify/ui";
import { useState } from "react";
import { useReplaceSubscriptionTags } from "../../hooks/useSubscriptionTags";
import { useT } from "../../i18n";
import { newId } from "../../types/domain";
import { keepKnownTagIds, planNewTag, toggleTagId } from "./tag-edit";

export interface TagEditDialogProps {
	/**
	 * 标签表(顺序即展示顺序,ADR-0034)。`undefined` = 还没读到:已有的没得勾,也**不许新建** ——
	 * 标签表是 PUT 整张换,没拿到旧表就建,会把表洗成只剩新建的那一个。
	 */
	tags: ReadonlyArray<SubscriptionTag> | undefined;
	/** 当前订阅挂的标签 id。 */
	current: string[];
	onConfirm: (next: string[]) => void;
	onCancel: () => void;
	saving?: boolean;
}

/**
 * 给订阅挑标签的**唯一**弹框(订阅页卡片菜单与订阅详情「标签」一行共用):勾选表里已有的 + 就地新建。
 *
 * 就地新建 = 先把整张新表(旧表末尾追加)PUT 出去,成功了才把新标签勾上;失败(重名 / 空名……)把服务端的原话
 * 摆在弹框里,不吞。新建一落地就进了标签表 —— 之后取消也不会撤回,没人挂的空标签留着是允许的。
 * 「确定」只把最终勾选的 id 交给父层,挂不挂到订阅上由父层落盘。
 */
export function TagEditDialog({ tags, current, onConfirm, onCancel, saving }: TagEditDialogProps) {
	const tx = useT();

	const [draft, setDraft] = useState<string[]>(current);
	const [newName, setNewName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const replace = useReplaceSubscriptionTags();
	const table = tags ?? [];
	const busy = Boolean(saving) || replace.isPending;

	async function addNew(): Promise<void> {
		if (!tags || replace.isPending) return;
		const plan = planNewTag(tags, newName, newId());
		if (plan.kind === "empty") return;
		setError(null);
		if (plan.kind === "existing") {
			// 已经有这个名字:不建,把它勾上就是用户要的。
			setDraft((d) => (d.includes(plan.id) ? d : [...d, plan.id]));
			setNewName("");
			return;
		}
		try {
			await replace.mutateAsync(plan.table);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
		setDraft((d) => [...d, plan.tag.id]);
		setNewName("");
	}

	return (
		<ModalShell
			onCancel={onCancel}
			width={360}
			bodyClassName="p-5"
			title={tx("panelUi.pages.up.TagEditDialog.1")}
		>
			<div className="flex max-h-60 flex-col gap-1.5 overflow-y-auto">
				{tags === undefined ? (
					<EmptyNote size="sm">{tx("panelUi.pages.up.TagEditDialog.2")}</EmptyNote>
				) : table.length === 0 ? (
					<EmptyNote size="sm">{tx("panelUi.pages.up.TagEditDialog.3")}</EmptyNote>
				) : (
					table.map((t) => (
						<CheckRow
							key={t.id}
							checked={draft.includes(t.id)}
							onChange={() => setDraft((d) => toggleTagId(d, t.id))}
						>
							{t.name}
						</CheckRow>
					))
				)}
			</div>
			<div className="mt-3 flex gap-2">
				<Input
					value={newName}
					onChange={setNewName}
					placeholder={tx("panelUi.pages.up.TagEditDialog.4")}
					full
					size="sm"
				/>
				<Btn
					variant="outline"
					size="sm"
					onClick={() => void addNew()}
					disabled={!tags || !newName.trim() || replace.isPending}
				>
					{tx("panelUi.pages.up.TagEditDialog.5")}
				</Btn>
			</div>
			{error ? (
				<ErrorNote size="sm" className="mt-2">
					{error}
				</ErrorNote>
			) : null}
			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={busy}>
					{tx("panelUi.pages.up.TagEditDialog.6")}
				</Btn>
				<Btn
					variant="primary"
					size="sm"
					// 标签表没读到时没得对照,原样交回(此时若按空表过滤,会把订阅原有的标签整个洗掉)。
					onClick={() => onConfirm(tags ? keepKnownTagIds(draft, tags) : draft)}
					disabled={busy}
				>
					{saving ? tx("panelUi.pages.up.TagEditDialog.7") : tx("panelUi.pages.up.TagEditDialog.8")}
				</Btn>
			</div>
		</ModalShell>
	);
}
