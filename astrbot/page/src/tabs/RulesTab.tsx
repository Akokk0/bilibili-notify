import { useEffect, useMemo, useState } from "react";
import { dashboardApi } from "../api/client";
import type { DashboardBootstrap, PersonaOption, SubscriptionOverrides } from "../api/types";
import { FEATURE_KEYS, FEATURE_LABELS } from "../api/types";
import {
	Badge,
	Button,
	Card,
	ConfirmButton,
	EmptyState,
	ErrorBanner,
	Field,
	Input,
	SectionGrid,
	Select,
	TextArea,
	Toggle,
	useConfirm,
} from "../components/ui";
import {
	cleanOverrides,
	cloneConfig,
	isDirty,
	linesToList,
	listToLines,
	subscriptionTitle,
} from "../lib/config";

interface RulesTabProps {
	readonly data: DashboardBootstrap;
	readonly onData: (data: DashboardBootstrap) => void;
	readonly onDirty: (dirty: boolean) => void;
}

type OverrideSection = keyof SubscriptionOverrides;

type TriState = "inherit" | "on" | "off";

export function RulesTab({ data, onData, onDirty }: RulesTabProps) {
	const requestConfirmation = useConfirm();
	const [selectedId, setSelectedId] = useState(data.subscriptions[0]?.id ?? "");
	const selected = useMemo(
		() => data.subscriptions.find((sub) => sub.id === selectedId) ?? data.subscriptions[0],
		[data.subscriptions, selectedId],
	);
	const [draft, setDraft] = useState<SubscriptionOverrides>(() =>
		cloneConfig(selected?.overrides ?? {}),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<unknown>(null);
	// AstrBot 人格列表(来自 Python 本地端点),供 per-UP 人格下拉;取失败则留空、仅能继承全局。
	const [personas, setPersonas] = useState<PersonaOption[]>([]);

	useEffect(() => {
		let alive = true;
		dashboardApi.listPersonas().then(
			(list) => {
				if (alive) setPersonas(list);
			},
			() => {
				// 取人格失败(sidecar/AstrBot 未就绪等):降级为只可继承全局,不打断规则编辑。
			},
		);
		return () => {
			alive = false;
		};
	}, []);

	useEffect(() => {
		const fallback = data.subscriptions[0];
		if (!selected && fallback) {
			setSelectedId(fallback.id);
			setDraft(cloneConfig(fallback.overrides));
		}
	}, [data.subscriptions, selected]);

	const dirty = Boolean(selected) && isDirty(selected?.overrides ?? {}, draft);
	useEffect(() => onDirty(dirty), [dirty, onDirty]);

	const updateDraft = (mutator: (next: SubscriptionOverrides) => void) => {
		setDraft((current) => {
			const next = cloneConfig(current);
			mutator(next);
			return next;
		});
	};

	const setSection = (section: OverrideSection, enabled: boolean) => {
		updateDraft((next) => {
			if (!enabled) {
				delete next[section];
				return;
			}
			if (next[section]) return;
			if (section === "features") next.features = {};
			else if (section === "filters") next.filters = {};
			else if (section === "schedule") next.schedule = {};
			else if (section === "templates") next.templates = {};
			else if (section === "ai") next.ai = { preset: "inherit" };
			else if (section === "cardStyle") next.cardStyle = {};
			else if (section === "imageGroup") next.imageGroup = {};
		});
	};

	const selectSubscription = async (id: string) => {
		if (id === selectedId) return;
		if (dirty) {
			const canSwitch = await requestConfirmation({
				message: "当前 UP 有未保存高级规则草稿。确定切换吗？",
			});
			if (!canSwitch) return;
		}
		const nextSelected = data.subscriptions.find((sub) => sub.id === id);
		setSelectedId(id);
		setDraft(cloneConfig(nextSelected?.overrides ?? {}));
	};

	const save = async () => {
		if (!selected) return;
		setSaving(true);
		setError(null);
		try {
			const overrides = cleanOverrides(draft);
			const nextSub = await dashboardApi.patchSubscription(selected.id, { overrides });
			onData({
				...data,
				subscriptions: data.subscriptions.map((sub) => (sub.id === nextSub.id ? nextSub : sub)),
			});
			setDraft(cloneConfig(nextSub.overrides));
		} catch (err) {
			setError(err);
		} finally {
			setSaving(false);
		}
	};

	const clearSelected = async () => {
		if (!selected) return;
		setSaving(true);
		setError(null);
		try {
			const nextSub = await dashboardApi.patchSubscription(selected.id, { overrides: {} });
			onData({
				...data,
				subscriptions: data.subscriptions.map((sub) => (sub.id === nextSub.id ? nextSub : sub)),
			});
			setDraft({});
		} catch (err) {
			setError(err);
		} finally {
			setSaving(false);
		}
	};

	if (data.subscriptions.length === 0) {
		return (
			<Card title="高级规则">
				<EmptyState>还没有订阅。先到「订阅」Tab 添加一个 UP。</EmptyState>
			</Card>
		);
	}

	return (
		<div className="grid gap-5">
			<ErrorBanner error={error} />
			<Card
				title="选择 UP"
				description="每个 section 都可继承全局默认；关闭 section 会删除该类 override。"
				action={
					<div className="flex flex-wrap gap-2">
						<Button
							onClick={() => setDraft(cloneConfig(selected?.overrides ?? {}))}
							disabled={!dirty || saving}
						>
							重置草稿
						</Button>
						<Button tone="primary" onClick={() => void save()} disabled={!dirty || saving}>
							{saving ? "保存中..." : "保存高级规则"}
						</Button>
						<ConfirmButton
							tone="danger"
							confirmText="确定清空当前 UP 的所有覆盖规则？"
							onConfirm={clearSelected}
							disabled={saving}
						>
							清空当前覆盖
						</ConfirmButton>
					</div>
				}
			>
				<div className="grid gap-3 md:grid-cols-[1fr_auto]">
					<Select
						value={selected?.id ?? ""}
						onChange={(event) => void selectSubscription(event.target.value)}
					>
						{data.subscriptions.map((sub) => (
							<option key={sub.id} value={sub.id}>
								{subscriptionTitle(sub)}
							</option>
						))}
					</Select>
					<div className="flex items-center gap-2">
						<Badge tone={dirty ? "warn" : "success"}>{dirty ? "有草稿" : "已同步"}</Badge>
						{selected ? (
							<Badge>{Object.keys(selected.overrides).length} 个覆盖 section</Badge>
						) : null}
					</div>
				</div>
			</Card>

			{selected ? (
				<>
					<FeatureOverrides
						draft={draft}
						globals={data.globals}
						setSection={setSection}
						updateDraft={updateDraft}
					/>
					<TemplateOverrides
						draft={draft}
						globals={data.globals}
						setSection={setSection}
						updateDraft={updateDraft}
					/>
					<FilterOverrides
						draft={draft}
						globals={data.globals}
						setSection={setSection}
						updateDraft={updateDraft}
					/>
					<ScheduleOverrides
						draft={draft}
						globals={data.globals}
						setSection={setSection}
						updateDraft={updateDraft}
					/>
					<AiOverrides
						draft={draft}
						globals={data.globals}
						setSection={setSection}
						updateDraft={updateDraft}
						personas={personas}
					/>
					<CardVisualOverrides
						draft={draft}
						globals={data.globals}
						setSection={setSection}
						updateDraft={updateDraft}
					/>
				</>
			) : null}
		</div>
	);
}

function FeatureOverrides({ draft, globals, setSection, updateDraft }: SectionProps) {
	return (
		<Card
			title="功能开关覆盖"
			action={
				<Toggle
					label="自定义"
					checked={Boolean(draft.features)}
					onChange={(checked) => setSection("features", checked)}
				/>
			}
		>
			{draft.features ? (
				<div className="grid gap-3 md:grid-cols-3">
					{FEATURE_KEYS.map((feature) => (
						<TriStateSelect
							key={feature}
							label={FEATURE_LABELS[feature]}
							globalValue={globals.defaults.features[feature]}
							value={toTriState(draft.features?.[feature])}
							onChange={(value) =>
								updateDraft((next) => {
									next.features ??= {};
									if (value === "inherit") delete next.features[feature];
									else next.features[feature] = value === "on";
								})
							}
						/>
					))}
				</div>
			) : (
				<InheritedHint />
			)}
		</Card>
	);
}

function TemplateOverrides({ draft, globals, setSection, updateDraft }: SectionProps) {
	return (
		<Card
			title="通知模板覆盖"
			action={
				<Toggle
					label="自定义"
					checked={Boolean(draft.templates)}
					onChange={(checked) => setSection("templates", checked)}
				/>
			}
		>
			{draft.templates ? (
				<SectionGrid>
					<OverrideText
						label="动态模板"
						value={draft.templates.dynamic}
						inherited={globals.defaults.templates.dynamic}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "dynamic", value);
							})
						}
					/>
					<OverrideText
						label="视频模板"
						value={draft.templates.dynamicVideo}
						inherited={globals.defaults.templates.dynamicVideo}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "dynamicVideo", value);
							})
						}
					/>
					<OverrideText
						label="开播模板"
						value={draft.templates.liveStart}
						inherited={globals.defaults.templates.liveStart}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "liveStart", value);
							})
						}
					/>
					<OverrideText
						label="直播中模板"
						value={draft.templates.liveOngoing}
						inherited={globals.defaults.templates.liveOngoing}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "liveOngoing", value);
							})
						}
					/>
					<OverrideText
						label="下播模板"
						value={draft.templates.liveEnd}
						inherited={globals.defaults.templates.liveEnd}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "liveEnd", value);
							})
						}
					/>
					<OverrideText
						label="弹幕总结模板"
						value={draft.templates.liveSummary}
						inherited={globals.defaults.templates.liveSummary}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "liveSummary", value);
							})
						}
					/>
					<OverrideText
						label="特别弹幕模板"
						value={draft.templates.specialDanmaku}
						inherited={globals.defaults.templates.specialDanmaku}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "specialDanmaku", value);
							})
						}
					/>
					<OverrideText
						label="特别进房模板"
						value={draft.templates.specialUserEnter}
						inherited={globals.defaults.templates.specialUserEnter}
						onChange={(value) =>
							updateDraft((next) => {
								next.templates ??= {};
								setOptional(next.templates, "specialUserEnter", value);
							})
						}
					/>
				</SectionGrid>
			) : (
				<InheritedHint />
			)}
		</Card>
	);
}

function FilterOverrides({ draft, globals, setSection, updateDraft }: SectionProps) {
	return (
		<Card
			title="过滤覆盖"
			action={
				<Toggle
					label="自定义"
					checked={Boolean(draft.filters)}
					onChange={(checked) => setSection("filters", checked)}
				/>
			}
		>
			{draft.filters ? (
				<SectionGrid>
					<OverrideText
						label="屏蔽关键词"
						value={listToLines(draft.filters.blockKeywords)}
						inherited={listToLines(globals.defaults.filters.blockKeywords)}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								next.filters.blockKeywords = linesToList(value ?? "");
							})
						}
					/>
					<OverrideText
						label="白名单关键词"
						value={listToLines(draft.filters.whitelistKeywords)}
						inherited={listToLines(globals.defaults.filters.whitelistKeywords)}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								next.filters.whitelistKeywords = linesToList(value ?? "");
							})
						}
					/>
					<OverrideText
						label="屏蔽正则"
						value={listToLines(draft.filters.blockRegex)}
						inherited={listToLines(globals.defaults.filters.blockRegex)}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								next.filters.blockRegex = linesToList(value ?? "");
							})
						}
					/>
					<OverrideText
						label="白名单正则"
						value={listToLines(draft.filters.whitelistRegex)}
						inherited={listToLines(globals.defaults.filters.whitelistRegex)}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								next.filters.whitelistRegex = linesToList(value ?? "");
							})
						}
					/>
					<NumberOverride
						label="最低 SC 价格"
						value={draft.filters.minScPrice}
						inherited={globals.defaults.filters.minScPrice}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								setOptional(next.filters, "minScPrice", value);
							})
						}
					/>
					<NumberOverride
						label="最低舰长等级"
						value={draft.filters.minGuardLevel}
						inherited={globals.defaults.filters.minGuardLevel}
						min={1}
						max={3}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								setOptional(next.filters, "minGuardLevel", value as 1 | 2 | 3 | undefined);
							})
						}
					/>
					<BooleanOverride
						label="过滤转发"
						value={draft.filters.blockForward}
						inherited={globals.defaults.filters.blockForward}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								setOptional(next.filters, "blockForward", value);
							})
						}
					/>
					<BooleanOverride
						label="过滤专栏"
						value={draft.filters.blockArticle}
						inherited={globals.defaults.filters.blockArticle}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								setOptional(next.filters, "blockArticle", value);
							})
						}
					/>
					<BooleanOverride
						label="过滤抽奖"
						value={draft.filters.blockDraw}
						inherited={globals.defaults.filters.blockDraw}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								setOptional(next.filters, "blockDraw", value);
							})
						}
					/>
					<BooleanOverride
						label="过滤 AV 号"
						value={draft.filters.blockAv}
						inherited={globals.defaults.filters.blockAv}
						onChange={(value) =>
							updateDraft((next) => {
								next.filters ??= {};
								setOptional(next.filters, "blockAv", value);
							})
						}
					/>
				</SectionGrid>
			) : (
				<InheritedHint />
			)}
		</Card>
	);
}

function ScheduleOverrides({ draft, globals, setSection, updateDraft }: SectionProps) {
	return (
		<Card
			title="推送计划覆盖"
			action={
				<Toggle
					label="自定义"
					checked={Boolean(draft.schedule)}
					onChange={(checked) => setSection("schedule", checked)}
				/>
			}
		>
			{draft.schedule ? (
				<SectionGrid>
					<NumberOverride
						label="复推间隔（小时）"
						value={draft.schedule.pushTime}
						inherited={globals.defaults.schedule.pushTime}
						min={0}
						max={24}
						onChange={(value) =>
							updateDraft((next) => {
								next.schedule ??= {};
								setOptional(next.schedule, "pushTime", value);
							})
						}
					/>
					<BooleanOverride
						label="重启后补推"
						value={draft.schedule.restartPush}
						inherited={globals.defaults.schedule.restartPush}
						onChange={(value) =>
							updateDraft((next) => {
								next.schedule ??= {};
								setOptional(next.schedule, "restartPush", value);
							})
						}
					/>
				</SectionGrid>
			) : (
				<InheritedHint />
			)}
		</Card>
	);
}

function AiOverrides({
	draft,
	setSection,
	updateDraft,
	personas,
}: SectionProps & { readonly personas: PersonaOption[] }) {
	const currentPersonaId = draft.ai?.personaId ?? "";
	// 已选人格不在当前列表(人格被改名/列表未加载)时,仍保留它作为一个选项,避免静默丢失选择。
	const missingPersona = currentPersonaId && !personas.some((p) => p.id === currentPersonaId);
	return (
		<Card
			title="AI 覆盖"
			description="人格由 AstrBot 提供；这里可为该 UP 主单独指定一个 AstrBot 人格，留空则继承全局默认人格。"
			action={
				<Toggle
					label="自定义"
					checked={Boolean(draft.ai)}
					onChange={(checked) => setSection("ai", checked)}
				/>
			}
		>
			{draft.ai ? (
				<SectionGrid>
					<Field label="AstrBot 人格" hint="留空＝继承全局默认人格">
						<Select
							value={currentPersonaId}
							onChange={(event) =>
								updateDraft((next) => {
									next.ai ??= { preset: "inherit" };
									const value = event.target.value;
									if (value) {
										next.ai.personaId = value;
									} else {
										delete next.ai.personaId;
									}
								})
							}
						>
							<option value="">继承全局默认人格</option>
							{personas.map((persona) => (
								<option key={persona.id} value={persona.id}>
									{persona.label}
								</option>
							))}
							{missingPersona ? (
								<option value={currentPersonaId}>{currentPersonaId}（当前选择）</option>
							) : null}
						</Select>
					</Field>
				</SectionGrid>
			) : (
				<InheritedHint />
			)}
		</Card>
	);
}

function CardVisualOverrides({ draft, globals, setSection, updateDraft }: SectionProps) {
	return (
		<Card
			title="卡片 / 图集覆盖"
			action={
				<div className="flex gap-2">
					<Toggle
						label="卡片"
						checked={Boolean(draft.cardStyle)}
						onChange={(checked) => setSection("cardStyle", checked)}
					/>
					<Toggle
						label="图集"
						checked={Boolean(draft.imageGroup)}
						onChange={(checked) => setSection("imageGroup", checked)}
					/>
				</div>
			}
		>
			<SectionGrid>
				{draft.cardStyle ? (
					<>
						<BooleanOverride
							label="图片卡片"
							value={draft.cardStyle.enabled}
							inherited={globals.defaults.cardStyle.enabled}
							onChange={(value) =>
								updateDraft((next) => {
									next.cardStyle ??= {};
									setOptional(next.cardStyle, "enabled", value);
								})
							}
						/>
						<OverrideText
							label="起始色"
							value={draft.cardStyle.cardColorStart}
							inherited={globals.defaults.cardStyle.cardColorStart}
							onChange={(value) =>
								updateDraft((next) => {
									next.cardStyle ??= {};
									setOptional(next.cardStyle, "cardColorStart", value);
								})
							}
						/>
						<OverrideText
							label="结束色"
							value={draft.cardStyle.cardColorEnd}
							inherited={globals.defaults.cardStyle.cardColorEnd}
							onChange={(value) =>
								updateDraft((next) => {
									next.cardStyle ??= {};
									setOptional(next.cardStyle, "cardColorEnd", value);
								})
							}
						/>
						<OverrideText
							label="字体"
							value={draft.cardStyle.font}
							inherited={globals.defaults.cardStyle.font}
							onChange={(value) =>
								updateDraft((next) => {
									next.cardStyle ??= {};
									setOptional(next.cardStyle, "font", value);
								})
							}
						/>
						<BooleanOverride
							label="隐藏简介"
							value={draft.cardStyle.hideDesc}
							inherited={globals.defaults.cardStyle.hideDesc}
							onChange={(value) =>
								updateDraft((next) => {
									next.cardStyle ??= {};
									setOptional(next.cardStyle, "hideDesc", value);
								})
							}
						/>
						<BooleanOverride
							label="隐藏粉丝/观看"
							value={draft.cardStyle.hideFollower}
							inherited={globals.defaults.cardStyle.hideFollower}
							onChange={(value) =>
								updateDraft((next) => {
									next.cardStyle ??= {};
									setOptional(next.cardStyle, "hideFollower", value);
								})
							}
						/>
					</>
				) : (
					<InheritedHint />
				)}
				{draft.imageGroup ? (
					<>
						<BooleanOverride
							label="附加图集原图"
							value={draft.imageGroup.enable}
							inherited={globals.defaults.imageGroup.enable}
							onChange={(value) =>
								updateDraft((next) => {
									next.imageGroup ??= {};
									setOptional(next.imageGroup, "enable", value);
								})
							}
						/>
						<BooleanOverride
							label="合并转发"
							value={draft.imageGroup.forward}
							inherited={globals.defaults.imageGroup.forward}
							onChange={(value) =>
								updateDraft((next) => {
									next.imageGroup ??= {};
									setOptional(next.imageGroup, "forward", value);
								})
							}
						/>
					</>
				) : null}
			</SectionGrid>
		</Card>
	);
}

interface SectionProps {
	readonly draft: SubscriptionOverrides;
	readonly globals: DashboardBootstrap["globals"];
	readonly setSection: (section: OverrideSection, enabled: boolean) => void;
	readonly updateDraft: (mutator: (next: SubscriptionOverrides) => void) => void;
}

function TriStateSelect({
	label,
	value,
	globalValue,
	onChange,
}: {
	readonly label: string;
	readonly value: TriState;
	readonly globalValue: boolean;
	readonly onChange: (value: TriState) => void;
}) {
	return (
		<Field label={label} hint={`全局默认：${globalValue ? "启用" : "关闭"}`}>
			<Select value={value} onChange={(event) => onChange(event.target.value as TriState)}>
				<option value="inherit">继承</option>
				<option value="on">启用</option>
				<option value="off">关闭</option>
			</Select>
		</Field>
	);
}

function BooleanOverride({
	label,
	value,
	inherited,
	onChange,
}: {
	readonly label: string;
	readonly value: boolean | undefined;
	readonly inherited: boolean;
	readonly onChange: (value: boolean | undefined) => void;
}) {
	return (
		<TriStateSelect
			label={label}
			value={toTriState(value)}
			globalValue={inherited}
			onChange={(next) => onChange(next === "inherit" ? undefined : next === "on")}
		/>
	);
}

function NumberOverride({
	label,
	value,
	inherited,
	onChange,
	min,
	max,
	step = 1,
}: {
	readonly label: string;
	readonly value: number | undefined;
	readonly inherited: number;
	readonly onChange: (value: number | undefined) => void;
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
}) {
	return (
		<Field label={label} hint={`留空继承全局：${inherited}`}>
			<Input
				type="number"
				min={min}
				max={max}
				step={step}
				value={value ?? ""}
				placeholder={String(inherited)}
				onChange={(event) =>
					onChange(event.target.value === "" ? undefined : Number(event.target.value))
				}
			/>
		</Field>
	);
}

function OverrideText({
	label,
	value,
	inherited,
	onChange,
}: {
	readonly label: string;
	readonly value: string | undefined;
	readonly inherited: string;
	readonly onChange: (value: string | undefined) => void;
}) {
	return (
		<Field label={label} hint="留空继承全局。">
			<TextArea
				value={value ?? ""}
				placeholder={inherited}
				onChange={(event) => onChange(event.target.value || undefined)}
			/>
		</Field>
	);
}

function InheritedHint() {
	return (
		<div className="rounded-2xl bg-white/60 p-4 text-bn-text-secondary text-sm">
			当前 section 继承全局默认。
		</div>
	);
}

function toTriState(value: boolean | undefined): TriState {
	if (value === undefined) return "inherit";
	return value ? "on" : "off";
}

function setOptional<T extends Record<string, unknown>, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | undefined,
): void {
	if (value === undefined || value === "") delete target[key];
	else target[key] = value;
}
