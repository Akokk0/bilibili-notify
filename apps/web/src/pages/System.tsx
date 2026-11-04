import type {
	ConnectionCapabilitiesMap,
	IntegrationSettingsDescriptorsResponse,
	SettingsResponse,
} from "@bilibili-notify/contract";
import { ErrorNote, Icon, LoadingBlock, SectionNav } from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { InvalidSettingsPanel } from "../components/invalid-settings-note";
import { UPDATE_SECTION_HASH } from "../components/update/status";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { INVALID_SETTINGS_QUERY_PREFIX } from "../hooks/useInvalidSettings";
import { patchSettings, SETTINGS_KEY, useSettings } from "../hooks/useSettings";
import { i18n, useT, useTextOptions } from "../i18n";
import { api } from "../services/api";
import type { Connection, PushTarget } from "../types/domain";
import type { GlobalConfigPatch, SettingsPatch } from "../types/globals";
import { SkinSection } from "./skins/SkinSection";
import { AccountSection } from "./system/account-section";
import { CredentialsSection } from "./system/credentials-section";
import { IntegrationSection, integrationDraftIssue } from "./system/integration-section";
import { MaintenanceSection } from "./system/maintenance-section";
import { MessagingSection } from "./system/messaging-section";
import { PreferencesSection } from "./system/preferences-section";
import { RuntimeSection } from "./system/runtime-section";
import { StorageSection } from "./system/storage-section";
import { buildSystemPatch } from "./system-save-patch";

/**
 * 系统页的通用分区与集成分区 —— 按「用户什么时候会来找它」分,不按代码结构分。
 *
 * 十节挤在一页太长(主人 2026-09-12 提的),走 `SectionNav`:xl+ 左竖栏、窄视口
 * 顶部 chip 条,与 Rules / Targets / Ai / Cards 同一件组件。
 */
const SYSTEM_SECTIONS = [
	{
		id: "account",
		get label() {
			return i18n.t("panelUi.pages.System.1");
		},
		get desc() {
			return i18n.t("panelUi.pages.System.2");
		},
		glyph: Icon.user,
	},
	{
		id: "runtime",
		get label() {
			return i18n.t("panelUi.pages.System.3");
		},
		get desc() {
			return i18n.t("panelUi.pages.System.4");
		},
		glyph: Icon.sliders,
	},
	{
		id: "messaging",
		get label() {
			return i18n.t("panelUi.pages.System.5");
		},
		get desc() {
			return i18n.t("panelUi.pages.System.6");
		},
		glyph: Icon.chat,
	},
	{
		id: "appearance",
		get label() {
			return i18n.t("panelUi.pages.System.7");
		},
		get desc() {
			return i18n.t("panelUi.pages.System.8");
		},
		glyph: Icon.palette,
	},
	{
		id: "storage",
		get label() {
			return i18n.t("storageUsage.nav");
		},
		get desc() {
			return i18n.t("storageUsage.navHint");
		},
		glyph: Icon.list,
	},
	{
		id: "maintenance",
		get label() {
			return i18n.t("panelUi.pages.System.9");
		},
		get desc() {
			return i18n.t("panelUi.pages.System.10");
		},
		glyph: Icon.wrench,
	},
] as const;

type SystemSectionId = (typeof SYSTEM_SECTIONS)[number]["id"] | `integration:${string}`;

/**
 * 页外深链落在哪一格。
 *
 * `/system#update` 有三个来路(概览卡的 `Link` + 两个 toast 的「去更新」)。分格
 * 之后光滚是不够的 —— 不先选中那一格,更新那节根本不在 DOM 里,`scrollIntoView`
 * 滚个空。这张表就是那条接线,`System.rail.test.tsx` 钉着。
 */
const HASH_SECTION: Readonly<Record<string, SystemSectionId>> = {
	[UPDATE_SECTION_HASH]: "maintenance",
	"#storage": "storage",
};

/**
 * 草稿层的合并。与线格式同一套语义:**`null` = 删除该键**,缺席 = 不改。
 *
 * 草稿层也必须认 null,否则「关掉一个可选覆盖」在这里就先失败了 —— 从前的写法是
 * 「拷一份、删掉那个键、整份回传」,而整份回传走的是合并,被删的键当场被合回来
 * (同时有两个以上模块覆盖时尤其明显:只剩一个时删空成 undefined 反而歪打正着)。
 */
function deepMerge<T>(base: T, patch: GlobalConfigPatch | SettingsPatch): T {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const k of Object.keys(patch)) {
		const pv = (patch as Record<string, unknown>)[k];
		if (pv === null) {
			delete out[k];
			continue;
		}
		const bv = out[k];
		if (
			pv != null &&
			typeof pv === "object" &&
			!Array.isArray(pv) &&
			bv != null &&
			typeof bv === "object" &&
			!Array.isArray(bv)
		) {
			out[k] = deepMerge(bv, pv as GlobalConfigPatch);
		} else {
			out[k] = pv;
		}
	}
	return out as T;
}

export default function System() {
	const t = useT();
	const qc = useQueryClient();

	const location = useLocation();
	const [section, setSection] = useState<SystemSectionId>(
		() => HASH_SECTION[location.hash] ?? "account",
	);
	// 带 hash 进来时先落到对应那一格。`location.key` 一起听:已经停在系统页的人
	// 再点一次「去更新」,hash 没变但那是一次新的导航,也该回到维护格 —— 同
	// update-section 里那条滚动 effect 的理由。
	// biome-ignore lint/correctness/useExhaustiveDependencies: location.key 是刻意的重触发条件
	useEffect(() => {
		const wanted = HASH_SECTION[location.hash];
		if (wanted) setSection(wanted);
	}, [location.hash, location.key]);

	const globalsQuery = useSettings();
	const { locale, voice } = useTextOptions();
	const descriptorsQuery = useQuery({
		queryKey: ["integration-settings-descriptors", locale, voice],
		queryFn: () => api.get<IntegrationSettingsDescriptorsResponse>("/api/settings/integrations"),
	});
	const descriptors = descriptorsQuery.data?.integrations ?? [];
	const selectedIntegration = descriptors.find((entry) => `integration:${entry.key}` === section);
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	// 能力由宿主每分钟补探一轮,面板开着的时候半分钟刷一次,bot 后连上也能看到它变绿。
	const capabilitiesQuery = useQuery({
		queryKey: ["connection-capabilities"],
		queryFn: () => api.get<ConnectionCapabilitiesMap>("/api/connections/capabilities"),
		refetchInterval: 30_000,
	});

	// 草稿是整份设置(核心那份在 `core` 下、B 站的挂在 `bilibili` 下),字段码也按这个形状写(`core.logging.level`)。
	const [draft, setDraft] = useState<SettingsResponse | null>(null);

	useEffect(() => {
		if (globalsQuery.data) setDraft(globalsQuery.data);
	}, [globalsQuery.data]);

	function patchDraft(delta: SettingsPatch): void {
		setDraft((d) => (d ? deepMerge(d, delta) : d));
	}
	/** 只改核心那份的几张卡(主人目标、指令、链接解析)用它:它们认的是核心那份的形状。 */
	function patchCoreDraft(delta: GlobalConfigPatch): void {
		patchDraft({ core: delta });
	}

	const save = useMutation({
		mutationFn: async (next: SettingsResponse) => {
			// 改了哪块发哪块(挑块的规则与理由在 system-save-patch.ts)。草稿是从这份基线长出来
			// 的,没有基线就不会有草稿;真走到这里是状态坏了,宁可报错也别静默发一份空补丁。
			const base = globalsQuery.data;
			if (!base) throw new Error(t("panelUi.pages.System.11"));
			const issue = integrationDraftIssue(descriptors, next, base);
			if (issue) throw new Error(issue);
			await patchSettings(buildSystemPatch(next, base));
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
			await qc.invalidateQueries({ queryKey: INVALID_SETTINGS_QUERY_PREFIX });
		},
	});

	useDirtyDraft<SettingsResponse>({
		pageKey: "system",
		pageLabel: t("panelUi.pages.System.12"),
		draft,
		baseline: globalsQuery.data ?? null,
		onSave: async () => {
			if (draft !== null) await save.mutateAsync(draft);
		},
		onDiscard: () => {
			if (globalsQuery.data) setDraft(globalsQuery.data);
		},
	});

	return (
		// 两栏骨架一律走 `xl:grid-bn-rail`,别手写栏宽 —— 栏宽在 --bn-rail-width,皮肤能调。
		<div className="bn-anim-page-in grid grid-cols-1 gap-4 xl:grid-bn-rail">
			<SectionNav
				heading={t("panelUi.pages.System.13")}
				items={[
					...SYSTEM_SECTIONS.slice(0, 2).map(({ id, label, desc, glyph: Glyph }) => ({
						id,
						label,
						desc,
						icon: <Glyph size={14} />,
					})),
					...descriptors.map((entry) => ({
						id: `integration:${entry.key}`,
						label: entry.label,
						desc: t("integrationSettings.navHint"),
						icon: entry.icon ? (
							<img src={entry.icon} alt="" className="size-3.5" />
						) : (
							<Icon.sliders size={14} />
						),
					})),
					...SYSTEM_SECTIONS.slice(2).map(({ id, label, desc, glyph: Glyph }) => ({
						id,
						label,
						desc: id === "appearance" ? t("preferences.navHint") : desc,
						icon: <Glyph size={14} />,
					})),
				]}
				activeId={section}
				onPick={(id) => setSection(id as SystemSectionId)}
			/>

			<div className="min-w-0 space-y-5">
				<InvalidSettingsPanel path="/api/settings/invalid" />
				{/* 配置读不下来是整页的事,不是某一格的事 —— 摆在格子外头,停在哪一格都看得见。 */}
				{descriptorsQuery.error ? (
					<ErrorNote>{String(descriptorsQuery.error.message)}</ErrorNote>
				) : null}
				{globalsQuery.error ? (
					<ErrorNote>
						{t("panelUi.pages.System.14")}
						{String((globalsQuery.error as Error).message)}
					</ErrorNote>
				) : !draft && globalsQuery.isLoading ? (
					<LoadingBlock label={t("panelUi.pages.System.15")} />
				) : null}

				{section === "account" ? <CredentialsSection /> : null}
				<AccountSection
					active={section === "account"}
					draft={draft}
					targets={targetsQuery.data ?? []}
					connections={connectionsQuery.data ?? []}
					onPatch={patchCoreDraft}
				/>
				{selectedIntegration && draft ? (
					<IntegrationSection
						key={selectedIntegration.key}
						descriptor={selectedIntegration}
						draft={draft}
						onPatch={patchDraft}
					/>
				) : null}
				{section === "runtime" ? <RuntimeSection draft={draft} onPatch={patchDraft} /> : null}
				{section === "messaging" ? (
					<MessagingSection
						draft={draft}
						onPatch={patchCoreDraft}
						targets={targetsQuery.data ?? []}
						connections={connectionsQuery.data ?? []}
						capabilities={capabilitiesQuery.data ?? {}}
					/>
				) : null}
				{section === "appearance" ? (
					<>
						{draft ? <PreferencesSection draft={draft.core} onPatch={patchCoreDraft} /> : null}
						<SkinSection />
					</>
				) : null}
				{section === "maintenance" ? <MaintenanceSection /> : null}
				{section === "storage" ? <StorageSection draft={draft} onPatch={patchDraft} /> : null}
			</div>
		</div>
	);
}
