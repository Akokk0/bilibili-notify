import type { ExtensionScalarField } from "@bilibili-notify/contract";
import {
	Btn,
	ConfirmDialog,
	ErrorNote,
	GlassBox,
	HintNote,
	Icon,
	LoadingBlock,
	MonoChip,
	OptionCard,
	Picker,
	TArea,
	TInput,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api } from "../../../services/api";
import type { GlobalConfig } from "../../../types/globals";
import { reasonOf } from "../shared";
import { safeImage } from "./image";
import { CopyControl } from "./parts";
import { maskSecret, newHexSecret } from "./secret";

/**
 * 一个 v2 拓展的「设置」那张卡 —— 照清单里的设置项画(ADR-0019 决策 17 / 30),改完按「保存」
 * 才写。**只管单值的那几种**(`string` / `number` / `boolean` / `enum`);`list` 那种每项一张卡、
 * 有新建弹窗与删除确认,另画一节,不进这张表单。
 *
 * 值来自 `globals.extensions.<id>.settings`,写回走同一条 `PATCH /api/globals` —— 设置的写路径
 * 只有 BN 这一条(决策 22),服务端照清单校验(决策 17)。**拓展关着也能改**(决策 32):设置
 * 只是存着的数据,「装好 → 填 → 启用」这个顺序靠它才走得通。
 */

/** 一格没存的改动:数字格存的是输入框里的字(空着、打到一半都得表达得出来)。 */
type Edit = string | boolean;

/** 只遮不改的那种:`secret` 且不是 `generate`(那种是只读 + 重新生成)。 */
function isSecretInput(field: ExtensionScalarField): boolean {
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
function baselineOf(field: ExtensionScalarField, stored: Record<string, unknown>): Edit {
	const raw = own(stored, field.key);
	switch (field.type) {
		case "string":
			// 🔴 密钥的真值**从不**当成输入框的值 —— 按「换一份」给的必须是空框,否则真值就摆在
			// 一个 value 里(devtools 看得见、截图里有、改两个字再存就是一把半新半旧的钥匙)。
			if (isSecretInput(field)) return "";
			if (typeof raw === "string") return raw;
			return field.generate ? "" : (field.default ?? "");
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
	field: ExtensionScalarField,
	edits: Readonly<Record<string, Edit>>,
	stored: Record<string, unknown>,
): boolean {
	if (!Object.hasOwn(edits, field.key)) return false;
	const edit = edits[field.key];
	if (isSecretInput(field)) return edit !== "";
	return edit !== baselineOf(field, stored);
}

/** 数字的范围说成一句话。 */
function rangeText(min: number | undefined, max: number | undefined): string {
	if (min !== undefined && max !== undefined) return `要在 ${min} 到 ${max} 之间`;
	if (min !== undefined) return `不能小于 ${min}`;
	return `不能大于 ${max}`;
}

/**
 * 当场就能说的毛病(决策 30「min / max 当场校验」)。只看**改过的**格:没动过的格是存着的
 * 样子,那归服务端说。
 */
function clientErrorOf(field: ExtensionScalarField, value: Edit): string | undefined {
	if (field.type === "number") {
		const text = String(value).trim();
		if (text === "") return field.required ? "这一格必填" : undefined;
		const n = Number(text);
		if (!Number.isFinite(n)) return "要填一个数字";
		if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
			return rangeText(field.min, field.max);
		}
		return undefined;
	}
	if (field.type === "string" && field.required && value === "") return "这一格必填";
	return undefined;
}

/**
 * 发出去的那一格。**空着的可选格发 `null`** —— 设置是 JSON Merge Patch,「删掉这个键」在线上
 * 只有 `null` 说得出来;把键拿掉的意思是「不改」,旧值会原样留着。
 */
function wireValueOf(field: ExtensionScalarField, value: Edit): unknown {
	if (typeof value === "boolean") return value;
	if (field.type === "number") return value.trim() === "" ? null : Number(value);
	return value === "" ? null : value;
}

/** 服务端照清单校验不过时那份 400(`{ error: "validation_failed", issues }`)拆成两半。 */
interface SaveIssues {
	/** 落得到某一格的:那一格 → 服务端那句话。 */
	byField: Record<string, string>;
	/** 落不到的(列表那一节的、别处的):摆在表单顶上。 */
	rest: string[];
}

function saveIssuesOf(
	err: unknown,
	extensionId: string,
	keys: ReadonlySet<string>,
): SaveIssues | null {
	const body = (err as { body?: unknown } | null)?.body as
		| { error?: unknown; issues?: unknown }
		| undefined;
	if (body?.error !== "validation_failed" || !Array.isArray(body.issues)) return null;
	const out: SaveIssues = { byField: {}, rest: [] };
	for (const issue of body.issues as { path?: unknown; message?: unknown }[]) {
		const path = Array.isArray(issue?.path) ? (issue.path as unknown[]) : [];
		const message = typeof issue?.message === "string" ? issue.message : "不合规矩";
		const [scope, id, slot, key] = path;
		const mine = scope === "extensions" && id === extensionId && slot === "settings";
		if (mine && typeof key === "string" && keys.has(key)) {
			// 同一格有好几句的,留第一句。
			if (!Object.hasOwn(out.byField, key)) out.byField[key] = message;
			continue;
		}
		const where = (mine ? path.slice(3) : path).join(".");
		out.rest.push(where ? `${where}:${message}` : message);
	}
	return out;
}

/** 一发保存带的东西 —— 走 variables,不从闭包里拿(onSuccess 要知道**这一发**发了什么)。 */
interface SaveVars {
	patch: Record<string, unknown>;
	/** 这一发是照着哪份草稿发的:存上之后只丢掉没再改过的那几格。 */
	sent: Record<string, Edit>;
}

export function SettingsForm({
	extensionId,
	fields,
}: {
	extensionId: string;
	fields: readonly ExtensionScalarField[];
}) {
	const qc = useQueryClient();
	const globals = useQuery({
		queryKey: ["globals"],
		queryFn: () => api.get<GlobalConfig>("/api/globals"),
	});
	const [edits, setEdits] = useState<Record<string, Edit>>({});
	/** 按了「换一份」的密钥 —— 只管显示(遮住 / 输入框),值照样只在 `edits` 里。 */
	const [replacing, setReplacing] = useState<Record<string, true>>({});
	/** 等着确认「重新生成」的那一格。 */
	const [confirming, setConfirming] = useState<ExtensionScalarField | null>(null);

	const rawSettings = (
		globals.data?.extensions as Record<string, { settings?: unknown } | undefined> | undefined
	)?.[extensionId]?.settings;
	const stored: Record<string, unknown> =
		typeof rawSettings === "object" && rawSettings !== null && !Array.isArray(rawSettings)
			? (rawSettings as Record<string, unknown>)
			: {};

	const save = useMutation({
		mutationFn: ({ patch }: SaveVars) =>
			api.patch("/api/globals", { extensions: { [extensionId]: { settings: patch } } }),
		onSuccess: async (_data, { sent }) => {
			// 先等那份设置重读回来,再丢草稿 —— 反过来的话会闪一下旧值。
			await qc.invalidateQueries({ queryKey: ["globals"] });
			const keep = (key: string, current: Edit | undefined) =>
				!Object.hasOwn(sent, key) || current !== sent[key];
			setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k, v]) => keep(k, v))));
			setReplacing(
				(prev) =>
					Object.fromEntries(
						Object.entries(prev).filter(([k]) => !Object.hasOwn(sent, k)),
					) as Record<string, true>,
			);
		},
	});

	const currentOf = (field: ExtensionScalarField): Edit =>
		Object.hasOwn(edits, field.key) ? (edits[field.key] as Edit) : baselineOf(field, stored);

	const edit = (key: string, value: Edit) => {
		// 上一发的错说的是上一发:一动手它就过时了。
		if (save.isError) save.reset();
		setEdits((prev) => ({ ...prev, [key]: value }));
	};
	const drop = (key: string) => {
		setEdits(({ [key]: _, ...rest }) => rest);
		setReplacing(({ [key]: _, ...rest }) => rest as Record<string, true>);
	};

	const dirty = fields.filter((field) => isDirty(field, edits, stored));
	const clientErrors: Record<string, string> = {};
	for (const field of dirty) {
		const error = clientErrorOf(field, currentOf(field));
		if (error) clientErrors[field.key] = error;
	}
	const touched = Object.keys(edits).length > 0 || Object.keys(replacing).length > 0;

	const keys = new Set(fields.map((field) => field.key));
	const issues = save.isError ? saveIssuesOf(save.error, extensionId, keys) : null;
	const pageError = !save.isError
		? null
		: issues
			? issues.rest.length > 0
				? issues.rest.join(";")
				: null
			: reasonOf(save.error);

	const submit = () => {
		if (dirty.length === 0 || Object.keys(clientErrors).length > 0) return;
		const patch: Record<string, unknown> = {};
		const sent: Record<string, Edit> = {};
		for (const field of dirty) {
			const value = currentOf(field);
			patch[field.key] = wireValueOf(field, value);
			sent[field.key] = value;
		}
		save.mutate({ patch, sent });
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
	const regenerate = (field: ExtensionScalarField) => {
		const saved = own(stored, field.key);
		const hasSaved = typeof saved === "string" && saved !== "";
		if (hasSaved && !Object.hasOwn(edits, field.key)) {
			setConfirming(field);
			return;
		}
		edit(field.key, newHexSecret());
	};

	let body: ReactNode;
	if (globals.isPending) {
		body = <LoadingBlock variant="inset" label="正在读取设置" />;
	} else if (globals.isError) {
		/*
		 * 🔴 **「读不到」不许画成「全是默认值」**:照着一张假的表改完一存,只发改了的那几格
		 * 倒是不会抹掉别的 —— 但主人看到的「现在是什么」全是假话。
		 */
		body = <ErrorNote size="sm">读不到这个拓展的设置:{reasonOf(globals.error)}</ErrorNote>;
	} else {
		body = (
			<div className="flex flex-col gap-4">
				{pageError ? <ErrorNote size="sm">没存进去:{pageError}</ErrorNote> : null}
				<div className="grid gap-4 md:grid-cols-2">
					{fields.map((field) => (
						<FieldRow
							key={field.key}
							field={field}
							error={own(clientErrors, field.key) ?? own(issues?.byField, field.key)}
						>
							<FieldControl
								field={field}
								value={currentOf(field)}
								saved={own(stored, field.key)}
								fresh={Object.hasOwn(edits, field.key)}
								replacing={own(replacing, field.key) === true}
								onChange={(value) => edit(field.key, value)}
								onReplace={() => setReplacing((prev) => ({ ...prev, [field.key]: true }))}
								onCancelReplace={() => drop(field.key)}
								onRegenerate={() => regenerate(field)}
							/>
						</FieldRow>
					))}
				</div>
			</div>
		);
	}

	return (
		<>
			<GlassBox
				title="设置"
				subtitle="改完按保存才生效;拓展关着时也能先填好。"
				right={
					<div className="flex shrink-0 items-center gap-2">
						<Btn variant="outline" size="sm" disabled={!touched || save.isPending} onClick={revert}>
							还原
						</Btn>
						<Btn
							variant="primary"
							size="sm"
							disabled={
								dirty.length === 0 || save.isPending || Object.keys(clientErrors).length > 0
							}
							onClick={submit}
						>
							{save.isPending ? "保存中…" : "保存"}
						</Btn>
					</div>
				}
			>
				{body}
			</GlassBox>
			{confirming ? (
				<ConfirmDialog
					title={`重新生成「${confirming.label}」?`}
					message="旧的那一份在保存之后就作废 —— 所有用着它的地方都得换成新的那一份。"
					confirmLabel="重新生成"
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
function isWide(field: ExtensionScalarField): boolean {
	if (field.type === "string") return true;
	return field.type === "enum" && field.options.some((option) => option.icon);
}

/** 一格的壳:标题(必填带星)+ 控件 + 它自己的错 + 说明。 */
function FieldRow({
	field,
	error,
	children,
}: {
	field: ExtensionScalarField;
	error: string | undefined;
	children: ReactNode;
}) {
	return (
		<div data-setting={field.key} className={`min-w-0 ${isWide(field) ? "md:col-span-2" : ""}`}>
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
			{field.description ? (
				<p className="mt-[7px] text-bn-2xs leading-[1.7] text-bn-text-tertiary">
					{field.description}
				</p>
			) : null}
		</div>
	);
}

function FieldControl({
	field,
	value,
	saved,
	fresh,
	replacing,
	onChange,
	onReplace,
	onCancelReplace,
	onRegenerate,
}: {
	field: ExtensionScalarField;
	value: Edit;
	/** 存着的那份原值 —— 只给遮住的那两种用(遮哪一串 / 有没有东西可遮)。 */
	saved: unknown;
	/** 这一格有没存的改动(生成的那种:屏幕上是刚生成、还没存的那一把)。 */
	fresh: boolean;
	replacing: boolean;
	onChange: (value: Edit) => void;
	onReplace: () => void;
	onCancelReplace: () => void;
	onRegenerate: () => void;
}) {
	switch (field.type) {
		case "string":
			if (field.generate) {
				return (
					<GeneratedValue
						label={field.label}
						value={String(value)}
						fresh={fresh}
						onRegenerate={onRegenerate}
					/>
				);
			}
			if (field.secret) {
				const hasSaved = typeof saved === "string" && saved !== "";
				if (hasSaved && !replacing) {
					return (
						<div className="flex flex-wrap items-center gap-2.5">
							<MonoChip className="min-w-0 flex-1 truncate px-[9px] py-[5px]">
								{maskSecret(saved)}
							</MonoChip>
							<Btn variant="outline" size="sm" onClick={onReplace}>
								换一份
							</Btn>
						</div>
					);
				}
				const input = field.multiline ? (
					<TArea
						ariaLabel={field.label}
						value={String(value)}
						onChange={onChange}
						placeholder={field.placeholder}
						mono
					/>
				) : (
					<TInput
						ariaLabel={field.label}
						value={String(value)}
						onChange={onChange}
						placeholder={field.placeholder}
						secret
					/>
				);
				return hasSaved ? (
					<div className="flex items-start gap-2.5">
						<div className="min-w-0 flex-1">{input}</div>
						<Btn variant="ghost" size="sm" onClick={onCancelReplace}>
							不换了
						</Btn>
					</div>
				) : (
					input
				);
			}
			return field.multiline ? (
				<TArea
					ariaLabel={field.label}
					value={String(value)}
					onChange={onChange}
					placeholder={field.placeholder}
					mono={field.monospace}
				/>
			) : (
				<TInput
					ariaLabel={field.label}
					value={String(value)}
					onChange={onChange}
					placeholder={field.placeholder}
					mono={field.monospace}
				/>
			);
		case "number":
			return (
				<div className="flex items-center gap-2">
					{/*
					 * 走 TInput 而不是 TNum:TNum 交出来的永远是个数,清空那一格会变成 0 —— 可选的
					 * 数字格清空要发 `null`,打到一半的「-」也得先留在框里。
					 */}
					<TInput
						type="number"
						width={120}
						ariaLabel={field.label}
						value={String(value)}
						onChange={onChange}
					/>
					{field.unit ? (
						<span className="text-bn-xs text-bn-text-tertiary">{field.unit}</span>
					) : null}
				</div>
			);
		case "boolean":
			return <Toggle ariaLabel={field.label} value={value === true} onChange={onChange} />;
		case "enum":
			return <EnumControl field={field} value={String(value)} onChange={onChange} />;
	}
}

/**
 * 一格 `enum`(决策 30):选项带图标 → 两张一排的选项卡片(桥的「哪一种桥」),不带 → 分段按钮。
 * 设置表单与列表的新建弹窗**共用这一份** —— 各画各的话,同一个清单在两处长成两种控件。
 */
export function EnumControl({
	field,
	value,
	onChange,
}: {
	field: Extract<ExtensionScalarField, { type: "enum" }>;
	value: string;
	onChange: (value: string) => void;
}) {
	if (field.options.some((option) => option.icon)) {
		return (
			// `<fieldset>` 而不是 `<div role="group">`:同一个语义,原生元素不用手写 role。
			<fieldset aria-label={field.label} className="grid min-w-0 grid-cols-2 gap-2.5">
				{field.options.map((option) => (
					<OptionCard
						key={option.value}
						active={value === option.value}
						label={option.label}
						mark={option.value}
						logo={safeImage(option.icon)}
						onSelect={() => onChange(option.value)}
					/>
				))}
			</fieldset>
		);
	}
	return (
		<fieldset aria-label={field.label} className="min-w-0">
			<Picker
				value={value}
				onChange={onChange}
				options={field.options.map((option) => ({ value: option.value, label: option.label }))}
			/>
		</fieldset>
	);
}

/**
 * `generate` 那一格(决策 30):只读、遮住、能复制、能重新生成,格式由 BN 定(32 位小写十六进制)。
 * 刚生成还没存的那一把**明文显示** —— 主人要把它抄进对面去,存下之后就只露头尾。
 */
function GeneratedValue({
	label,
	value,
	fresh,
	onRegenerate,
}: {
	label: string;
	value: string;
	fresh: boolean;
	onRegenerate: () => void;
}) {
	const regenerate = (
		<Btn
			variant="danger-outline"
			size="sm"
			aria-label={`重新生成 ${label}`}
			icon={<Icon.refresh size={13} />}
			onClick={onRegenerate}
		>
			重新生成
		</Btn>
	);
	/*
	 * 🔴 空值是**脱敏备份恢复回来**的常态,不是稀罕情况。只说一句「生成一份」却不给那颗钮,
	 * 等于请人做一件他在这一页上做不到的事(同桥 token 行那一条)。
	 */
	if (!value) {
		return (
			<div className="flex flex-wrap items-center gap-2.5">
				<HintNote tone="danger" className="min-w-0 flex-1">
					还没有 {label} —— 脱敏备份恢复回来的就是这样,生成一份新的。
				</HintNote>
				{regenerate}
			</div>
		);
	}
	return (
		<>
			<div className="flex flex-wrap items-center gap-2.5">
				<MonoChip className="min-w-0 flex-1 truncate px-[9px] py-[5px]">
					{fresh ? value : maskSecret(value)}
				</MonoChip>
				<CopyControl label={`复制 ${label}`} text={value} />
				{regenerate}
			</div>
			{fresh ? (
				<p className="mt-[7px] text-bn-2xs leading-[1.7] text-bn-text-tertiary">
					新生成的,还没保存 —— 存下之后只露头尾,要用就趁现在复制。
				</p>
			) : null}
		</>
	);
}
