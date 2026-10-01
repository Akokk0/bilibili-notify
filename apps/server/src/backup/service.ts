import type { ImportResult } from "@bilibili-notify/contract";
import type { Connection, GlobalConfig, PushTarget, Subscription } from "@bilibili-notify/internal";
import { findNewIdentityDuplicates } from "@bilibili-notify/subscription";
import { describeDuplicate } from "../config/store.js";
import { assembleFullBackup, openFullBackup } from "./assemble.js";
import {
	type BackupEnvelope,
	type BackupKind,
	type BackupSections,
	buildBackup,
} from "./envelope.js";
import { BACKUP_PIN_REQUIRED_MESSAGE, BackupRejectedError } from "./rejected-error.js";
import { foldPlan, type ImportMode, planImport } from "./restore.js";
import { type ExtensionSecretCodes, redactBackupSections } from "./sanitize.js";

/**
 * BackupService — the IO seam wiring the pure backup core to the running
 * server.
 *
 * Export reads the four config scopes (and, for a full backup, the cookie
 * store) and assembles an envelope. Import runs the pure {@link planImport},
 * folds it into the end state with {@link foldPlan} and hands that to
 * `replaceSections` in **one** call — restore is a wholesale state replacement,
 * not a sequence of user edits, and pretending otherwise cost us both a guard
 * meant for humans (webhook targets cannot be hand-created) and any chance of
 * rolling back a half-applied import. Restoring cookies additionally calls
 * {@link BackupServiceDeps.onCookiesRestored} so the auth layer can re-activate
 * the login without a process restart (the one genuinely live-swapped piece).
 */

/** The slice of `ConfigStore` the backup service depends on. */
export interface BackupStore {
	getGlobals(): GlobalConfig;
	getAllIntegrationSettings(): Record<string, unknown>;
	getSubscriptions(): Subscription[];
	getConnections(): Connection[];
	getTargets(): PushTarget[];
	replaceSections(next: {
		globals?: GlobalConfig;
		integrations?: Record<string, unknown>;
		subscriptions?: Subscription[];
		connections?: Connection[];
		targets?: PushTarget[];
	}): Promise<unknown>;
}

interface BackupCookieStore {
	load(): Promise<{ cookiesJson: string; refreshToken?: string } | null>;
	save(data: { cookiesJson: string; refreshToken?: string }): Promise<void>;
}

/** Which scopes to include in an export (the sanitized-档 checkboxes). */
export interface SectionSelection {
	/** 设置:核心那份连同各集成的(B 站……)。 */
	globals?: boolean;
	/** 订阅:只有一节,B 站与拓展来源的同在里面(ADR-0021 决策 15)。 */
	subscriptions?: boolean;
	connections?: boolean;
	targets?: boolean;
}

export interface BackupServiceDeps {
	configStore: BackupStore;
	cookieStore: BackupCookieStore;
	/** Called after cookies are restored, so the auth layer can live re-login. */
	onCookiesRestored?: () => void | Promise<void>;
	/** Injectable ISO clock (keeps exports deterministic in tests). */
	now?: () => string;
	/**
	 * 拓展在字段表里声明 `secret: true` 的那些 config 键,**按拓展 id 分格**。
	 * **现取**:拓展会被拨开关加载 / 卸载。
	 *
	 * 不在表里的拓展 = 没跑起来 = 问不出来,脱敏那边把它那两格整片当密钥
	 * (见 {@link ExtensionSecretCodes})。
	 */
	extensionSecretCodes?: () => ExtensionSecretCodes;
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
	exportBackup(opts: ExportOptions): Promise<BackupEnvelope>;
	importBackup(opts: ImportOptions): Promise<ImportResult>;
}

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
		`备份里同一个人有不止一条订阅：${describeDuplicate(dup)}。同一个人只能有一条订阅，整份没有恢复 —— 回原来那台机器删掉多余的那条，重新导出再恢复`,
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
		}
		if (sel.subscriptions) picked.subscriptions = deps.configStore.getSubscriptions();
		if (sel.connections) picked.connections = deps.configStore.getConnections();
		if (sel.targets) picked.targets = deps.configStore.getTargets();
		const createdAt = opts.createdAt ?? now();

		if (opts.kind === "full") {
			if (!opts.pin) throw new BackupRejectedError("invalid", BACKUP_PIN_REQUIRED_MESSAGE);
			const cookies = (await deps.cookieStore.load()) ?? undefined;
			return assembleFullBackup(
				{
					globals: picked.globals,
					integrations: picked.integrations,
					subscriptions: picked.subscriptions,
					connections: picked.connections,
					targets: picked.targets,
					cookies,
				},
				opts.pin,
				createdAt,
				deps.extensionSecretCodes?.(),
			);
		}
		return buildBackup({
			kind: "sanitized",
			createdAt,
			sections: redactBackupSections(picked, deps.extensionSecretCodes?.()),
		});
	}

	async function importBackup(opts: ImportOptions): Promise<ImportResult> {
		let sections: BackupSections;
		let cookies: { cookiesJson?: string; refreshToken?: string } | undefined;
		if (opts.envelope.kind === "full") {
			if (!opts.pin) throw new BackupRejectedError("invalid", BACKUP_PIN_REQUIRED_MESSAGE);
			const opened = openFullBackup(opts.envelope, opts.pin);
			sections = opened.sections;
			cookies = opened.cookies;
		} else {
			sections = opts.envelope.sections;
		}

		const current = {
			globals: deps.configStore.getGlobals(),
			subscriptions: deps.configStore.getSubscriptions(),
			connections: deps.configStore.getConnections(),
			targets: deps.configStore.getTargets(),
		};
		const plan = planImport(current, sections, opts.mode);
		const folded = foldPlan(current, plan);
		assertNoDuplicateInBackup(current.subscriptions, folded.subscriptions);

		let globalsApplied = false;
		let cookiesRestored = false;
		if (!opts.dryRun) {
			// 一次落地:校验全过才写,任何一处不合法都不会留下半新半旧的配置。
			await deps.configStore.replaceSections(folded);
			globalsApplied = Boolean(plan.setGlobals || plan.setIntegrations);

			if (cookies?.cookiesJson) {
				await deps.cookieStore.save({
					cookiesJson: cookies.cookiesJson,
					refreshToken: cookies.refreshToken,
				});
				await deps.onCookiesRestored?.();
				cookiesRestored = true;
			}
		} else {
			globalsApplied = Boolean(plan.setGlobals || plan.setIntegrations);
			cookiesRestored = Boolean(cookies?.cookiesJson);
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
			cookiesRestored,
		};
	}

	return { exportBackup, importBackup };
}
