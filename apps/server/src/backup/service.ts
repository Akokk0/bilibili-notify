import type { ImportResult } from "@bilibili-notify/contract";
import {
	type Connection,
	type GlobalConfig,
	isBiliSubscription,
	isExtensionSubscription,
	migrateConfigSections,
	type PushTarget,
	type Subscription,
} from "@bilibili-notify/internal";
import { assembleFullBackup, openFullBackup } from "./assemble.js";
import {
	type BackupEnvelope,
	type BackupKind,
	type BackupSections,
	buildBackup,
} from "./envelope.js";
import { foldPlan, type ImportMode, planImport } from "./restore.js";
import { type ExtensionSecretCodes, redactBackupSections } from "./sanitize.js";

/**
 * BackupService — the IO seam wiring the pure backup core to the running
 * standalone end.
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
	getSubscriptions(): Subscription[];
	getConnections(): Connection[];
	getTargets(): PushTarget[];
	replaceSections(next: {
		globals?: GlobalConfig;
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
	globals?: boolean;
	/** 订阅 —— 两支一起:B 站那节与拓展那节(ADR-0019 决策 48)。 */
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
 * 两节订阅各装各的那一支,装错了整份拒(ADR-0019 决策 48)。恢复是两支各算各的计划,一条
 * 拓展订阅混在 B 站那节里,overwrite 算删除集时会拿它去比 B 站那一支 —— 同一个 id 可能在
 * 两支里各留一份。备份的明文段没过任何 schema,这里是唯一能认出这件事的地方。
 */
function assertSubscriptionSectionKinds(sections: BackupSections): void {
	const raw = sections as { subscriptions?: unknown; extensionSubscriptions?: unknown };
	const kindOf = (row: unknown): unknown => (row as { kind?: unknown } | null)?.kind;
	if (
		Array.isArray(raw.subscriptions) &&
		raw.subscriptions.some((s) => kindOf(s) === "extension")
	) {
		throw new Error("backup section `subscriptions` contains an extension subscription");
	}
	if (
		Array.isArray(raw.extensionSubscriptions) &&
		raw.extensionSubscriptions.some((s) => kindOf(s) !== "extension")
	) {
		throw new Error(
			"backup section `extensionSubscriptions` contains a non-extension subscription",
		);
	}
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
	const now = deps.now ?? (() => new Date().toISOString());

	async function exportBackup(opts: ExportOptions): Promise<BackupEnvelope> {
		const sel = { ...ALL_SECTIONS, ...opts.sections };
		const picked: BackupSections = {};
		if (sel.globals) picked.globals = deps.configStore.getGlobals();
		if (sel.subscriptions) {
			const subs = deps.configStore.getSubscriptions();
			picked.subscriptions = subs.filter(isBiliSubscription);
			picked.extensionSubscriptions = subs.filter(isExtensionSubscription);
		}
		if (sel.connections) picked.connections = deps.configStore.getConnections();
		if (sel.targets) picked.targets = deps.configStore.getTargets();
		const createdAt = opts.createdAt ?? now();

		if (opts.kind === "full") {
			if (!opts.pin) throw new Error("full backup requires a PIN");
			const cookies = (await deps.cookieStore.load()) ?? undefined;
			return assembleFullBackup(
				{
					globals: picked.globals,
					subscriptions: picked.subscriptions,
					extensionSubscriptions: picked.extensionSubscriptions,
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
			if (!opts.pin) throw new Error("full backup requires a PIN");
			const opened = openFullBackup(opts.envelope, opts.pin);
			sections = opened.sections;
			cookies = opened.cookies;
		} else {
			sections = opts.envelope.sections;
		}

		// 盘上那份连接表 —— 迁移的补位与 planImport 的「现状」都读它。取两次拿到的是两份
		// 深拷贝,而中间没有任何写入:一次取完共用,省掉一次整表克隆。
		const currentConnections = deps.configStore.getConnections();

		// 形状迁移 —— 与启动路径同一个纯函数。备份的明文段是**原样带过来的**,没过任何
		// schema,所以一份三个月前导出的备份和一份三个月前的磁盘状态是同一个形状问题。
		// 放在 planImport 之前:计划要按迁移后的形状算,否则 overwrite 的删除集会对不上。
		if (sections.connections || sections.targets) {
			const migrated = migrateConfigSections({
				// 🔴 只勾了 targets 那一段导出的老备份:v1 的 `platform: "webhook"` 得跟着
				// **它那条连接**降格(飞书 / 钉钉 / 企微),而连接不在这份备份里 —— 查不到表
				// 就整份落成 `generic`,落地时被 `assertTargetOwner` 判「平台对不上」,整份
				// 恢复被拒(托管目标的归一化排在那道校验之后,救不回来)。备份没带的那一段,
				// 拿**现在盘上那份**补位。
				connections: sections.connections ?? currentConnections,
				targets: sections.targets,
			});
			sections = {
				...sections,
				...(sections.connections ? { connections: migrated.connections as Connection[] } : {}),
				...(sections.targets ? { targets: migrated.targets as PushTarget[] } : {}),
			};
		}

		assertSubscriptionSectionKinds(sections);
		const currentSubs = deps.configStore.getSubscriptions();
		const current = {
			globals: deps.configStore.getGlobals(),
			subscriptions: currentSubs.filter(isBiliSubscription),
			extensionSubscriptions: currentSubs.filter(isExtensionSubscription),
			connections: currentConnections,
			targets: deps.configStore.getTargets(),
		};
		const plan = planImport(current, sections, opts.mode);

		let globalsApplied = false;
		let cookiesRestored = false;
		if (!opts.dryRun) {
			// 一次落地:校验全过才写,任何一处不合法都不会留下半新半旧的配置。
			await deps.configStore.replaceSections(foldPlan(current, plan));
			globalsApplied = Boolean(plan.setGlobals);

			if (cookies?.cookiesJson) {
				await deps.cookieStore.save({
					cookiesJson: cookies.cookiesJson,
					refreshToken: cookies.refreshToken,
				});
				await deps.onCookiesRestored?.();
				cookiesRestored = true;
			}
		} else {
			globalsApplied = Boolean(plan.setGlobals);
			cookiesRestored = Boolean(cookies?.cookiesJson);
		}

		return {
			// 面板上「订阅」一栏说的是两支合起来(导出时也是同一个勾选)。
			subscriptions: {
				upserted: plan.subscriptions.upsert.length + plan.extensionSubscriptions.upsert.length,
				deleted: plan.subscriptions.delete.length + plan.extensionSubscriptions.delete.length,
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
