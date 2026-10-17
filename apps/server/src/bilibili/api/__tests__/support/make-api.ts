import type { BrowserIdentity } from "@bilibili-notify/http";
import type { Disposable, Json, Logger, ServiceContext } from "@bilibili-notify/internal";
import { ignoredProblems } from "../../../../__tests__/support/ignored-problems";
import { inertSettingsOf } from "../../../../__tests__/support/inert-settings";
import { memoryStoreHandle } from "../../../../__tests__/support/memory-key-value-store";
import { HTTP_IDENTITY_KEY } from "../../../../integrations/http";
import type { NodeServiceContext } from "../../../../runtime/service-context";
import { createBiliContext, REFRESH_TOKEN_KEY } from "../../../context";
import { Api, type ApiHandlers } from "../../api";
import { ApiClient } from "../../api-client";

const silentLogger = (): Logger => ({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * 测试用的假时钟 + 宿主上下文:`setTimeout` / `setInterval` 不碰真定时器,`advance(ms)` 按到点先后依次跑;
 * `track` 登记的后台活收在 `tracked`;`onDispose` 的钩子收在 `disposers`(按段)。
 */
export function makeServiceContext(logger: Logger = silentLogger()) {
	let now = 0;
	let seq = 0;
	const pending = new Map<number, { at: number; fn: () => void; every?: number }>();
	const tracked: Promise<unknown>[] = [];
	const disposers: Array<{ fn: () => void | Promise<void>; phase: string | undefined }> = [];
	const schedule = (fn: () => void, ms: number, every?: number): Disposable => {
		const id = ++seq;
		pending.set(id, { at: now + ms, fn, every });
		return {
			dispose() {
				pending.delete(id);
			},
		};
	};
	const serviceCtx: ServiceContext & Pick<NodeServiceContext, "forSubsystem"> = {
		// 假的子上下文就是它自己:日志器、定时器、收尾钩子都共用(要区分子上下文的用例自己造)。
		forSubsystem: () => serviceCtx,
		logger,
		signal: new AbortController().signal,
		setTimeout: (fn, ms) => schedule(fn, ms),
		setInterval: (fn, ms) => schedule(fn, ms, ms),
		onDispose: (fn, phase) => {
			disposers.push({ fn, phase });
		},
		track: (task) => {
			tracked.push(task);
		},
	};
	return {
		serviceCtx,
		logger,
		tracked,
		disposers,
		/** 现在还挂着几个定时器(超时 + 间隔)。 */
		pendingTimers: () => pending.size,
		/** 往前走 `ms` 毫秒,到点的按先后依次跑(间隔的会重新排)。 */
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				let next: [number, { at: number; fn: () => void; every?: number }] | undefined;
				for (const entry of pending) {
					if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at))
						next = entry;
				}
				if (!next) break;
				const [id, timer] = next;
				now = timer.at;
				if (timer.every === undefined) pending.delete(id);
				else timer.at = now + timer.every;
				timer.fn();
			}
			now = target;
		},
	};
}

export interface MakeApiOptions {
	/** 默认是静默 logger + 假时钟的宿主上下文;要看日志 / `track` / 时钟的用例自己给(`makeServiceContext`)。 */
	serviceCtx?: ServiceContext;
	callbacks?: ApiHandlers;
	/** 已知身份:线上的 UA 与 sec-ch-ua 就是它(默认现生成一份)。 */
	identity?: BrowserIdentity;
	/** 存储里已经有的 `secrets`(`http.cookies` 是整段 JSON 字符串,`refreshToken` 是字符串)。 */
	secrets?: Record<string, Json>;
	/** 存储把手的按值打码登记口;不给就不登记。 */
	redact?: (kind: string, values: Iterable<string>) => void;
}

/**
 * 十来个 `Api` 测试共用的造法:拼一个**真的** `BiliContext`(与生产同一个 `createBiliContext`、同一个
 * `createIntegrationHttp`,存储把手是内存版 —— 包的是真的 `createKeyValueStores`,规矩与生产同一份,只有
 * 落盘换成记一笔),再交给 `Api`。并把东西原样交回 —— 测试要看线上的头、罐子的内容、盘上会写成什么,
 * 直接用这些,不用去掏 `Api` 的私有字段。
 *
 * - `secrets.persists` 是每次落盘时那一袋的拷贝(按先后):数「落了几次」、看某一刻两个键同时是什么。
 * - `client` 是用**同一个** `HttpClient` 另外包出来的 `ApiClient`(它本来就是薄包),给要直接打 `get` /
 *   `postForm` 看线上请求的用例;它与 `api` 里自己持的那个共用底下的客户端与罐子。
 */
export async function makeApi(options: MakeApiOptions = {}) {
	const host = options.serviceCtx ? undefined : makeServiceContext();
	const serviceCtx = options.serviceCtx ?? (host as { serviceCtx: ServiceContext }).serviceCtx;
	const { handle, secrets, state, isClosed } = memoryStoreHandle(
		{
			secrets: options.secrets,
			state: options.identity ? { [HTTP_IDENTITY_KEY]: { ...options.identity } } : undefined,
		},
		options.redact,
	);
	const context = await createBiliContext({
		stores: { open: async () => handle },
		serviceCtx,
		problems: ignoredProblems,
		settingsOf: inertSettingsOf,
	});
	const { ctx } = context;
	const api = new Api({ serviceCtx, ctx, callbacks: options.callbacks ?? {} });
	const client = new ApiClient({ http: ctx.http });
	const identity =
		options.identity ??
		(state.stores.host.get<Json>(HTTP_IDENTITY_KEY) as unknown as BrowserIdentity);
	/**
	 * 登录一个会话:把 cookie 放进罐子(`cookiesJson` 是整段 JSON)、有令牌就写进 `secrets`,再 `resumeStoredLogin()` ——
	 * 与开机、恢复备份同一条路(宿主先装好罐子,`Api` 再接着做剩下的)。
	 */
	async function loadSession(cookiesJson: string, refreshToken?: string): Promise<void> {
		ctx.cookies.jar.load(JSON.parse(cookiesJson));
		if (refreshToken !== undefined) await ctx.secrets.set(REFRESH_TOKEN_KEY, refreshToken);
		await api.resumeStoredLogin();
	}
	return {
		api,
		loadSession,
		ctx,
		jar: ctx.cookies.jar,
		identity,
		http: ctx.http,
		client,
		context,
		secrets,
		state,
		host,
		isClosed,
	};
}
