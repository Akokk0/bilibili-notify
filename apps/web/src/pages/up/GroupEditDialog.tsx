import { useState } from "react";
import { Btn, Input } from "../../components/atoms";
import { ModalShell } from "../../components/dialog";
import { Icon } from "../../components/icons";
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
		<ModalShell onCancel={onCancel} width={360} bodyClassName="p-5">
			<div className="mb-3 text-base font-bold text-bn-text-primary">编辑所属分组</div>
			<div className="flex max-h-60 flex-col gap-1.5 overflow-y-auto">
				{options.length === 0 ? (
					<div className="text-[12px] text-bn-text-tertiary">还没有任何分组,在下方新建一个吧</div>
				) : (
					options.map((g) => {
						const checked = draft.includes(g);
						return (
							<label
								key={g}
								className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[13px] transition ${
									checked
										? "border-bn-pink/60 bg-bn-pink/10 font-semibold text-bn-text-primary"
										: "border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-pink/40 hover:bg-bn-surface-muted"
								}`}
							>
								<input
									type="checkbox"
									checked={checked}
									onChange={() => setDraft((d) => toggleGroup(d, g))}
									className="sr-only"
								/>
								<span
									className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
										checked
											? "border-bn-pink bg-bn-pink text-white"
											: "border-bn-border bg-bn-surface"
									}`}
								>
									{checked ? <Icon.check size={11} /> : null}
								</span>
								<span className="truncate">{g}</span>
							</label>
						);
					})
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
