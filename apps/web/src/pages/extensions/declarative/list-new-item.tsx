import type { ExtensionListField, ExtensionScalarField } from "@bilibili-notify/contract";
import {
	Btn,
	ErrorNote,
	HintNote,
	Icon,
	IconButton,
	ModalShell,
	MonoChip,
} from "@bilibili-notify/ui";
import { type ReactNode, useState } from "react";
import { extensionAddress } from "./address";
import {
	countWordOf,
	dialogFieldsOf,
	itemLabelOf,
	type ListItem,
	subFieldOf,
	titleOf,
} from "./list-items";
import { CopyControl } from "./parts";
import { newHexSecret } from "./secret";
import { clientErrorOf, decimalOf, FieldShell, ScalarControl } from "./settings-form";

/**
 * 列表的新建 / 编辑弹窗(ADR-0019 决策 21 / 29 / 30 / 37)—— 照项里的格一格一个控件,**停用那一格
 * 不画**:新建出来的项一律按清单默认值开关,那颗钮在卡上。项的 `id` 也不在这儿(BN 生成、藏起来,
 * 决策 29)。
 *
 * 编辑(决策 37)复用同一个弹窗、预填这一项现在的值,**密钥 / 生成的那几格不在这里**:存下之后
 * 浏览器只有头尾(决策 38),要换走卡上的「重新生成」。发出去的只有改了的那几格。
 *
 * 版式照今天桥的「新建接入」弹窗:同宽、同样的格标题、同一个「成对复制」的盒子(只新建时有)。
 */

/** 一格草稿:字(数字格也存输入框里的字 —— 空着要表达得出来)或开关。 */
type Draft = Record<string, string | boolean>;

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

/**
 * 编辑时每格的样子:这一项存着的值;没存的按新建时的样子(清单默认值 / 第一个选项)—— 那正是拓展
 * 那份 zod 读到的值。存着的值与这一格的种类对不上的(手改过的文件)当它没存。
 */
function itemDraft(fields: readonly ExtensionScalarField[], item: ListItem): Draft {
	const draft = initialDraft(fields);
	for (const sub of fields) {
		const raw = item[sub.key];
		switch (sub.type) {
			case "string":
			case "enum":
				if (typeof raw === "string") draft[sub.key] = raw;
				break;
			case "number":
				if (typeof raw === "number") draft[sub.key] = String(raw);
				break;
			case "boolean":
				if (typeof raw === "boolean") draft[sub.key] = raw;
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
 * 填了字的那一格当场说得出的毛病(不是数、超出 min / max)—— 与设置表单同一把尺子
 * (`clientErrorOf`),有一格就不给「创建」。
 *
 * 🔴 不拦的话,那一格在 `valuesOf` 里被悄悄丢掉:建出来的项里根本没有它,弹窗上看着却是填了的。
 * 空着的格不说:必填的空着由「创建」按不动来说,一打开就满屏「这一格必填」只是吓人。
 */
function draftErrorOf(
	sub: ExtensionScalarField,
	value: string | boolean | undefined,
): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	return clientErrorOf(sub, value);
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
			// 认不出的数走不到「创建」(`draftErrorOf` 拦着)。
			const n = decimalOf(text);
			if (n !== undefined) values[sub.key] = n;
			continue;
		}
		values[sub.key] = text;
	}
	return values;
}

/**
 * 编辑时发出去的那几格:与打开时比,**变了的**才发(`update` 是部分合并,没发的原样留着)。清空的
 * 可选格发 `null` —— 线上「删掉这一格」只有它说得出来;没填的格不写反倒是「不改」。
 */
function changedValuesOf(
	fields: readonly ExtensionScalarField[],
	initial: Draft,
	draft: Draft,
): Record<string, unknown> {
	const before = valuesOf(fields, initial);
	const after = valuesOf(fields, draft);
	const changed: Record<string, unknown> = {};
	for (const sub of fields) {
		const had = Object.hasOwn(before, sub.key);
		const has = Object.hasOwn(after, sub.key);
		if (has && (!had || after[sub.key] !== before[sub.key])) changed[sub.key] = after[sub.key];
		else if (had && !has) changed[sub.key] = null;
	}
	return changed;
}

export function ItemDialog({
	extensionId,
	field,
	item,
	error,
	fieldErrors,
	saving,
	onCancel,
	onEdit,
	onSubmit,
}: {
	extensionId: string;
	field: ExtensionListField;
	/** 给了就是编辑这一项(决策 37);不给是新建。 */
	item?: ListItem;
	/**
	 * 上一次提交没成、又落不到某一格的原因。
	 *
	 * 🔴 存不下去时弹窗**不关**(它只在成功那一路关),于是按钮按下去毫无反应 —— 与「我是不是
	 * 没点到」一模一样。原因得摆在按得到它的那一屏上,不能摆在弹窗背后。草稿也就留着:409 之后
	 * 重读一遍,主人看一眼再按一次,不用重填。
	 */
	error: string | null;
	/** 服务端校验不过、落得到某一格的那几句(那一格 → 那句话)。 */
	fieldErrors?: Readonly<Record<string, string>>;
	saving: boolean;
	onCancel: () => void;
	/** 动了一格 —— 上一发的错说的是上一发,一动手它就过时了(那一格底下那句尤其)。 */
	onEdit?: () => void;
	/**
	 * 新建:交出去的就是屏幕上这一份 —— 生成的那一格不许在别处再生成一次。编辑:只交改了的那几格
	 * (清空的是 `null`)。
	 */
	onSubmit: (values: Record<string, unknown>) => void;
}) {
	const editing = item !== undefined;
	const fields = dialogFieldsOf(field, editing ? "edit" : "new");
	const [initial] = useState(() => (item ? itemDraft(fields, item) : initialDraft(fields)));
	const [draft, setDraft] = useState(initial);
	const change = (key: string, value: string | boolean) => {
		onEdit?.();
		setDraft((prev) => ({ ...prev, [key]: value }));
	};
	const values = editing ? changedValuesOf(fields, initial, draft) : valuesOf(fields, draft);
	const blocked =
		fields.some(
			(sub) => isMissing(sub, draft[sub.key]) || draftErrorOf(sub, draft[sub.key]) !== undefined,
		) ||
		// 编辑时什么都没改,「保存」按了也是白发一次。
		(editing && Object.keys(values).length === 0);
	const copies = editing ? [] : copyRowsOf(field, extensionId, values);
	const itemLabel = itemLabelOf(field);
	const title = item ? titleOf(field, item) : "";
	const idle = editing ? "保存" : "创建";
	const busy = editing ? "保存中…" : "创建中…";

	return (
		<ModalShell
			width={540}
			onCancel={onCancel}
			title={editing ? `编辑${title ? `「${title}」` : `这条${itemLabel}`}` : `新建${field.label}`}
			description={editing ? undefined : field.description}
			bodyClassName="px-5 pb-[18px] pt-4"
		>
			<div className="flex flex-col gap-3.5">
				{fields.map((sub) => (
					<FieldShell
						key={sub.key}
						data-dialog-field={sub.key}
						field={sub}
						error={
							draftErrorOf(sub, draft[sub.key]) ??
							(fieldErrors && Object.hasOwn(fieldErrors, sub.key)
								? fieldErrors[sub.key]
								: undefined)
						}
					>
						<DraftControl
							sub={sub}
							value={draft[sub.key]}
							onChange={(value) => change(sub.key, value)}
						/>
					</FieldShell>
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
						{editing ? "改不了" : "建不了"}这条{itemLabel}:{error}
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
							if (!saving && !blocked) onSubmit(values);
						}}
					>
						{saving ? busy : idle}
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

/** 一格的控件。生成的那一格是弹窗自己的样子,别的格与设置表单同一件(`ScalarControl`)。 */
function DraftControl({
	sub,
	value,
	onChange,
}: {
	sub: ExtensionScalarField;
	value: string | boolean | undefined;
	onChange: (value: string | boolean) => void;
}): ReactNode {
	/*
	 * 生成的那一格**明文**摆着(决策 30「新建时明文显示一次」)—— 这是主人唯一一次看得到全文的
	 * 时候,存下之后卡上只露头尾。只读:格式由 BN 定(32 位小写十六进制),要换就按旁边那颗。
	 */
	if (sub.type === "string" && sub.generate) {
		return (
			<div className="flex items-center gap-2">
				<span
					data-generated={sub.key}
					className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-bn-border bg-bn-surface-muted px-2.5 font-mono text-bn-xs text-bn-text-secondary"
				>
					{typeof value === "string" ? value : ""}
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
	return <ScalarControl field={sub} value={value ?? ""} onChange={onChange} />;
}
