import type { BackupExportPreviewResponse, ImportResult } from "@bilibili-notify/contract";
import type {
	Connection,
	GlobalConfig,
	Json,
	PushTarget,
	Subscription,
	SubscriptionTag,
} from "@bilibili-notify/internal";
import { findNewIdentityDuplicates } from "@bilibili-notify/subscription";
import { describeDuplicate } from "../config/store.js";
import { t } from "../i18n/index.js";
import type { IntegrationStore } from "../integration-store/store.js";
import type { SecretCellsReader } from "../push/connection-settings.js";
import { assembleFullBackup, openFullBackup } from "./assemble.js";
import {
	type BackupEnvelope,
	type BackupKind,
	type BackupSections,
	buildBackup,
} from "./envelope.js";
import { BACKUP_PIN_REQUIRED_MESSAGE, BackupRejectedError } from "./rejected-error.js";
import { foldPlan, type ImportMode, planImport } from "./restore.js";
import { redactBackupSections } from "./sanitize.js";

/**
 * BackupService — the IO seam wiring the pure backup core to the running
 * server.
 *
 * Export reads the four config scopes (and, for a full backup, every
 * integration's secrets bag) and assembles an envelope. Import runs the pure {@link planImport},
 * folds it into the end state with {@link foldPlan} and hands that to
 * `replaceSections` in **one** call — restore is a wholesale state replacement,
 * not a sequence of user edits, and pretending otherwise cost us both a guard
 * meant for humans (webhook targets cannot be hand-created) and any chance of
 * rolling back a half-applied import. Integration secrets are swapped back
 * bag by bag afterwards (never throwing: a failed one only lands in
 * `unrestoredIntegrations`); the store runs whatever the integration registered
 * to pick the new values up live, so no process restart is needed.
 */

/** The slice of `ConfigStore` the backup service depends on. */
export interface BackupStore {
	getInvalidSettingsPaths(): string[][];
	getGlobals(): GlobalConfig;
	getAllIntegrationSettings(): Record<string, unknown>;
	getAllExtensionSettings(): Record<string, unknown>;
	getSubscriptions(): Subscription[];
	getSubscriptionTags(): SubscriptionTag[];
	getConnections(): Connection[];
	getTargets(): PushTarget[];
	replaceSections(next: {
		globals?: GlobalConfig;
		integrations?: Record<string, unknown>;
		extensionSettings?: Record<string, unknown>;
		subscriptions?: Subscription[];
		subscriptionTags?: SubscriptionTag[];
		connections?: Connection[];
		targets?: PushTarget[];
	}): Promise<unknown>;
}

/** 集成的密钥存储宿主里备份用得到的三样。 */
export type BackupIntegrationSecrets = Pick<
	IntegrationStore,
	"exportSecrets" | "restoreSecrets" | "isOpen"
>;

/** 备份里有、但这个集成现在没开着(没在运行)时回执里的话。 */
const notRunningMessage = () => t("backup.integrationNotRunning");

/** Which scopes to include in an export (the sanitized-档 checkboxes). */
export interface SectionSelection {
	/** 设置:核心那份连同各集成的(B 站……)与各拓展的。 */
	globals?: boolean;
	/** 订阅:只有一节,B 站与拓展来源的同在里面(ADR-0021 决策 15)。 */
	subscriptions?: boolean;
	connections?: boolean;
	targets?: boolean;
}

export interface BackupServiceDeps {
	configStore: BackupStore;
	/**
	 * 各集成的 `secrets`(B 站登录、内置适配器与拓展存的凭据):完整档导出带走、恢复时整袋换回。
	 * 内存跟上由存储那一头登记的「密钥被换了」回调负责,备份服务不再叫谁。
	 */
	integrationSecrets: BackupIntegrationSecrets;
	/** Injectable ISO clock (keeps exports deterministic in tests). */
	now?: () => string;
	/**
	 * 连接的 `settings` 与拓展设置里哪些格是密钥:适配器 `settingsSchema` 上的标记,与拓展声明的键
	 * (按拓展 id 分格)。**现取**:适配器与拓展会被拨开关加载 / 卸载。
	 *
	 * 问不出来的(适配器不在场、拓展没声明)脱敏那边整片当密钥(见 `ExtensionSecretCodes`)。
	 * 不给 = 一个都问不出来。
	 */
	connectionSecrets?: SecretCellsReader;
}

interface ExportOptions {
	kind: BackupKind;
	sections?: SectionSelection;
	pin?: string;
	createdAt?: string;
}

interface ImportOptions {
	envelope: BackupEnvelope;
	pin?: string;
	mode: ImportMode;
	/**
	 * Compute the plan and report it, but write nothing. Lets the dashboard show
	 * "覆盖会删除 N 项，确认？" with real numbers — and surfaces a wrong PIN before
	 * a single config write has happened.
	 */
	dryRun?: boolean;
}

// ImportResult 在 @bilibili-notify/contract(web 同源消费)。

export interface BackupService {
	previewExport(): BackupExportPreviewResponse;
	exportBackup(opts: ExportOptions): Promise<BackupEnvelope>;
	importBackup(opts: ImportOptions): Promise<ImportResult>;
}

type SecretsRestoreResult = Pick<ImportResult, "restoredIntegrations" | "unrestoredIntegrations">;

const ALL_SECTIONS: Required<SectionSelection> = {
	globals: true,
	subscriptions: true,
	connections: true,
	targets: true,
};

/**
 * 恢复完不许多出同身份的重复(docs/1.0/data-model.md)。按身份并入(`planImport`)之后还剩下的,只可能是备份
 * 自己里面就有一对(老版本留下、跟着导了出来):整份拒收、点名是谁,不悄悄丢掉其中一条的设置。
 *
 * 写盘那一层有同一条规矩兜底;这里提前到 dry run 之前,是让预览那一步就说清楚,而不是等主人点了确认。
 */
function assertNoDuplicateInBackup(
	current: readonly Subscription[],
	folded: readonly Subscription[] | undefined,
): void {
	const [dup] = folded ? findNewIdentityDuplicates(current, folded) : [];
	if (!dup) return;
	throw new BackupRejectedError(
		"invalid",
		t("backup.duplicateSubscription", { identity: describeDuplicate(dup) }),
	);
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
	const now = deps.now ?? (() => new Date().toISOString());

	async function exportBackup(opts: ExportOptions): Promise<BackupEnvelope> {
		const sel = { ...ALL_SECTIONS, ...opts.sections };
		const picked: BackupSections = {};
		if (sel.globals) {
			picked.globals = deps.configStore.getGlobals();
			picked.integrations = deps.configStore.getAllIntegrationSettings();
			picked.extensionSettings = deps.configStore.getAllExtensionSettings();
		}
		if (sel.subscriptions) {
			picked.subscriptions = deps.configStore.getSubscriptions();
			// 标签表跟订阅同进同出(ADR-0034):订阅上挂的 tagIds 离了它就是一串认不出的 id。
			picked.subscriptionTags = deps.configStore.getSubscriptionTags();
		}
		if (sel.connections) picked.connections = deps.configStore.getConnections();
		if (sel.targets) picked.targets = deps.configStore.getTargets();
		const createdAt = opts.createdAt ?? now();

		if (opts.kind === "full") {
			if (!opts.pin) throw new BackupRejectedError("invalid", BACKUP_PIN_REQUIRED_MESSAGE);
			const integrationSecrets = await deps.integrationSecrets.exportSecrets();
			return assembleFullBackup(
				{
					globals: picked.globals,
					integrations: picked.integrations,
					extensionSettings: picked.extensionSettings,
					subscriptions: picked.subscriptions,
					subscriptionTags: picked.subscriptionTags,
					connections: picked.connections,
					targets: picked.targets,
					integrationSecrets,
				},
				opts.pin,
				createdAt,
				deps.connectionSecrets,
			);
		}
		return buildBackup({
			kind: "sanitized",
			createdAt,
			sections: redactBackupSections(picked, deps.connectionSecrets),
		});
	}

	async function importBackup(opts: ImportOptions): Promise<ImportResult> {
		let sections: BackupSections;
		let integrationSecrets: Record<string, Record<string, Json>> = {};
		if (opts.envelope.kind === "full") {
			if (!opts.pin) throw new BackupRejectedError("invalid", BACKUP_PIN_REQUIRED_MESSAGE);
			const opened = openFullBackup(opts.envelope, opts.pin);
			sections = opened.sections;
			integrationSecrets = opened.integrationSecrets;
		} else {
			sections = opts.envelope.sections;
		}

		const current = {
			globals: deps.configStore.getGlobals(),
			subscriptions: deps.configStore.getSubscriptions(),
			subscriptionTags: deps.configStore.getSubscriptionTags(),
			connections: deps.configStore.getConnections(),
			targets: deps.configStore.getTargets(),
		};
		const plan = planImport(current, sections, opts.mode);
		const folded = foldPlan(current, plan);
		assertNoDuplicateInBackup(current.subscriptions, folded.subscriptions);

		const globalsApplied = Boolean(
			plan.setGlobals || plan.setIntegrations || plan.setExtensionSettings,
		);
		let secretsRestore: SecretsRestoreResult;
		if (!opts.dryRun) {
			// 一次落地:校验全过才写,任何一处不合法都不会留下半新半旧的配置。
			await deps.configStore.replaceSections(folded);
			secretsRestore = await restoreIntegrationSecrets(integrationSecrets);
		} else {
			secretsRestore = planIntegrationSecrets(integrationSecrets);
		}

		return {
			subscriptions: {
				upserted: plan.subscriptions.upsert.length,
				deleted: plan.subscriptions.delete.length,
			},
			connections: {
				upserted: plan.connections.upsert.length,
				deleted: plan.connections.delete.length,
			},
			targets: { upserted: plan.targets.upsert.length, deleted: plan.targets.delete.length },
			globalsApplied,
			restoredIntegrations: secretsRestore.restoredIntegrations,
			unrestoredIntegrations: secretsRestore.unrestoredIntegrations,
		};
	}

	/** 演练:只按「现在开着没有」分两堆,不写。 */
	function planIntegrationSecrets(
		bags: Record<string, Record<string, Json>>,
	): SecretsRestoreResult {
		const result: SecretsRestoreResult = { restoredIntegrations: [], unrestoredIntegrations: [] };
		for (const key of Object.keys(bags)) {
			if (deps.integrationSecrets.isOpen(key)) result.restoredIntegrations.push(key);
			else result.unrestoredIntegrations.push({ key, message: notRunningMessage() });
		}
		return result;
	}

	/**
	 * 配置各节已经落地之后,逐个集成把密钥整袋换回。**不抛**:配置已经落了,这时抛出去面板只看到一个 500、
	 * 不知道哪些恢复了;某个集成换不回来只进 `unrestoredIntegrations`,别的照常。
	 */
	async function restoreIntegrationSecrets(
		bags: Record<string, Record<string, Json>>,
	): Promise<SecretsRestoreResult> {
		const result: SecretsRestoreResult = { restoredIntegrations: [], unrestoredIntegrations: [] };
		for (const [key, entries] of Object.entries(bags)) {
			if (!deps.integrationSecrets.isOpen(key)) {
				result.unrestoredIntegrations.push({ key, message: notRunningMessage() });
				continue;
			}
			const restored = await deps.integrationSecrets.restoreSecrets(key, entries);
			if (restored.ok) result.restoredIntegrations.push(key);
			else result.unrestoredIntegrations.push({ key, message: restored.message });
		}
		return result;
	}

	return {
		exportBackup,
		importBackup,
		previewExport: () => ({
			defaultedSettings: structuredClone(deps.configStore.getInvalidSettingsPaths()),
		}),
	};
}
