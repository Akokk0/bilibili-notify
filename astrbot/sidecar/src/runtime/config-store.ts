import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AstrBotAdapter,
	AstrBotAdapterSchema,
	type AstrBotPushTarget,
	AstrBotPushTargetSchema,
	type AstrBotSession,
	AstrBotSessionSchema,
	type ConfigScope,
	type FeatureFlags,
	type GlobalConfig,
	GlobalConfigSchema,
	type MessageBus,
	makeDefaultGlobalConfig,
	type Subscription,
	SubscriptionSchema,
} from "@bilibili-notify/internal";
import { ASTRBOT_ADAPTER_ID, ASTRBOT_PUSH_ADAPTER, ASTRBOT_TARGET_ID } from "./callback-sink.js";
import { normalizeAstrBotSubscription } from "./persistence.js";

const CONFIG_VERSION = 1;
const STATE_DIR_NAME = "state";
const META_FILE = "meta.json";
const LEGACY_SUBSCRIPTIONS_FILE = "subscriptions.json";
const LEGACY_SUBSCRIPTIONS_BACKUP = "backups/subscriptions.legacy.json";
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type AstrBotConfigScope = Exclude<ConfigScope, "secrets">;

export interface AstrBotConfigScopeSnapshot {
	readonly count?: number;
	readonly path: string;
}

export interface AstrBotConfigSnapshot {
	readonly version: number;
	readonly stateDir: string;
	readonly globals: AstrBotConfigScopeSnapshot;
	readonly subscriptions: AstrBotConfigScopeSnapshot & { readonly count: number };
	readonly adapters: AstrBotConfigScopeSnapshot & { readonly count: number };
	readonly targets: AstrBotConfigScopeSnapshot & { readonly count: number };
}

export interface AstrBotPairingCode {
	readonly code: string;
	readonly expiresAt: string;
}

export interface AstrBotPairingConfirmResult {
	readonly target: AstrBotPushTarget;
	readonly created: boolean;
}

export interface AstrBotConfigStore {
	readonly dataDir: string;
	readonly stateDir: string;
	load(): Promise<void>;
	getGlobals(): GlobalConfig;
	getSubscriptions(): Subscription[];
	getAdapters(): AstrBotAdapter[];
	getTargets(): AstrBotPushTarget[];
	setGlobals(next: GlobalConfig): Promise<GlobalConfig>;
	upsertSubscription(subscription: Subscription): Promise<Subscription>;
	deleteSubscription(id: string): Promise<Subscription | undefined>;
	upsertTarget(target: AstrBotPushTarget): Promise<AstrBotPushTarget>;
	deleteTarget(id: string): Promise<AstrBotPushTarget | undefined>;
	createPairingCode(now?: number): AstrBotPairingCode;
	confirmPairingCode(
		code: string,
		session: AstrBotSession,
		now?: number,
	): Promise<AstrBotPairingConfirmResult | undefined>;
	snapshot(): AstrBotConfigSnapshot;
}

export interface CreateAstrBotConfigStoreOptions {
	readonly dataDir: string;
	readonly bus?: MessageBus;
	readonly stateDir?: string;
}

interface PairingCodeEntry extends AstrBotPairingCode {
	readonly createdAt: string;
}

export class AstrBotConfigValidationError extends Error {
	readonly scope: AstrBotConfigScope | "meta";
	readonly issues: unknown;

	constructor(scope: AstrBotConfigScope | "meta", issues: unknown, message?: string) {
		super(message ?? `AstrBot config validation failed: ${scope}`);
		this.name = "AstrBotConfigValidationError";
		this.scope = scope;
		this.issues = issues;
	}
}

class DefaultAstrBotConfigStore implements AstrBotConfigStore {
	readonly dataDir: string;
	readonly stateDir: string;
	private readonly bus?: MessageBus;
	private globals: GlobalConfig = makeDefaultGlobalConfig();
	private subscriptions: Subscription[] = [];
	private adapters: AstrBotAdapter[] = [ASTRBOT_PUSH_ADAPTER];
	private targets: AstrBotPushTarget[] = [];
	private pairingCodes: PairingCodeEntry[] = [];
	private loaded = false;
	private loadPromise: Promise<void> | undefined;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: CreateAstrBotConfigStoreOptions) {
		this.dataDir = options.dataDir;
		this.stateDir = options.stateDir ?? join(options.dataDir, STATE_DIR_NAME);
		this.bus = options.bus;
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		// 单例化：并发 load() 复用同一 promise，避免守卫在末尾置位时双双穿过、
		// 把 load（含游离于 transact 之外的 prune 写）跑两遍互相竞争。
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = (async () => {
			await mkdir(this.stateDir, { recursive: true });
			await this.loadMeta();
			await this.loadGlobals();
			await this.loadSubscriptions();
			await this.loadAdapters();
			await this.loadTargets();
			await this.pruneHiddenFallbackRoutes();
			this.loaded = true;
		})().finally(() => {
			this.loadPromise = undefined;
		});
		return this.loadPromise;
	}

	getGlobals(): GlobalConfig {
		return deepClone(this.globals);
	}

	getSubscriptions(): Subscription[] {
		return deepClone(this.subscriptions);
	}

	getAdapters(): AstrBotAdapter[] {
		return deepClone(this.adapters);
	}

	getTargets(): AstrBotPushTarget[] {
		return deepClone(this.targets);
	}

	async setGlobals(next: GlobalConfig): Promise<GlobalConfig> {
		const parsed = GlobalConfigSchema.safeParse(next);
		if (!parsed.success) {
			throw new AstrBotConfigValidationError("globals", parsed.error.issues);
		}
		return this.transact(async () => {
			this.globals = sanitizeAstrBotGlobals(parsed.data).value;
			await atomicWriteJson(this.path("globals"), this.globals);
			this.bus?.emit("config-changed", "globals");
			return this.getGlobals();
		});
	}

	async upsertSubscription(subscription: Subscription): Promise<Subscription> {
		const parsed = SubscriptionSchema.safeParse(subscription);
		if (!parsed.success) {
			throw new AstrBotConfigValidationError("subscriptions", parsed.error.issues);
		}
		const normalized = normalizeAstrBotSubscription(parsed.data);
		return this.transact(async () => {
			this.subscriptions = upsertById(this.subscriptions, normalized);
			await atomicWriteJson(this.path("subscriptions"), this.subscriptions);
			this.bus?.emit("config-changed", "subscriptions");
			return deepClone(normalized);
		});
	}

	async deleteSubscription(id: string): Promise<Subscription | undefined> {
		return this.transact(async () => {
			const index = this.subscriptions.findIndex((entry) => entry.id === id);
			if (index < 0) return undefined;
			const [removed] = this.subscriptions.splice(index, 1);
			await atomicWriteJson(this.path("subscriptions"), this.subscriptions);
			this.bus?.emit("config-changed", "subscriptions");
			return removed ? deepClone(removed) : undefined;
		});
	}

	async upsertTarget(target: AstrBotPushTarget): Promise<AstrBotPushTarget> {
		const parsed = AstrBotPushTargetSchema.safeParse(target);
		if (!parsed.success) {
			throw new AstrBotConfigValidationError("targets", parsed.error.issues);
		}
		if (parsed.data.adapterId !== ASTRBOT_ADAPTER_ID) {
			throw new AstrBotConfigValidationError(
				"targets",
				{
					adapterId: parsed.data.adapterId,
					message: "target must reference the hidden AstrBot adapter",
				},
				"AstrBot target must reference the hidden AstrBot adapter",
			);
		}
		return this.transact(async () => {
			const previous = this.targets.find((entry) => entry.id === parsed.data.id);
			const activated = isTargetActivation(previous, parsed.data);
			this.targets = upsertById(this.targets, parsed.data);
			await atomicWriteJson(this.path("targets"), this.targets);
			const changedSubscriptions = await this.reconcileSubscriptionsForTarget(
				parsed.data.id,
				activated,
			);
			this.bus?.emit("config-changed", "targets");
			if (changedSubscriptions) this.bus?.emit("config-changed", "subscriptions");
			return deepClone(parsed.data);
		});
	}

	async deleteTarget(id: string): Promise<AstrBotPushTarget | undefined> {
		return this.transact(async () => {
			const index = this.targets.findIndex((entry) => entry.id === id);
			if (index < 0) return undefined;
			const [removed] = this.targets.splice(index, 1);
			await atomicWriteJson(this.path("targets"), this.targets);
			this.bus?.emit("config-changed", "targets");
			return removed ? deepClone(removed) : undefined;
		});
	}

	createPairingCode(now = Date.now()): AstrBotPairingCode {
		this.prunePairingCodes(now);
		let code = generatePairingCode();
		while (this.pairingCodes.some((entry) => entry.code === code)) {
			code = generatePairingCode();
		}
		const entry = {
			code,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + PAIRING_CODE_TTL_MS).toISOString(),
		};
		this.pairingCodes.push(entry);
		return { code: entry.code, expiresAt: entry.expiresAt };
	}

	async confirmPairingCode(
		code: string,
		session: AstrBotSession,
		now = Date.now(),
	): Promise<AstrBotPairingConfirmResult | undefined> {
		const normalizedCode = normalizePairingCode(code);
		if (!normalizedCode) return undefined;
		const parsed = AstrBotSessionSchema.safeParse(session);
		if (!parsed.success) {
			throw new AstrBotConfigValidationError("targets", parsed.error.issues);
		}
		return this.transact(async () => {
			this.prunePairingCodes(now);
			const codeIndex = this.pairingCodes.findIndex((entry) => entry.code === normalizedCode);
			if (codeIndex < 0) return undefined;
			this.pairingCodes.splice(codeIndex, 1);
			const existing = this.targets.find(
				(target) => target.session.unified_msg_origin === parsed.data.unified_msg_origin,
			);
			const target = buildAstrBotTarget(parsed.data, existing);
			const activated = isTargetActivation(existing, target);
			this.targets = upsertById(this.targets, target);
			await atomicWriteJson(this.path("targets"), this.targets);
			// 配对码绑定是 AstrBot 创建真实 target 的主路径，必须与 upsertTarget 对称走
			// reconcile（先剔隐藏 fallback，仅在首次绑定 / 停用→启用跃迁时回填从未配置过
			// 路由的订阅），否则"先建订阅、后 /bn bind 绑目标"的订阅 routing 仍为空、收不到推送。
			const changedSubscriptions = await this.reconcileSubscriptionsForTarget(target.id, activated);
			this.bus?.emit("config-changed", "targets");
			if (changedSubscriptions) this.bus?.emit("config-changed", "subscriptions");
			return { target: deepClone(target), created: !existing };
		});
	}

	snapshot(): AstrBotConfigSnapshot {
		return {
			version: CONFIG_VERSION,
			stateDir: this.stateDir,
			globals: { path: this.path("globals") },
			subscriptions: { count: this.subscriptions.length, path: this.path("subscriptions") },
			adapters: { count: this.adapters.length, path: this.path("adapters") },
			targets: { count: this.targets.length, path: this.path("targets") },
		};
	}

	private transact<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.writeQueue.then(operation, operation);
		this.writeQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private prunePairingCodes(now: number): void {
		this.pairingCodes = this.pairingCodes.filter((entry) => Date.parse(entry.expiresAt) > now);
	}

	private path(scope: AstrBotConfigScope | "meta"): string {
		switch (scope) {
			case "globals":
				return join(this.stateDir, "globals.json");
			case "subscriptions":
				return join(this.stateDir, "subscriptions.json");
			case "adapters":
				return join(this.stateDir, "adapters.json");
			case "targets":
				return join(this.stateDir, "targets.json");
			case "meta":
				return join(this.stateDir, META_FILE);
		}
	}

	private async loadMeta(): Promise<void> {
		const { value } = await readJsonOrInit(this.path("meta"), () => ({ version: CONFIG_VERSION }));
		if (!isPlainObject(value) || value.version !== CONFIG_VERSION) {
			throw new AstrBotConfigValidationError(
				"meta",
				{ version: isPlainObject(value) ? value.version : undefined },
				`unsupported AstrBot config version: ${isPlainObject(value) ? String(value.version) : "unknown"}`,
			);
		}
	}

	private async loadGlobals(): Promise<void> {
		const { value } = await readJsonOrInit(this.path("globals"), makeDefaultGlobalConfig);
		const parsed = GlobalConfigSchema.safeParse(value);
		if (!parsed.success) {
			throw new AstrBotConfigValidationError(
				"globals",
				parsed.error.issues,
				"globals.json failed schema validation",
			);
		}
		const sanitized = sanitizeAstrBotGlobals(parsed.data);
		this.globals = sanitized.value;
		if (sanitized.changed || !sameJson(value, this.globals)) {
			await atomicWriteJson(this.path("globals"), this.globals);
		}
	}

	private async loadSubscriptions(): Promise<void> {
		const subscriptionsPath = this.path("subscriptions");
		let raw: unknown;
		if (
			!(await fileExists(subscriptionsPath)) &&
			(await fileExists(this.legacySubscriptionsPath()))
		) {
			raw = JSON.parse(await readFile(this.legacySubscriptionsPath(), "utf8"));
			await backupLegacySubscriptions(
				this.legacySubscriptionsPath(),
				this.legacySubscriptionsBackupPath(),
			);
			this.subscriptions = parseSubscriptions(raw);
			await atomicWriteJson(subscriptionsPath, this.subscriptions);
			return;
		}
		const loaded = await readJsonOrInit(subscriptionsPath, () => [] as Subscription[]);
		raw = loaded.value;
		this.subscriptions = parseSubscriptions(raw);
		if (!loaded.existed || !sameJson(raw, this.subscriptions)) {
			await atomicWriteJson(subscriptionsPath, this.subscriptions);
		}
	}

	private async loadAdapters(): Promise<void> {
		const loaded = await readJsonOrInit(this.path("adapters"), () => [ASTRBOT_PUSH_ADAPTER]);
		this.adapters = parseAstrBotAdapters(loaded.value);
		if (!loaded.existed || !sameJson(loaded.value, this.adapters)) {
			await atomicWriteJson(this.path("adapters"), this.adapters);
		}
	}

	private async loadTargets(): Promise<void> {
		const loaded = await readJsonOrInit(this.path("targets"), () => [] as AstrBotPushTarget[]);
		this.targets = parseAstrBotTargets(loaded.value);
		if (!loaded.existed || !sameJson(loaded.value, this.targets)) {
			await atomicWriteJson(this.path("targets"), this.targets);
		}
	}

	private async pruneHiddenFallbackRoutes(): Promise<boolean> {
		const next = removeTargetIdFromSubscriptions(this.subscriptions, ASTRBOT_TARGET_ID);
		if (sameJson(next, this.subscriptions)) return false;
		this.subscriptions = next;
		await atomicWriteJson(this.path("subscriptions"), this.subscriptions);
		return true;
	}

	// 绑定/启用真实推送目标时：先剔除隐藏 fallback target；再把"整体从未配置过路由"的
	// 订阅按有效 feature 开关（订阅覆盖优先，否则全局默认）回填到该目标，解决"先建订阅、
	// 后绑目标 → routing 永远为空 → 启用却无推送"。回填仅在 shouldBackfill（target 新建
	// 或停用→启用跃迁，见 isTargetActivation）时进行，避免测试推送 / 重命名 / 重复保存等
	// 无关写操作静默改写路由。prune 总会执行；只动整体空 routing 的订阅，不覆盖用户已
	// 定制的路由；默认关闭的 feature 保持为空。
	private async reconcileSubscriptionsForTarget(
		targetId: string,
		shouldBackfill: boolean,
	): Promise<boolean> {
		const pruned = removeTargetIdFromSubscriptions(this.subscriptions, ASTRBOT_TARGET_ID);
		const target = this.targets.find((entry) => entry.id === targetId);
		const next =
			shouldBackfill && target?.enabled && targetId !== ASTRBOT_TARGET_ID
				? backfillEmptyRoutes(pruned, targetId, this.globals.defaults.features)
				: pruned;
		if (sameJson(next, this.subscriptions)) return false;
		this.subscriptions = next;
		await atomicWriteJson(this.path("subscriptions"), this.subscriptions);
		return true;
	}

	private legacySubscriptionsPath(): string {
		return join(this.dataDir, LEGACY_SUBSCRIPTIONS_FILE);
	}

	private legacySubscriptionsBackupPath(): string {
		return join(this.stateDir, LEGACY_SUBSCRIPTIONS_BACKUP);
	}
}

export function createAstrBotConfigStore(
	options: CreateAstrBotConfigStoreOptions,
): AstrBotConfigStore {
	return new DefaultAstrBotConfigStore(options);
}

function generatePairingCode(): string {
	const bytes = randomBytes(PAIRING_CODE_LENGTH);
	return Array.from(bytes, (byte) =>
		PAIRING_CODE_ALPHABET.charAt(byte % PAIRING_CODE_ALPHABET.length),
	).join("");
}

function normalizePairingCode(code: string): string {
	return code.trim().replace(/[\s-]/g, "").toUpperCase();
}

// 回填只应发生在 target "成为有效推送目标"的跃迁：首次创建为 enabled，或从 disabled
// 切到 enabled。已 enabled 的 target 上的重命名 / testStatus 回写 / 重复保存不算跃迁、
// 不触发回填，避免无关写操作静默改写用户订阅路由。
function isTargetActivation(
	previous: AstrBotPushTarget | undefined,
	next: AstrBotPushTarget,
): boolean {
	if (!next.enabled) return false;
	if (!previous) return true;
	return !previous.enabled;
}

function buildAstrBotTarget(
	session: AstrBotSession,
	existing: AstrBotPushTarget | undefined,
): AstrBotPushTarget {
	const target: AstrBotPushTarget = {
		id: existing?.id ?? randomUUID(),
		name: existing?.name ?? buildTargetName(session),
		adapterId: ASTRBOT_ADAPTER_ID,
		platform: "astrbot",
		scope: inferTargetScope(session.messageType),
		// 复用已有 target 时保留其启用状态：对手动停用的会话重新 /bn bind 不应擅自重启用。
		enabled: existing?.enabled ?? true,
		session: deepClone(session),
	};
	return {
		...target,
		...(existing?.testStatus ? { testStatus: existing.testStatus } : {}),
	};
}

function buildTargetName(session: AstrBotSession): string {
	if (session.sessionName?.trim()) return session.sessionName.trim();
	if (session.sessionId?.trim()) return `AstrBot ${session.sessionId.trim()}`;
	if (session.platform?.trim()) return `AstrBot ${session.platform.trim()}`;
	return "AstrBot 会话";
}

function inferTargetScope(messageType: string | undefined): AstrBotPushTarget["scope"] {
	const value = messageType?.toLowerCase() ?? "";
	if (value.includes("group")) return "group";
	if (value.includes("private") || value.includes("friend")) return "private";
	return "channel";
}

function parseSubscriptions(raw: unknown): Subscription[] {
	if (!Array.isArray(raw)) {
		throw new AstrBotConfigValidationError(
			"subscriptions",
			{ message: "subscriptions.json must be an array" },
			"subscriptions.json must be an array",
		);
	}
	return raw.map((entry, index) => {
		const parsed = SubscriptionSchema.safeParse(entry);
		if (!parsed.success) {
			throw new AstrBotConfigValidationError(
				"subscriptions",
				{ index, issues: parsed.error.issues },
				`subscriptions.json[${index}] failed schema validation`,
			);
		}
		return normalizeAstrBotSubscription(parsed.data);
	});
}

function parseAstrBotAdapters(raw: unknown): AstrBotAdapter[] {
	if (!Array.isArray(raw)) {
		throw new AstrBotConfigValidationError(
			"adapters",
			{ message: "adapters.json must be an array" },
			"adapters.json must be an array",
		);
	}
	if (raw.length === 0) return [ASTRBOT_PUSH_ADAPTER];
	if (raw.length !== 1) {
		throw new AstrBotConfigValidationError(
			"adapters",
			{ count: raw.length, message: "AstrBot sidecar supports exactly one hidden adapter" },
			"AstrBot sidecar supports exactly one hidden adapter",
		);
	}
	const parsed = AstrBotAdapterSchema.safeParse(raw[0]);
	if (!parsed.success) {
		throw new AstrBotConfigValidationError(
			"adapters",
			{ index: 0, issues: parsed.error.issues },
			"adapters.json[0] failed AstrBot adapter validation",
		);
	}
	if (parsed.data.id !== ASTRBOT_ADAPTER_ID) {
		throw new AstrBotConfigValidationError(
			"adapters",
			{ id: parsed.data.id, message: "unexpected hidden AstrBot adapter id" },
			"unexpected hidden AstrBot adapter id",
		);
	}
	return [parsed.data];
}

function parseAstrBotTargets(raw: unknown): AstrBotPushTarget[] {
	if (!Array.isArray(raw)) {
		throw new AstrBotConfigValidationError(
			"targets",
			{ message: "targets.json must be an array" },
			"targets.json must be an array",
		);
	}
	return raw
		.map((entry, index) => {
			const parsed = AstrBotPushTargetSchema.safeParse(entry);
			if (!parsed.success) {
				throw new AstrBotConfigValidationError(
					"targets",
					{ index, issues: parsed.error.issues },
					`targets.json[${index}] failed AstrBot target validation`,
				);
			}
			if (parsed.data.adapterId !== ASTRBOT_ADAPTER_ID) {
				throw new AstrBotConfigValidationError(
					"targets",
					{
						index,
						adapterId: parsed.data.adapterId,
						message: "target must reference hidden adapter",
					},
					`targets.json[${index}] must reference the hidden AstrBot adapter`,
				);
			}
			return parsed.data;
		})
		.filter((target) => target.id !== ASTRBOT_TARGET_ID);
}

function removeTargetIdFromSubscriptions(
	subscriptions: readonly Subscription[],
	targetId: string,
): Subscription[] {
	return subscriptions.map((subscription) =>
		removeTargetIdFromSubscription(subscription, targetId),
	);
}

function removeTargetIdFromSubscription(
	subscription: Subscription,
	targetId: string,
): Subscription {
	let changed = false;
	const routing = deepClone(subscription.routing);
	for (const feature of Object.keys(routing) as Array<keyof typeof routing>) {
		const filtered = routing[feature].filter((id) => id !== targetId);
		if (filtered.length !== routing[feature].length) {
			routing[feature] = filtered;
			changed = true;
		}
	}
	const atAll = deepClone(subscription.atAll);
	for (const scope of ["dynamic", "live"] as const) {
		if (targetId in atAll[scope]) {
			delete atAll[scope][targetId];
			changed = true;
		}
	}
	return changed ? normalizeAstrBotSubscription({ ...subscription, routing, atAll }) : subscription;
}

function backfillEmptyRoutes(
	subscriptions: readonly Subscription[],
	targetId: string,
	defaults: FeatureFlags,
): Subscription[] {
	return subscriptions.map((subscription) =>
		backfillEmptyRoutesForSubscription(subscription, targetId, defaults),
	);
}

function backfillEmptyRoutesForSubscription(
	subscription: Subscription,
	targetId: string,
	defaults: FeatureFlags,
): Subscription {
	const features = Object.keys(subscription.routing) as Array<keyof Subscription["routing"]>;
	const alreadyRouted = features.some((feature) => subscription.routing[feature].length > 0);
	if (alreadyRouted) return subscription;
	const overrides = subscription.overrides?.features;
	const routing = deepClone(subscription.routing);
	let changed = false;
	for (const feature of features) {
		if (overrides?.[feature] ?? defaults[feature]) {
			routing[feature] = [targetId];
			changed = true;
		}
	}
	return changed ? normalizeAstrBotSubscription({ ...subscription, routing }) : subscription;
}

function sanitizeAstrBotGlobals(globals: GlobalConfig): { value: GlobalConfig; changed: boolean } {
	const value = deepClone(globals);
	let changed = false;
	if (value.bootstrap !== undefined) {
		delete value.bootstrap;
		changed = true;
	}
	if (value.defaults.ai.apiKey !== undefined) {
		delete value.defaults.ai.apiKey;
		changed = true;
	}
	return { value, changed };
}

async function readJsonOrInit<T>(
	path: string,
	makeDefault: () => T,
): Promise<{ value: unknown; existed: boolean }> {
	try {
		return { value: JSON.parse(await readFile(path, "utf8")) as unknown, existed: true };
	} catch (error) {
		if (!isNotFound(error)) throw error;
		const fresh = makeDefault();
		await atomicWriteJson(path, fresh);
		return { value: fresh, existed: false };
	}
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
	const tmpPath = `${path}.tmp.${suffix}`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmpPath, path);
}

async function backupLegacySubscriptions(source: string, destination: string): Promise<void> {
	await mkdir(dirname(destination), { recursive: true });
	try {
		await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
	} catch (error) {
		if (!isAlreadyExists(error)) throw error;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path, "utf8");
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

function upsertById<T extends { readonly id: string }>(items: readonly T[], item: T): T[] {
	const index = items.findIndex((entry) => entry.id === item.id);
	if (index < 0) return [...items, item];
	const next = [...items];
	next[index] = item;
	return next;
}

function deepClone<T>(value: T): T {
	return structuredClone(value);
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
