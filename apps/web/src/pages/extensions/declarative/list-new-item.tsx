import type { ExtensionListField, ExtensionScalarField } from "@bilibili-notify/contract";
import {
	Btn,
	ErrorNote,
	HintNote,
	Icon,
	IconButton,
	ModalShell,
	TArea,
	TInput,
	Toggle,
} from "@bilibili-notify/ui";
import { type ReactNode, useState } from "react";
import { extensionAddress } from "./address";
import { countWordOf, itemLabelOf, subFieldOf } from "./list-items";
import { CopyControl, MonoChip } from "./parts";
import { newHexSecret } from "./secret";
import { EnumControl } from "./settings-form";

/**
 * 列表的新建弹窗(ADR-0019 决策 21 / 29 / 30)—— 照项里的格一格一个控件,**停用那一格不画**:
 * 新建出来的项一律按清单默认值开关,弹窗里多一个开关只会让人以为这里要做选择。项的 `id`
 * 也不在这儿(BN 生成、藏起来,决策 29)。
 *
 * 版式照今天桥的「新建接入」弹窗:同宽、同样的格标题、同一个「成对复制」的盒子。
 */

/** 一格草稿:字(数字格也存输入框里的字 —— 空着要表达得出来)或开关。 */
type Draft = Record<string, string | boolean>;

/** 表单里一格的标题 —— 设计稿的 `.label`。 */
function FieldLabel({ children }: { children: string }) {
	return (
		<span className="mb-1.5 block text-bn-xs font-bold text-bn-text-secondary">{children}</span>
	);
}

/**
 * 打开时每格的样子:清单的默认值;枚举没有默认值就选第一个(选项卡片总得有一张亮着);
 * **生成的那一格每次打开都现生成一把** —— 屏幕上这一把就是要存下去的那一把。
 */
function initialDraft(fields: readonly ExtensionScalarField[]): Draft {
	const draft: Draft = {};
	for (const sub of fields) {
		switch (sub.type) {
			case "string":
				draft[sub.key] = sub.generate ? newHexSecret() : (sub.default ?? "");
				break;
			case "number":
				draft[sub.key] = sub.default === undefined ? "" : String(sub.default);
				break;
			case "boolean":
				draft[sub.key] = sub.default ?? false;
				break;
			case "enum":
				draft[sub.key] = sub.default ?? sub.options[0]?.value ?? "";
				break;
		}
	}
	return draft;
}

/** 必填却空着(只有空格也算空)的那几格 —— 有一格就不给「创建」。 */
function isMissing(sub: ExtensionScalarField, value: string | boolean | undefined): boolean {
	if (!sub.required || (sub.type !== "string" && sub.type !== "number")) return false;
	return String(value ?? "").trim() === "";
}

/**
 * 草稿 → 存下去的那几格。字去掉首尾空格;**空着的可选格不写** —— 拓展那份 zod 按「没设过」
 * 补默认值,写一个空串进去反倒成了「设过了,是空的」。
 */
function valuesOf(fields: readonly ExtensionScalarField[], draft: Draft): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const sub of fields) {
		const value = draft[sub.key];
		if (typeof value === "boolean") {
			values[sub.key] = value;
			continue;
		}
		const text = (value ?? "").trim();
		if (text === "") continue;
		if (sub.type === "number") {
			const n = Number(text);
			if (Number.isFinite(n)) values[sub.key] = n;
			continue;
		}
		values[sub.key] = text;
	}
	return values;
}

export function NewItemDialog({
	extensionId,
	field,
	error,
	saving,
	onCancel,
	onCreate,
}: {
	extensionId: string;
	field: ExtensionListField;
	/**
	 * 上一次「创建」没成的原因。
	 *
	 * 🔴 存不下去时弹窗**不关**(它只在成功那一路关),于是「创建」按下去毫无反应 —— 与「我是
	 * 不是没点到」一模一样。原因得摆在按得到它的那一屏上,不能摆在弹窗背后。
	 */
	error: string | null;
	saving: boolean;
	onCancel: () => void;
	/** 交出去的就是屏幕上这一份 —— 生成的那一格不许在别处再生成一次。 */
	onCreate: (values: Record<string, unknown>) => void;
}) {
	const fields = field.fields.filter((sub) => sub.key !== field.toggle);
	const [draft, setDraft] = useState(() => initialDraft(fields));
	const change = (key: string, value: string | boolean) =>
		setDraft((prev) => ({ ...prev, [key]: value }));
	const values = valuesOf(fields, draft);
	const blocked = fields.some((sub) => isMissing(sub, draft[sub.key]));
	const copies = copyRowsOf(field, extensionId, values);

	return (
		<ModalShell
			width={540}
			onCancel={onCancel}
			title={`新建${field.label}`}
			description={field.description}
			bodyClassName="px-5 pb-[18px] pt-4"
		>
			<div className="flex flex-col gap-3.5">
				{fields.map((sub) => (
					<div key={sub.key}>
						<FieldLabel>{sub.label}</FieldLabel>
						<DraftControl
							sub={sub}
							value={draft[sub.key]}
							onChange={(value) => change(sub.key, value)}
						/>
						{sub.description ? (
							<div className="mt-[7px] text-bn-2xs text-bn-text-tertiary">{sub.description}</div>
						) : null}
					</div>
				))}

				{/*
				 * 「把这几样填到对面去」。**成对出现**是这块的全部意义(ADR-0009 决策 21)—— 分开摆的
				 * 话,主人填完一样就走了。
				 */}
				{copies.length > 0 ? (
					<div data-new-item-copy>
						<HintNote className="flex flex-col gap-[9px] p-3">
							<span className="text-bn-xs font-bold text-bn-text-secondary">
								把这{countWordOf(copies.length)}样填到对面去
							</span>
							<div className="flex flex-col gap-[7px]">
								{copies.map((row) => (
									<div key={row.key} className="flex items-center gap-2.5">
										<span className="w-14 shrink-0 text-bn-2xs">{row.label}</span>
										<MonoChip className="min-w-0 flex-1 truncate text-bn-text-primary">
											{row.value}
										</MonoChip>
										<CopyControl iconOnly label={`复制 ${row.label}`} text={row.value} />
									</div>
								))}
							</div>
						</HintNote>
					</div>
				) : null}

				{error ? (
					<ErrorNote size="sm">
						建不了这条{itemLabelOf(field)}:{error}
					</ErrorNote>
				) : null}

				<div className="flex justify-end gap-2 pt-1">
					<Btn variant="outline" size="md" onClick={onCancel}>
						取消
					</Btn>
					<Btn
						variant="primary"
						size="md"
						disabled={saving || blocked}
						onClick={() => {
							if (!saving && !blocked) onCreate(values);
						}}
					>
						{saving ? "创建中…" : "创建"}
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}

/**
 * 成对复制的那几行(决策 29 的 `newItemCopy`):BN 现算的地址(在浏览器里算 —— 主人此刻正是经
 * 这个地址看着这一页,决策 28),或者本项的某一格(**草稿里的这一份**,也就是要存下去的那一份)。
 */
function copyRowsOf(
	field: ExtensionListField,
	extensionId: string,
	values: Readonly<Record<string, unknown>>,
): { key: string; label: string; value: string }[] {
	return (field.newItemCopy ?? []).flatMap((entry, i) => {
		if ("host" in entry) {
			return [{ key: `host:${i}`, label: entry.label, value: extensionAddress(extensionId) }];
		}
		const sub = subFieldOf(field, entry.field);
		if (!sub) return [];
		const value = values[sub.key];
		return [{ key: `field:${i}`, label: sub.label, value: typeof value === "string" ? value : "" }];
	});
}

/** 一格的控件。 */
function DraftControl({
	sub,
	value,
	onChange,
}: {
	sub: ExtensionScalarField;
	value: string | boolean | undefined;
	onChange: (value: string | boolean) => void;
}): ReactNode {
	const text = typeof value === "string" ? value : "";
	switch (sub.type) {
		case "string":
			/*
			 * 生成的那一格**明文**摆着(决策 30「新建时明文显示一次」)—— 这是主人唯一一次看得到
			 * 全文的时候,存下之后卡上只露头尾。只读:格式由 BN 定(32 位小写十六进制),要换就
			 * 按旁边那颗。
			 */
			if (sub.generate) {
				return (
					<div className="flex items-center gap-2">
						<span
							data-generated={sub.key}
							className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-bn-border bg-bn-surface-muted px-2.5 font-mono text-bn-xs text-bn-text-secondary"
						>
							{text}
						</span>
						<IconButton
							label={`重新生成 ${sub.label}`}
							icon={<Icon.refresh size={13} />}
							size="sm"
							onClick={() => onChange(newHexSecret())}
						/>
					</div>
				);
			}
			return sub.multiline ? (
				<TArea
					ariaLabel={sub.label}
					value={text}
					onChange={onChange}
					placeholder={sub.placeholder}
					mono={sub.monospace || sub.secret}
				/>
			) : (
				<TInput
					ariaLabel={sub.label}
					value={text}
					onChange={onChange}
					placeholder={sub.placeholder}
					mono={sub.monospace}
					secret={sub.secret}
					full
				/>
			);
		case "number":
			return (
				<div className="flex items-center gap-2">
					<TInput
						type="number"
						width={120}
						ariaLabel={sub.label}
						value={text}
						onChange={onChange}
					/>
					{sub.unit ? <span className="text-bn-xs text-bn-text-tertiary">{sub.unit}</span> : null}
				</div>
			);
		case "boolean":
			return <Toggle ariaLabel={sub.label} value={value === true} onChange={onChange} />;
		case "enum":
			return <EnumControl field={sub} value={text} onChange={onChange} />;
	}
}
