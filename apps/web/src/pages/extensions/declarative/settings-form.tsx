import type { SettingsScalarField } from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	ErrorNote,
	GlassBox,
	LoadingBlock,
	SavedSecretControl,
} from "@bilibili-notify/ui";
import { type HTMLAttributes, type ReactNode, useState } from "react";
import { SettingsFieldControl } from "../../../components/settings-field-control";
import { useT } from "../../../i18n";
import { clientErrorOf, decimalOf } from "../../../utils/settings-field-validation";
import { reasonOf } from "../shared";
import { settingsIssuesOf, settingsValuesOf, writeReasonOf } from "./list-items";
import { CopyControl, MissingSecretNote, RegenerateButton, SecretChip } from "./parts";
import { maskedOf, newHexSecret } from "./secret";
import { type SettingsWrite, useExtensionSettings, useSettingsWrite } from "./settings-query";

/**
 * 一个 v2 拓展的「设置」那张卡 —— 照清单里的设置项画(ADR-0019 决策 17 / 30),改完按「保存」
 * 才写。**只管单值的那几种**(`string` / `number` / `boolean` / `enum`);`list` 那种每项一张卡、
 * 有新建弹窗与删除确认,另画一节,不进这张表单。
 *
 * 读写走拓展自己的口 `/api/ext/:id/settings`(决策 35):读回来的密钥只有服务端算好的头尾;存的
 * 时候带着读到的版本号、每一格改了的发一步 `set`(一发里一起发)。服务端照清单校验,拓展在跑时再过
 * 它自己的 zod。**拓展关着也能改**(决策 32):设置只是存着的数据,「装好 → 填 → 启用」这个顺序
 * 靠它才走得通。
 */

/** 一格没存的改动:数字格存的是输入框里的字(空着、打到一半都得表达得出来)。 */
type Edit = string | boolean;

/** 只遮不改的那种:`secret` 且不是 `generate`(那种是只读 + 重新生成)。 */
function isSecretInput(field: SettingsScalarField): boolean {
	return field.type === "string" && field.secret === true && field.generate !== true;
}

/**
 * 按设置项的 key 读草稿、错误表、存着的设置 —— **只认它自己身上的键**。判「有没有」用
 * `Object.hasOwn`,不用 `in`。
 *
 * 🔴 key 归拓展自己起,而这些都是普通对象:key 叫 `valueOf` / `toString` / `constructor` 时,
 * `in` 与 `obj[key] ?? …` 读到的是 `Object.prototype` 上的同名函数 —— number 格一上来就报错、
 * 整张表单存不了,字符串格里显示 `function toString()…`,服务端落到这一格的那句话被 `??=`
 * 吞掉。服务端会在清单那一步挡掉这些名字,但面板自己也得站得住:这个文件里按 key 读的一律走它。
 */
function own<T>(bag: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
	return bag !== undefined && Object.hasOwn(bag, key) ? bag[key] : undefined;
}

/**
 * 这一格「没改过」时显示什么:存着的值 → 清单里的默认值 → 空。
 *
 * 默认值只是**显示**:没改过的格不发,拓展那份 zod 自己会补默认值。密钥与生成的那种不看默认值 ——
 * 一把写在清单里的默认钥匙人人都知道。
 */
function baselineOf(field: SettingsScalarField, stored: Record<string, unknown>): Edit {
	const raw = own(stored, field.key);
	switch (field.type) {
		case "string":
			// 🔴 密钥格**从不**拿存着的东西当输入框的值 —— 下发的本来就只是遮挡,按「换一份」给的
			// 必须是空框;生成的那一格没有输入框,刚生成的那一把才进草稿。
			if (field.secret || field.generate) return "";
			if (typeof raw === "string") return raw;
			return field.default ?? "";
		case "number":
			if (typeof raw === "number") return String(raw);
			return field.default === undefined ? "" : String(field.default);
		case "boolean":
			return typeof raw === "boolean" ? raw : (field.default ?? false);
		case "enum":
			return typeof raw === "string" ? raw : (field.default ?? "");
	}
}

/**
 * 这一格算不算改过。
 *
 * 🔴 **密钥的值从来不进草稿**:遮住的那一格没有输入框,按了「换一份」给的是一个**空的**
 * 输入框,填了东西才算改过 —— 于是没重填的密钥一个字都不会被发回去(发回去的只可能是屏幕上
 * 那串点,或者一个空串把真值抹掉)。
 */
function isDirty(
	field: SettingsScalarField,
	edits: Readonly<Record<string, Edit>>,
	stored: Record<string, unknown>,
): boolean {
	if (!Object.hasOwn(edits, field.key)) return false;
	const edit = edits[field.key];
	if (isSecretInput(field)) return edit !== "";
	return edit !== baselineOf(field, stored);
}

/**
 * 发出去的那一格(`set` 的 `value`)。**空着的可选格发 `null`** —— 「删掉这一格」在线上只有 `null`
 * 说得出来;不发这一格的意思是「不改」,旧值会原样留着。
 */
function wireValueOf(field: SettingsScalarField, value: Edit): unknown {
	if (typeof value === "boolean") return value;
	// 认不出的数走不到这里(`clientErrorOf` 拦着保存)。
	if (field.type === "number") return value.trim() === "" ? null : decimalOf(value);
	return value === "" ? null : value;
}

/**
 * 校验不过那份 400(`{ code: "invalid", issues }`,路径从设置那一层数)拆成两半。一条都拆
 * 不出来的交 `null`,与别的失败一样说原话 —— 与列表那一节(`writeFailureOf`)同一个口径。
 */
interface SaveIssues {
	/** 落得到某一格的:那一格 → 服务端那句话。 */
	byField: Record<string, string>;
	/** 落不到的(拓展自己跨格的规矩、别处的):摆在表单顶上。 */
	rest: string[];
}

function saveIssuesOf(err: unknown, keys: ReadonlySet<string>): SaveIssues | null {
	const issues = settingsIssuesOf(err);
	if (!issues || issues.length === 0) return null;
	const out: SaveIssues = { byField: {}, rest: [] };
	for (const { path, message, text } of issues) {
		const [key] = path;
		if (typeof key === "string" && keys.has(key)) {
			// 同一格有好几句的,留第一句。
			if (!Object.hasOwn(out.byField, key)) out.byField[key] = message;
			continue;
		}
		out.rest.push(text);
	}
	return out;
}

/** 一发保存带的东西 —— 走 variables,不从闭包里拿(写成之后要知道**这一发**发了什么)。 */
interface SaveVars extends SettingsWrite {
	/** 这一发是照着哪份草稿发的:存上之后只丢掉没再改过的那几格。 */
	sent: Record<string, Edit>;
}

export function SettingsForm({
	extensionId,
	fields,
}: {
	extensionId: string;
	fields: readonly SettingsScalarField[];
}) {
	const tx = useT();

	const settings = useExtensionSettings(extensionId);
	const [edits, setEdits] = useState<Record<string, Edit>>({});
	/** 按了「换一份」的密钥 —— 只管显示(遮住 / 输入框),值照样只在 `edits` 里。 */
	const [replacing, setReplacing] = useState<Record<string, boolean>>({});
	/** 等着确认「重新生成」的那一格。 */
	const [confirming, setConfirming] = useState<SettingsScalarField | null>(null);

	const stored = settingsValuesOf(settings.data);

	// 回应(写后的整份)先进缓存、再丢草稿 —— 反过来的话会闪一下旧值。不等重读:为什么见
	// `useSettingsWrite`。409 时草稿原样留着,重读回来的是别人刚写的那份,主人看一眼再存。
	const save = useSettingsWrite<SaveVars>(extensionId, (_written, { sent }) => {
		const keep = (key: string, current: Edit | undefined) =>
			!Object.hasOwn(sent, key) || current !== sent[key];
		setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k, v]) => keep(k, v))));
		setReplacing((prev) =>
			Object.fromEntries(Object.entries(prev).filter(([k]) => !Object.hasOwn(sent, k))),
		);
	});

	const currentOf = (field: SettingsScalarField): Edit =>
		Object.hasOwn(edits, field.key) ? (edits[field.key] as Edit) : baselineOf(field, stored);

	const edit = (key: string, value: Edit) => {
		// 上一发的错说的是上一发:一动手它就过时了。
		if (save.isError) save.reset();
		setEdits((prev) => ({ ...prev, [key]: value }));
	};
	const drop = (key: string) => {
		setEdits(({ [key]: _, ...rest }) => rest);
		setReplacing(({ [key]: _, ...rest }) => rest);
	};

	const dirty = fields.filter((field) => isDirty(field, edits, stored));
	const clientErrors: Record<string, string> = {};
	for (const field of dirty) {
		const error = clientErrorOf(field, currentOf(field));
		if (error) clientErrors[field.key] = error;
	}
	const touched = Object.keys(edits).length > 0 || Object.keys(replacing).length > 0;
	const canSave = dirty.length > 0 && Object.keys(clientErrors).length === 0;

	const keys = new Set(fields.map((field) => field.key));
	const issues = save.isError ? saveIssuesOf(save.error, keys) : null;
	// 表单顶上那句:落不到某一格的那几句;拆不出来的失败(409、只读盘、断网)说它自己的话。
	const pageError = save.isError ? (issues?.rest.join(";") ?? writeReasonOf(save.error)) : "";

	const submit = () => {
		const revision = settings.data?.revision;
		if (!canSave || revision === undefined) return;
		const sent: Record<string, Edit> = {};
		// 改了几格就几步 `set`,一发里一起发 —— 要么都存上,要么一格都不存。
		const ops = dirty.map((field) => {
			const value = currentOf(field);
			sent[field.key] = value;
			return { op: "set" as const, key: field.key, value: wireValueOf(field, value) };
		});
		save.mutate({ revision, ops, sent });
	};

	const revert = () => {
		save.reset();
		setEdits({});
		setReplacing({});
	};

	/**
	 * 重新生成。**有值的先问一句**(决策 30):存下之后旧的那份就作废,用着它的那一头会断开。
	 * 空着的(脱敏备份恢复回来就是这样)与刚生成、还没存的那份不问 —— 没有旧钥匙可作废。
	 */
	const regenerate = (field: SettingsScalarField) => {
		const hasSaved = maskedOf(own(stored, field.key)) !== undefined;
		if (hasSaved && !Object.hasOwn(edits, field.key)) {
			setConfirming(field);
			return;
		}
		edit(field.key, newHexSecret());
	};

	let body: ReactNode;
	if (settings.isPending) {
		body = (
			<LoadingBlock
				variant="inset"
				label={tx("panelUi.pages.extensions.declarative.settings-form.7")}
			/>
		);
	} else if (settings.isError) {
		/*
		 * 🔴 **「读不到」不许画成「全是默认值」**:照着一张假的表改完一存,只发改了的那几格
		 * 倒是不会抹掉别的 —— 但主人看到的「现在是什么」全是假话。
		 */
		body = (
			<ErrorNote size="sm">
				{tx("panelUi.pages.extensions.declarative.settings-form.8")}
				{reasonOf(settings.error)}
			</ErrorNote>
		);
	} else {
		body = (
			<div className="flex flex-col gap-4">
				{pageError ? (
					<ErrorNote size="sm">
						{tx("panelUi.pages.extensions.declarative.settings-form.9")}
						{pageError}
					</ErrorNote>
				) : null}
				<div className="grid gap-4 md:grid-cols-2">
					{fields.map((field) => (
						<FieldShell
							key={field.key}
							data-setting={field.key}
							className={`min-w-0 ${isWide(field) ? "md:col-span-2" : ""}`}
							field={field}
							error={own(clientErrors, field.key) ?? own(issues?.byField, field.key)}
						>
							<FieldControl
								field={field}
								value={currentOf(field)}
								savedMask={maskedOf(own(stored, field.key))}
								fresh={Object.hasOwn(edits, field.key)}
								replacing={own(replacing, field.key) === true}
								onChange={(value) => edit(field.key, value)}
								onReplace={() => setReplacing((prev) => ({ ...prev, [field.key]: true }))}
								onCancelReplace={() => drop(field.key)}
								onRegenerate={() => regenerate(field)}
							/>
						</FieldShell>
					))}
				</div>
			</div>
		);
	}

	return (
		<>
			<GlassBox
				title={tx("panelUi.pages.extensions.declarative.settings-form.10")}
				subtitle={tx("panelUi.pages.extensions.declarative.settings-form.11")}
				right={
					<div className="flex shrink-0 items-center gap-2">
						<Btn variant="outline" size="sm" disabled={!touched || save.isPending} onClick={revert}>
							{tx("panelUi.pages.extensions.declarative.settings-form.12")}
						</Btn>
						<Btn variant="primary" size="sm" disabled={!canSave || save.isPending} onClick={submit}>
							{save.isPending
								? tx("panelUi.pages.extensions.declarative.settings-form.13")
								: tx("panelUi.pages.extensions.declarative.settings-form.14")}
						</Btn>
					</div>
				}
			>
				{body}
			</GlassBox>
			{confirming ? (
				<ConfirmDialog
					title={tx("panelUi.pages.extensions.declarative.settings-form.15", {
						value0: confirming.label,
					})}
					message={tx("panelUi.pages.extensions.declarative.settings-form.16")}
					confirmLabel={tx("panelUi.pages.extensions.declarative.settings-form.17")}
					danger
					onConfirm={() => {
						edit(confirming.key, newHexSecret());
						setConfirming(null);
					}}
					onCancel={() => setConfirming(null)}
				/>
			) : null}
		</>
	);
}

// ── 一格 ─────────────────────────────────────────────────────────────────────

/** 占满一整行的:字(可能很长)与带图标的选项卡片;数字、开关、分段按钮两两并排。 */
function isWide(field: SettingsScalarField): boolean {
	if (field.type === "string") return true;
	return field.type === "enum" && field.options.some((option) => option.icon);
}

/** 格下那一档小字:说明,以及生成的那一格刚换过时那句提醒。 */
const FIELD_NOTE_CLS = "mt-[7px] text-bn-2xs leading-[1.7] text-bn-text-tertiary";

/**
 * 一格的壳:标题(必填带星)+ 控件 + 它自己的错 + 说明。设置表单与列表的新建弹窗**共用这一份**
 * —— 各写一份时已经漂过:弹窗里的必填格没有星、说明的行距只有一边有。外面那一层(栅格占几列、
 * 挂什么标记)走 `div` 的属性,由摆放处给。
 */
export function FieldShell({
	field,
	error,
	children,
	...box
}: {
	field: SettingsScalarField;
	error?: string;
	children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">) {
	return (
		<div {...box}>
			<div className="mb-1.5 flex items-center gap-1.5">
				<span className="text-bn-xs font-bold text-bn-text-secondary">{field.label}</span>
				{field.required ? (
					<span aria-hidden="true" className="text-bn-xs font-bold text-bn-pink">
						*
					</span>
				) : null}
			</div>
			{children}
			{error ? (
				<ErrorNote size="sm" className="mt-1.5">
					{error}
				</ErrorNote>
			) : null}
			{field.description ? <p className={FIELD_NOTE_CLS}>{field.description}</p> : null}
		</div>
	);
}

function FieldControl({
	field,
	value,
	savedMask,
	fresh,
	replacing,
	onChange,
	onReplace,
	onCancelReplace,
	onRegenerate,
}: {
	field: SettingsScalarField;
	value: Edit;
	/** 存着的那一把在屏幕上的样子(服务端给的遮挡)—— 只给密钥那两种用;没存是 `undefined`。 */
	savedMask: string | undefined;
	/** 这一格有没存的改动(生成的那种:屏幕上是刚生成、还没存的那一把)。 */
	fresh: boolean;
	replacing: boolean;
	onChange: (value: Edit) => void;
	onReplace: () => void;
	onCancelReplace: () => void;
	onRegenerate: () => void;
}) {
	if (field.type === "string" && field.generate) {
		return (
			<GeneratedValue
				label={field.label}
				fresh={fresh ? String(value) : undefined}
				savedMask={savedMask}
				onRegenerate={onRegenerate}
			/>
		);
	}
	if (field.type === "string" && field.secret) {
		return (
			<SavedSecretControl
				savedMask={savedMask}
				replacing={replacing}
				onReplace={onReplace}
				onCancelReplace={onCancelReplace}
			>
				<SettingsFieldControl field={field} value={value} onChange={onChange} />
			</SavedSecretControl>
		);
	}
	return <SettingsFieldControl field={field} value={value} onChange={onChange} />;
}

/**
 * `generate` 那一格(决策 30 / 38):只读、能重新生成,格式由 BN 定(32 位小写十六进制)。
 *
 * 存着的那一把只画服务端给的遮挡、**不给复制** —— 浏览器只拿得到头尾,要全文就重新生成。刚生成、
 * 还没存的那一把**明文显示、能复制**:主人要把它抄进对面去,只有这一刻明文在面板手里。
 */
function GeneratedValue({
	label,
	fresh,
	savedMask,
	onRegenerate,
}: {
	label: string;
	/** 刚生成、还没存的那一把。 */
	fresh: string | undefined;
	savedMask: string | undefined;
	onRegenerate: () => void;
}) {
	const tx = useT();

	if (fresh === undefined && savedMask === undefined) {
		return (
			<div className="flex flex-wrap items-center gap-2.5">
				<MissingSecretNote label={label} onRegenerate={onRegenerate}>
					{tx("panelUi.pages.extensions.declarative.settings-form.18", { field: label })}
				</MissingSecretNote>
			</div>
		);
	}
	return (
		<>
			<div className="flex flex-wrap items-center gap-2.5">
				<SecretChip text={fresh ?? savedMask ?? ""} />
				{fresh !== undefined ? (
					<CopyControl
						label={tx("panelUi.pages.extensions.declarative.settings-form.20", { value0: label })}
						text={fresh}
					/>
				) : null}
				<RegenerateButton label={label} onClick={onRegenerate} />
			</div>
			{fresh !== undefined ? (
				<p className={FIELD_NOTE_CLS}>
					{tx("panelUi.pages.extensions.declarative.settings-form.21")}
				</p>
			) : null}
		</>
	);
}
