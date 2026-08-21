import { Btn, CheckRow, Input, ModalShell } from "@bilibili-notify/ui";
import { useState } from "react";
import { addGroupName, toggleGroup } from "./group-edit";

export interface GroupEditDialogProps {
	/** 全局已有分组名(供打勾选择)。 */
	allGroups: string[];
	/** 当前订阅所属分组。 */
	current: string[];
	onConfirm: (next: string[]) => void;
	onCancel: () => void;
	saving?: boolean;
}

export function GroupEditDialog({
	allGroups,
	current,
	onConfirm,
	onCancel,
	saving,
}: GroupEditDialogProps) {
	const [draft, setDraft] = useState<string[]>(current);
	const [newName, setNewName] = useState("");
	// 已有分组 ∪ 草稿里新建的,去重保序。
	const options = [...new Set([...allGroups, ...draft])];

	function addNew(): void {
		setDraft((d) => addGroupName(d, newName));
		setNewName("");
	}

	return (
		<ModalShell onCancel={onCancel} width={360} bodyClassName="p-5" title="编辑所属分组">
			<div className="flex max-h-60 flex-col gap-1.5 overflow-y-auto">
				{options.length === 0 ? (
					<div className="text-[12px] text-bn-text-tertiary">还没有任何分组,在下方新建一个吧</div>
				) : (
					options.map((g) => (
						<CheckRow
							key={g}
							checked={draft.includes(g)}
							onChange={() => setDraft((d) => toggleGroup(d, g))}
						>
							{g}
						</CheckRow>
					))
				)}
			</div>
			<div className="mt-3 flex gap-2">
				<Input value={newName} onChange={setNewName} placeholder="新建分组名" full size="sm" />
				<Btn variant="outline" size="sm" onClick={addNew} disabled={!newName.trim()}>
					添加
				</Btn>
			</div>
			<div className="mt-4 flex justify-end gap-2">
				<Btn variant="outline" size="sm" onClick={onCancel} disabled={saving}>
					取消
				</Btn>
				<Btn variant="primary" size="sm" onClick={() => onConfirm(draft)} disabled={saving}>
					{saving ? "保存中…" : "确定"}
				</Btn>
			</div>
		</ModalShell>
	);
}
