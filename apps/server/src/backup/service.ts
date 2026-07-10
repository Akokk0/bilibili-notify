import type {
	GlobalConfig,
	PushAdapter,
	PushTarget,
	Subscription,
} from "@bilibili-notify/internal";
import { assembleFullBackup, openFullBackup } from "./assemble.js";
import {
	type BackupEnvelope,
	type BackupKind,
	type BackupSections,
	buildBackup,
} from "./envelope.js";
import { type ImportMode, planImport } from "./restore.js";
import { redactSecretKeys } from "./sanitize.js";

/**
 * BackupService — the IO seam wiring the pure backup core to the running
 * standalone end.
 *
 * Export reads the four config scopes (and, for a full backup, the cookie
 * store) and assembles an envelope. Import runs the pure {@link planImport} and
 * then applies each write through the config store's normal methods — which
 * already emit `config-changed` on the bus, so subscriptions/targets/adapters
 * hot-reload for free. Restoring cookies additionally calls
 * {@link BackupServiceDeps.onCookiesRestored} so the auth layer can re-activate
 * the login without a process restart (the one genuinely live-swapped piece).
 */

/** The slice of `ConfigStore` the backup service depends on. */
export interface BackupStore {
	getGlobals(): GlobalConfig;
	getSubscriptions(): Subscription[];
	getAdapters(): PushAdapter[];
	getTargets(): PushTarget[];
	setGlobals(next: GlobalConfig): Promise<void>;
	upsertSubscription(sub: Subscription): Promise<void>;
	deleteSubscription(id: string): Promise<boolean>;
	upsertAdapter(adapter: PushAdapter): Promise<void>;
	deleteAdapter(id: string): Promise<boolean>;
	upsertTarget(target: PushTarget): Promise<void>;
	deleteTarget(id: string): Promise<boolean>;
}

export interface BackupCookieStore {
	load(): Promise<{ cookiesJson: string; refreshToken?: string } | null>;
	save(data: { cookiesJson: string; refreshToken?: string }): Promise<void>;
}

/** Which scopes to include in an export (the sanitized-档 checkboxes). */
export interface SectionSelection {
	globals?: boolean;
	subscriptions?: boolean;
	adapters?: boolean;
	targets?: boolean;
}

export interface BackupServiceDeps {
	configStore: BackupStore;
	cookieStore: BackupCookieStore;
	/** Called after cookies are restored, so the auth layer can live re-login. */
	onCookiesRestored?: () => void | Promise<void>;
	/** Injectable ISO clock (keeps exports deterministic in tests). */
	now?: () => string;
}

export interface ExportOptions {
	kind: BackupKind;
	sections?: SectionSelection;
	pin?: string;
	createdAt?: string;
}

export interface ImportOptions {
	envelope: BackupEnvelope;
	pin?: string;
	mode: ImportMode;
}

export interface ImportResult {
	subscriptions: { upserted: number; deleted: number };
	adapters: { upserted: number; deleted: number };
	targets: { upserted: number; deleted: number };
	globalsApplied: boolean;
	cookiesRestored: boolean;
}

export interface BackupService {
	exportBackup(opts: ExportOptions): Promise<BackupEnvelope>;
	importBackup(opts: ImportOptions): Promise<ImportResult>;
}

const ALL_SECTIONS: Required<SectionSelection> = {
	globals: true,
	subscriptions: true,
	adapters: true,
	targets: true,
};

export function createBackupService(deps: BackupServiceDeps): BackupService {
	const now = deps.now ?? (() => new Date().toISOString());

	async function exportBackup(opts: ExportOptions): Promise<BackupEnvelope> {
		const sel = { ...ALL_SECTIONS, ...opts.sections };
		const picked: BackupSections = {};
		if (sel.globals) picked.globals = deps.configStore.getGlobals();
		if (sel.subscriptions) picked.subscriptions = deps.configStore.getSubscriptions();
		if (sel.adapters) picked.adapters = deps.configStore.getAdapters();
		if (sel.targets) picked.targets = deps.configStore.getTargets();
		const createdAt = opts.createdAt ?? now();

		if (opts.kind === "full") {
			if (!opts.pin) throw new Error("full backup requires a PIN");
			const cookies = (await deps.cookieStore.load()) ?? undefined;
			return assembleFullBackup(
				{
					globals: picked.globals,
					subscriptions: picked.subscriptions,
					adapters: picked.adapters,
					targets: picked.targets,
					cookies,
				},
				opts.pin,
				createdAt,
			);
		}
		return buildBackup({ kind: "sanitized", createdAt, sections: redactSecretKeys(picked) });
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

		const current = {
			globals: deps.configStore.getGlobals(),
			subscriptions: deps.configStore.getSubscriptions(),
			adapters: deps.configStore.getAdapters(),
			targets: deps.configStore.getTargets(),
		};
		const plan = planImport(current, sections, opts.mode);

		let globalsApplied = false;
		if (plan.setGlobals) {
			await deps.configStore.setGlobals(plan.setGlobals);
			globalsApplied = true;
		}
		for (const s of plan.subscriptions.upsert) await deps.configStore.upsertSubscription(s);
		for (const id of plan.subscriptions.delete) await deps.configStore.deleteSubscription(id);
		for (const a of plan.adapters.upsert) await deps.configStore.upsertAdapter(a);
		for (const id of plan.adapters.delete) await deps.configStore.deleteAdapter(id);
		for (const t of plan.targets.upsert) await deps.configStore.upsertTarget(t);
		for (const id of plan.targets.delete) await deps.configStore.deleteTarget(id);

		let cookiesRestored = false;
		if (cookies?.cookiesJson) {
			await deps.cookieStore.save({
				cookiesJson: cookies.cookiesJson,
				refreshToken: cookies.refreshToken,
			});
			await deps.onCookiesRestored?.();
			cookiesRestored = true;
		}

		return {
			subscriptions: {
				upserted: plan.subscriptions.upsert.length,
				deleted: plan.subscriptions.delete.length,
			},
			adapters: { upserted: plan.adapters.upsert.length, deleted: plan.adapters.delete.length },
			targets: { upserted: plan.targets.upsert.length, deleted: plan.targets.delete.length },
			globalsApplied,
			cookiesRestored,
		};
	}

	return { exportBackup, importBackup };
}
