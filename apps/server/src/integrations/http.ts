import {
	type BrowserIdentity,
	type Cookie,
	CookieJar,
	generateBrowserIdentity,
	HttpClient,
	upgradeBrowserIdentity,
} from "@bilibili-notify/http";
import {
	type Disposable,
	fail,
	type Json,
	type KeyValueOp,
	type Logger,
	type Result,
} from "@bilibili-notify/internal";
import type { IntegrationStoreHandle } from "../integration-store/store.js";
import { errorMessageOf } from "../util/error-message.js";

/**
 * 宿主替一个集成造请求客户端、cookie 罐、浏览器身份,并管罐子的存盘(ADR-0025 决策 6、9、10)。
 * 宿主内部的工厂,不是契约;这一片只有 B 站一个调用方,拓展的随 3b。
 *
 * - 身份:读存的 → 按版本区间只升不降 → 没有就生成 → 写回 `state` 的 `http.identity`。
 * - 罐子:内容由宿主自动存进 `secrets` 的 `http.cookies`。**从第一笔没存的变化起攒 {@link COOKIE_SAVE_DELAY_MS},
 *   后面的变化不顺延。**
 * - 闸:拿着闸的人没放之前罐子不自动存(续期那一串进行中不存中间状态)。闸只管「自动存」;`commit` 有没有闸都存。
 *   闸是拿的人自己放:**提交成功才放,或者那一串根本没走到会改罐子的那一步才放**,不是「跑完就放」。
 * - 提交:「集成自己的键的改动 + 罐子此刻的内容」合成**同一次原子写**(`IntegrationStoreHandle.commitSecrets`)。
 */

/** 攒多久再存:从第一笔没存的变化起算,后面的变化不顺延。 */
export const COOKIE_SAVE_DELAY_MS = 2_000;
export const HTTP_COOKIES_KEY = "http.cookies";
export const HTTP_IDENTITY_KEY = "http.identity";

export interface CreateIntegrationHttpOptions {
	/** 这个集成的存储把手(只用宿主那一面)。 */
	stores: IntegrationStoreHandle;
	logger: Logger;
	/** 集成特有的默认头:拿到身份再给(头里要用身份的值,头序也归集成定)。 */
	headers?: (identity: BrowserIdentity) => Record<string, string>;
	timeoutMs?: number;
	/** 攒多久再存;默认 {@link COOKIE_SAVE_DELAY_MS}。 */
	saveDelayMs?: number;
	/** 可回收的定时器(宿主的 `serviceCtx.setTimeout`)。 */
	setTimeout: (fn: () => void, ms: number) => Disposable;
}

/** 宿主替集成管着的 cookie 罐:罐子本体,加它存盘的闸。 */
export interface CookieJarHandle {
	readonly jar: CookieJar;
	/** 拿一道闸:把手没放之前,罐子的变化不自动存。可以同时有好几道,全放了才恢复。 */
	hold(): Disposable;
	/**
	 * 现在就把罐子此刻的内容存下,连同这几项这个集成自己的 `secrets` 改动,**一次原子写**。
	 * 有没有闸都存;不动任何闸。`ops` 里不许有 `http.` 开头的键(回 `invalid`、盘上不变)。
	 */
	commit(ops?: readonly KeyValueOp[]): Promise<Result>;
	/** 罐子被宿主整罐换了(恢复备份)之后叫,此时罐里已是新内容。 */
	onRestored(fn: () => void | Promise<void>): Disposable;
}

export interface IntegrationHttpHandle {
	readonly client: HttpClient;
	readonly cookies: CookieJarHandle;
	/** 这个集成用的身份(存着的、升过的,或刚生成的)。 */
	readonly identity: BrowserIdentity;
	/**
	 * 集成停下时:不再听罐子;闸开着且有没存的就存最后一次。**不收客户端的连接池** —— 那一步由建它的人
	 * 放到关停的 `drain` 段(`client.dispose()` 会让在途的请求失败)。幂等。
	 */
	dispose(): Promise<void>;
}

function isBrowserIdentity(value: unknown): value is BrowserIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.userAgent === "string" &&
		typeof v.secChUa === "string" &&
		typeof v.secChUaMobile === "string" &&
		typeof v.secChUaPlatform === "string"
	);
}

/** 读存着的身份,只升不降;没有或形状坏了就生成;与存着的不是同一份就写回(写失败记 warn、照用内存里这份)。 */
async function resolveIdentity(
	stores: IntegrationStoreHandle,
	logger: Logger,
): Promise<BrowserIdentity> {
	const stored: unknown = stores.hostState.get<Json>(HTTP_IDENTITY_KEY);
	const identity = isBrowserIdentity(stored)
		? upgradeBrowserIdentity(stored)
		: generateBrowserIdentity();
	if (identity === stored) return identity;
	const written = await stores.hostState.set(HTTP_IDENTITY_KEY, { ...identity });
	if (!written.ok) {
		logger.warn(
			`[integrations/http] 浏览器身份写不进存储,这次先用内存里的,下次开机再试:${written.message}`,
		);
	}
	return identity;
}

export async function createIntegrationHttp(
	opts: CreateIntegrationHttpOptions,
): Promise<IntegrationHttpHandle> {
	const { stores, logger } = opts;
	const saveDelayMs = opts.saveDelayMs ?? COOKIE_SAVE_DELAY_MS;

	const identity = await resolveIdentity(stores, logger);

	const jar = new CookieJar();
	/** 宿主自己装罐(开机、恢复备份)时立着:装罐触发的 `onChange` 不记 `dirty`。 */
	let loading = false;
	/** 罐子自上次落盘后变没变。 */
	let dirty = false;
	/** 没放的闸有几道。 */
	let holds = 0;
	/** 攒着的那一下。 */
	let timer: Disposable | undefined;
	let disposed = false;
	let disposing: Promise<void> | undefined;
	const restoredHooks: Array<() => void | Promise<void>> = [];

	/** 把存着的 `http.cookies` 装进罐子(没有就清空),包在 `loading` 里。 */
	function loadJarFromStore(): void {
		loading = true;
		try {
			const raw: unknown = stores.hostSecrets.get<Json>(HTTP_COOKIES_KEY);
			if (raw === undefined) {
				jar.clear();
				return;
			}
			// 解不开、不是数组、数组里有坏元素(`jar.load` 会抛)都是同一种结局:记 error、按空罐起,不挡开机。
			try {
				const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
				if (!Array.isArray(parsed)) throw new Error("不是数组");
				jar.load(parsed as Cookie[]);
			} catch (err) {
				logger.error(`[integrations/http] 存着的 cookie 读不进(${errorMessageOf(err)}),按空罐起`);
				jar.clear();
			}
		} finally {
			loading = false;
		}
	}

	function clearTimer(): void {
		timer?.dispose();
		timer = undefined;
	}

	function startTimer(): void {
		if (holds > 0 || timer !== undefined) return;
		timer = opts.setTimeout(() => {
			timer = undefined;
			// 到点时闸还没放:什么都不做,等闸放。
			if (disposed || holds > 0) return;
			void save();
		}, saveDelayMs);
	}

	/** 罐子此刻的内容,变成「写 / 删 `http.cookies`」:空罐删,不存 `"[]"`。进了写道才调。 */
	function jarOps(): KeyValueOp[] {
		const cookies = jar.serialize();
		return cookies.length === 0
			? [{ kind: "delete", key: HTTP_COOKIES_KEY }]
			: [{ kind: "set", key: HTTP_COOKIES_KEY, value: JSON.stringify(cookies) }];
	}

	/** 罐子此刻的内容 + 集成自己的改动,一次写。失败把 `dirty` 置回。 */
	async function writeJar(ops: readonly KeyValueOp[]): Promise<Result> {
		dirty = false;
		const result = await stores.commitSecrets(jarOps, ops);
		if (!result.ok) dirty = true;
		return result;
	}

	/** 自动存:失败记 error,不自己重试,等下一次变化或下一次提交。 */
	async function save(): Promise<void> {
		const result = await writeJar([]);
		if (!result.ok) {
			logger.error(`[integrations/http] cookie 存盘失败(下次变化再试):${result.message}`);
		}
	}

	// 先订阅再装罐,故意:开机这一次装罐不回写靠的是 `loading` 标志,不靠订阅的时机。
	const unsubscribe = jar.onChange(() => {
		if (loading) return;
		dirty = true;
		startTimer();
	});
	loadJarFromStore();

	const replacedSubscription = stores.onSecretsReplaced(async () => {
		loadJarFromStore();
		for (const fn of [...restoredHooks]) {
			try {
				await fn();
			} catch (err) {
				logger.error(`[integrations/http] 登记的「罐子被恢复了」回调抛了:${errorMessageOf(err)}`);
			}
		}
	});

	const client = new HttpClient({
		jar,
		identity,
		headers: opts.headers?.(identity),
		timeoutMs: opts.timeoutMs,
	});

	const cookies: CookieJarHandle = {
		jar,
		hold() {
			holds += 1;
			let released = false;
			return {
				dispose() {
					if (released) return;
					released = true;
					holds -= 1;
					// 最后一道放掉:有没存的就起定时器(不立刻存,照样攒一下)。
					if (holds === 0 && dirty && !disposed) startTimer();
				},
			};
		},
		async commit(ops = []) {
			if (disposed) return fail("unavailable", "集成已停下,cookie 不再存盘");
			clearTimer();
			return writeJar(ops);
		},
		onRestored(fn) {
			restoredHooks.push(fn);
			return {
				dispose() {
					const at = restoredHooks.indexOf(fn);
					if (at >= 0) restoredHooks.splice(at, 1);
				},
			};
		},
	};

	function dispose(): Promise<void> {
		disposing ??= (async () => {
			disposed = true;
			unsubscribe();
			replacedSubscription.dispose();
			clearTimer();
			// 有闸说明有一串还没提交的登录态:不存中间状态。
			if (holds === 0 && dirty) await save();
		})();
		return disposing;
	}

	return { client, cookies, identity, dispose };
}
