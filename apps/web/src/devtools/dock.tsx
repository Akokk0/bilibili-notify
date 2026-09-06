/**
 * DevDock —— devtools 在面板里的整套:左下角药丸 + 底边面板。
 *
 * **只在开发期存在。** 挂载点在 App.tsx,包在 `import.meta.env.DEV` 里,生产 bundle 连这个
 * 模块都不含;服务端那半靠 `GET /api/dev` 探(404 = 那台不是开发版 → 整个不出现)。
 *
 * 面板不认识任何具体场景:场景是服务端 + 前端两张表并成的一张(`registry.ts`),参数照
 * `params` 的 schema 画控件。加一个场景 = 在注册表里加一条,这里一行不改。
 */

import type {
	DevInjection,
	DevParamField,
	DevParamValues,
	DevScenarioGroup,
	DevStatusDTO,
} from "@bilibili-notify/contract";
import {
	Btn,
	DockPanel,
	DockPill,
	EmptyNote,
	ErrorNote,
	HintNote,
	Icon,
	IconButton,
	type IconName,
	Pill,
	SELECTED_TINT_BG,
	TInput,
	TNum,
	TSelect,
} from "@bilibili-notify/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { CaptureView } from "./capture-view";
import { PickSelect } from "./pick-select";
import {
	type DevEntry,
	mergeScenarios,
	useWebActive,
	WEB_SCENARIOS,
	type WebDevScenario,
} from "./registry";
import { useDevActive, useDevStatus, useResetScenario, useRunScenario } from "./use-devtools";

const GROUPS: ReadonlyArray<{ id: DevScenarioGroup; label: string; icon: ReactNode }> = [
	{ id: "event", label: "事件", icon: <Icon.bell size={15} /> },
	{ id: "state", label: "状态", icon: <Icon.sliders size={15} /> },
	{ id: "timer", label: "定时", icon: <Icon.refresh size={15} /> },
	{ id: "capture", label: "截流", icon: <Icon.filter size={15} /> },
	{ id: "web", label: "前端", icon: <Icon.eye size={15} /> },
];

/** 场景自带的图标名优先(同组两个快捷位得分得开),没给就按分组取。 */
function iconOf(decl: DevEntry["decl"]): ReactNode {
	const named = decl.icon !== undefined ? Icon[decl.icon as IconName] : undefined;
	if (named) {
		const Glyph = named;
		return <Glyph size={15} />;
	}
	return GROUPS.find((g) => g.id === decl.group)?.icon;
}

const HEIGHT_KEY = "bn:devtools:height";
const DEFAULT_VIEWPORT_SHARE = 0.4;
/** 药丸骑在面板顶边上时,离顶边留这么多。 */
const GAP_ABOVE_PANEL = 12;

/**
 * 导览卡也钉在左下角(`fixed bottom-4 left-4 w-80`),而且层级高得多 —— 它是指令来源,
 * 按规矩谁都不许压它。于是它张开时会把药丸整个盖住、点都点不到,偏偏「新手指引停在第几步」
 * 这个场景要求导览开着。所以量一下它多高,把药丸顶到它上面去。
 */
const TOUR_CARD_SHOWN = '.bn-tour-card[data-shown="true"]';
const GAP_ABOVE_TOUR = 8;

function useTourClearance(): number {
	const [clearance, setClearance] = useState(0);
	useEffect(() => {
		const measure = () => {
			const el = document.querySelector<HTMLElement>(TOUR_CARD_SHOWN);
			setClearance(el ? Math.round(el.getBoundingClientRect().height) + GAP_ABOVE_TOUR : 0);
		};
		measure();
		// 导览卡一直挂在 DOM 上,张开 / 收起只翻 data-shown,所以盯属性就够。
		const mo = new MutationObserver(measure);
		mo.observe(document.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ["data-shown"],
		});
		const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		const card = document.querySelector(".bn-tour-card");
		if (card && ro) ro.observe(card);
		return () => {
			mo.disconnect();
			ro?.disconnect();
		};
	}, []);
	return clearance;
}

function readHeight(): number {
	try {
		const v = Number(window.localStorage.getItem(HEIGHT_KEY));
		if (Number.isFinite(v) && v > 0) return v;
	} catch {
		// 隐私模式等拿不到 localStorage:用默认高就是。
	}
	return Math.round(window.innerHeight * DEFAULT_VIEWPORT_SHARE);
}

export function DevDock({
	webScenarios = WEB_SCENARIOS,
}: {
	/** 前端半边的注册表;测试里换一份假的。 */
	webScenarios?: readonly WebDevScenario[];
}) {
	const status = useDevStatus();
	if (status.status !== "ready") return null;
	return <Ready data={status.data} webScenarios={webScenarios} />;
}

/** 场景表到手之后才挂生效表的轮询 —— 不是开发版就连这个小查询也不该打。 */
function Ready({
	data,
	webScenarios,
}: {
	data: DevStatusDTO;
	webScenarios: readonly WebDevScenario[];
}) {
	const serverActive = useDevActive(data.active);
	return (
		<Dock scenarios={data.scenarios} serverActive={serverActive} webScenarios={webScenarios} />
	);
}

type RunResult = { ok: true; summary?: string } | { ok: false; err: string };

function Dock({
	scenarios,
	serverActive,
	webScenarios,
}: {
	scenarios: DevEntry["decl"][];
	serverActive: DevInjection[];
	webScenarios: readonly WebDevScenario[];
}) {
	const [open, setOpen] = useState(false);
	const [height, setHeight] = useState(readHeight);
	const [group, setGroup] = useState<DevScenarioGroup>("state");
	const [results, setResults] = useState<Record<string, RunResult>>({});
	// 前端那半的生效表没有服务端替它记账,只能从 store 现算。不镜像进 state:那样只有
	// 「跑完 / 收完」这两个时机会更新,而面板之外的动作(灵动岛按「丢弃」、换页把草稿注销)
	// 照样会改掉它 —— 药丸就会一直宣称有一条早已不存在的注入。
	const clientActive = useWebActive(webScenarios);
	const tourClearance = useTourClearance();
	const run = useRunScenario(webScenarios);
	const reset = useResetScenario(webScenarios);
	const active = useMemo(() => [...serverActive, ...clientActive], [serverActive, clientActive]);

	const entries = useMemo(() => mergeScenarios(scenarios, webScenarios), [scenarios, webScenarios]);
	const close = useCallback(() => setOpen(false), []);

	useEffect(() => {
		try {
			window.localStorage.setItem(HEIGHT_KEY, String(height));
		} catch {
			// 记不住就记不住,下次开还是默认高。
		}
	}, [height]);

	const groupOf = (scenarioId: string) => entries.find((e) => e.decl.id === scenarioId)?.decl.group;
	const activeById = new Map(active.map((a) => [a.scenarioId, a]));

	const launch = (entry: DevEntry, params: DevParamValues) => {
		run.mutate(
			{ id: entry.decl.id, side: entry.side, params },
			{
				onSuccess: (out) => {
					setResults((r) => ({ ...r, [entry.decl.id]: { ok: true, summary: out.summary } }));
				},
				onError: (err) =>
					setResults((r) => ({
						...r,
						[entry.decl.id]: { ok: false, err: err instanceof Error ? err.message : String(err) },
					})),
			},
		);
	};
	const runningId = run.isPending ? run.variables?.id : undefined;

	const quick = entries
		.filter((e) => e.decl.quick)
		.map((e) => ({
			id: e.decl.id,
			label: e.decl.title,
			icon: iconOf(e.decl),
			// 快捷位不带参数:服务端按默认值补齐。
			onRun: () => launch(e, {}),
			busy: runningId === e.decl.id,
		}));

	const rail = GROUPS.map((g) => ({
		id: g.id,
		label: g.label,
		icon: g.icon,
		count: active.filter((a) => groupOf(a.scenarioId) === g.id).length,
	}));

	const shown = entries.filter((e) => e.decl.group === group);

	return (
		<>
			<DockPill
				label="devtools"
				icon={<Icon.wrench size={16} />}
				open={open}
				onToggle={() => setOpen((o) => !o)}
				active={active.length > 0}
				activeTitle={`${active.length} 项生效`}
				actions={quick}
				offsetBottom={
					open ? Math.max(height + GAP_ABOVE_PANEL, tourClearance) : tourClearance || undefined
				}
			/>
			{open ? (
				<DockPanel
					title="devtools"
					height={height}
					onHeightChange={setHeight}
					onClose={close}
					rail={rail}
					activeId={group}
					onPick={(id) => setGroup(id as DevScenarioGroup)}
					header={
						<ActiveStrip
							active={active}
							busy={reset.isPending}
							onResetOne={(id) => reset.mutate(id)}
							onResetAll={() => reset.mutate(undefined)}
						/>
					}
				>
					{shown.length === 0 ? (
						<EmptyNote>这一组还没有场景 —— 后面几片按序补。</EmptyNote>
					) : (
						<div className="grid gap-3 pt-1 xl:grid-cols-2">
							{shown.map((entry) => (
								<ScenarioCard
									key={entry.decl.id}
									entry={entry}
									injection={activeById.get(entry.decl.id)}
									running={runningId === entry.decl.id}
									result={results[entry.decl.id]}
									onRun={(params) => launch(entry, params)}
								/>
							))}
						</div>
					)}
					{/* 截流组多一张列表:拦下了什么。场景卡照常由注册表画,列表是这一组独有的对照面。 */}
					{group === "capture" ? <CaptureView /> : null}
				</DockPanel>
			) : null}
		</>
	);
}

// ── 「当前生效」条 ───────────────────────────────────────────────────────────

function ActiveStrip({
	active,
	busy,
	onResetOne,
	onResetAll,
}: {
	active: DevInjection[];
	busy: boolean;
	onResetOne: (id: string) => void;
	onResetAll: () => void;
}) {
	if (active.length === 0) {
		return <p className="text-bn-xs text-bn-text-tertiary">没有注入生效 —— 现在看到的都是真的。</p>;
	}
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="mr-1 text-bn-xs font-bold text-bn-text-secondary">当前生效</span>
			{active.map((a) => (
				<span
					key={a.scenarioId}
					className={`flex items-center gap-0.5 rounded-bn-pill py-0.5 pr-0.5 pl-2.5 text-bn-xs font-semibold text-bn-pink ${SELECTED_TINT_BG}`}
				>
					{a.label}
					<IconButton
						icon={<Icon.close size={11} />}
						label={`收掉:${a.label}`}
						title="收掉这一条"
						size="sm"
						shape="pill"
						tone="accent"
						disabled={busy}
						onClick={() => onResetOne(a.scenarioId)}
					/>
				</span>
			))}
			<Btn variant="ghost" size="sm" disabled={busy} onClick={onResetAll}>
				全部收摊
			</Btn>
		</div>
	);
}

// ── 一张场景卡 ──────────────────────────────────────────────────────────────

function defaultsOf(fields: DevParamField[]): DevParamValues {
	const out: DevParamValues = {};
	for (const f of fields) {
		if (f.kind === "enum" || f.kind === "number") out[f.key] = f.default;
		else if (f.kind === "text") out[f.key] = f.default ?? "";
		else out[f.key] = "";
	}
	return out;
}

/** 交给服务端前把「留空」去掉 —— 留空的意思是「用你的默认值」,不是「空串」。 */
function stripBlank(fields: DevParamField[], values: DevParamValues): DevParamValues {
	const out: DevParamValues = {};
	for (const f of fields) {
		const v = values[f.key];
		if (v === undefined) continue;
		if ((f.kind === "sub" || f.kind === "target" || f.kind === "adapter") && v === "") continue;
		out[f.key] = v;
	}
	return out;
}

function ScenarioCard({
	entry,
	injection,
	running,
	result,
	onRun,
}: {
	entry: DevEntry;
	injection: DevInjection | undefined;
	running: boolean;
	result: RunResult | undefined;
	onRun: (params: DevParamValues) => void;
}) {
	const { decl } = entry;
	const [values, setValues] = useState<DevParamValues>(() => defaultsOf(decl.params));
	const set = (key: string, v: string | number) => setValues((prev) => ({ ...prev, [key]: v }));

	return (
		<div className="rounded-bn-card border border-bn-border bg-bn-surface/70 p-3.5">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="text-bn-base font-bold text-bn-text-primary">{decl.title}</span>
						{injection ? (
							<Pill subtle size="sm">
								生效中
							</Pill>
						) : null}
						{entry.side === "web" ? (
							<Pill subtle size="sm" color="var(--color-bn-blue)">
								浏览器里跑
							</Pill>
						) : null}
					</div>
					{decl.desc ? (
						<p className="mt-1 text-bn-xs leading-relaxed text-bn-text-tertiary">{decl.desc}</p>
					) : null}
				</div>
				<Btn
					variant="primary"
					size="sm"
					disabled={running}
					onClick={() => onRun(stripBlank(decl.params, values))}
				>
					{running ? "跑着…" : "跑一下"}
				</Btn>
			</div>
			{decl.params.length > 0 ? (
				<div className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
					{decl.params.map((f) => (
						<ParamControl
							key={f.key}
							field={f}
							value={values[f.key]}
							onChange={(v) => set(f.key, v)}
						/>
					))}
				</div>
			) : null}
			{result?.ok && result.summary ? (
				<HintNote tone="success" className="mt-3">
					{result.summary}
				</HintNote>
			) : null}
			{result && !result.ok ? (
				<ErrorNote size="sm" className="mt-3">
					{result.err}
				</ErrorNote>
			) : null}
		</div>
	);
}

/**
 * 一个字段一个控件。外层是 `div` + `span` 标题而不是 `<label>` 包裹:T 系列控件自己收
 * `ariaLabel`,名字落在控件本身上;包一层 label 反而会让 Biome 认不出里面有输入。
 */
function ParamControl({
	field,
	value,
	onChange,
}: {
	field: DevParamField;
	value: string | number | undefined;
	onChange: (v: string | number) => void;
}) {
	let control: ReactNode;
	switch (field.kind) {
		case "enum":
			control = (
				<TSelect
					ariaLabel={field.label}
					value={String(value ?? field.default)}
					options={field.options.map((o) => ({ value: o.value, label: o.label }))}
					onChange={onChange}
				/>
			);
			break;
		case "number":
			control = (
				<TNum
					ariaLabel={field.label}
					value={typeof value === "number" ? value : field.default}
					min={field.min}
					max={field.max}
					onChange={onChange}
				/>
			);
			break;
		case "text":
			control = (
				<TInput
					ariaLabel={field.label}
					value={String(value ?? "")}
					placeholder={field.placeholder}
					onChange={onChange}
				/>
			);
			break;
		case "sub":
		case "target":
		case "adapter":
			control = (
				<PickSelect
					kind={field.kind}
					label={field.label}
					value={String(value ?? "")}
					onChange={onChange}
				/>
			);
			break;
	}
	return (
		<div className="flex flex-col gap-1">
			<span className="text-bn-xs font-semibold text-bn-text-secondary">{field.label}</span>
			{control}
		</div>
	);
}
