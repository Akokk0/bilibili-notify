import {
	BILIBILI_SOURCE_KEY,
	type IntegrationContext,
	type ServiceContext,
} from "@bilibili-notify/internal";
import { disposeThenClose, type IntegrationStore } from "../integration-store/store.js";
import type { CreateIntegrationContextOptions } from "../integrations/context.js";
import type { CookieJarHandle } from "../integrations/http.js";
import { type OpenedIntegration, openIntegration } from "../integrations/open.js";
import {
	createIntegrationSettings,
	type settingsReaderOptionsOf,
} from "../integrations/settings-reader.js";
import { defaultHeaders } from "./api/default-headers.js";
import { BILI_SOURCE_DESCRIPTOR } from "./source.js";

/** 单跳超时:无 timeout 时一个挂起连接(对端不回 / 半开 TCP)会让该请求永不结束。 */
const REQUEST_TIMEOUT_MS = 20_000;

/** B 站自己在 `secrets` 里的键:登录的续期令牌。 */
export const REFRESH_TOKEN_KEY = "refreshToken";

/**
 * B 站的上下文:公共那一面(`http`、`fetchImage`、`storeImage` 都在上面),加 cookie 罐的把手。
 * 来源上下文(`SourceContext`)建在它之上;`cookies` 这组口不对拓展开,所以只在这里(ADR-0025 决策 6)。
 * `http.` 前缀的键归宿主,B 站自己写不进去;罐子与令牌要「同进同退」,所以提交一律经 `cookies.commit`。
 *
 * 浏览器身份由宿主管(存着的、只升不降,没有才生成),终身不变 —— 同一 cookie 会话在不同 UA 间跳变是机器人特征。
 * **出站请求的 UA 只来自它**:HTTP 默认头、取 ticket、弹幕握手都读这一份,没有任何改 UA 的口子(ADR-0025 决策 7)。
 * 罐子与客户端都是**长期有效的同一个**:换号 / 登出 / -101 只调罐子的 `load()` / `clear()` 原地换内容。
 */
export interface BiliContext extends IntegrationContext {
	readonly cookies: CookieJarHandle;
}

export interface BiliContextHandle {
	readonly ctx: BiliContext;
	/** 先跑 `ctx.onDispose` 登记的收尾(后登记的先跑),再关存储把手。幂等。 */
	dispose(): Promise<void>;
}

export interface CreateBiliContextOptions {
	stores: Pick<IntegrationStore, "open">;
	/** 宿主的那一面:日志、可回收定时器、按段登记的关停钩子。 */
	serviceCtx: ServiceContext;
	/** 问题表的写口:B 站集成的上报记在 B 站这个键名下(与 B 站来源同一个报的人)。 */
	problems: CreateIntegrationContextOptions["problems"];
	/** 图库「集成在途」那一家的写口(`AppRuntime.transitImages`):`ctx.fetchImage` / `ctx.storeImage` 存的图经它。 */
	transitImages: CreateIntegrationContextOptions["transitImages"];
	/** 按集成键要设置的读法(入口造一次):B 站在这里挑自己的键,入口不写 B 站的键。 */
	settingsOf: ReturnType<typeof settingsReaderOptionsOf>;
}

/**
 * 给 B 站开一面上下文:开它的存储把手 → 造集成上下文 → 造请求客户端、罐子与身份。
 * 收尾次序:`dispose()` 先跑 `ctx.onDispose` 的钩子(调用方登记的「停 Api 与扫码流程」排在前面),再是最后一次
 * 存盘(`http.dispose()`),最后关把手;连接池不在这里收,放到关停的 `drain` 段(`client.dispose()` 会让在途的请求失败,
 * 而这里的收尾整个在 `stop` 段跑,那时抓图还没被等完)。任何一步建到一半失败,都不留开着的把手。
 */
export async function createBiliContext(
	opts: CreateBiliContextOptions,
): Promise<BiliContextHandle> {
	const { serviceCtx } = opts;
	const store = await opts.stores.open(BILIBILI_SOURCE_KEY);
	let opened: OpenedIntegration;
	try {
		opened = await openIntegration({
			stores: store,
			logger: serviceCtx.logger,
			stopReason: "BN 关停",
			problems: opts.problems,
			reporter: BILIBILI_SOURCE_KEY,
			label: () => BILI_SOURCE_DESCRIPTOR.label,
			rejectedProblemLevel: "error",
			transitImages: opts.transitImages,
			settings: createIntegrationSettings({
				...opts.settingsOf(BILIBILI_SOURCE_KEY),
				logger: serviceCtx.logger,
			}),
			httpOptions: {
				headers: defaultHeaders,
				timeoutMs: REQUEST_TIMEOUT_MS,
				setTimeout: (fn, ms) => serviceCtx.setTimeout(fn, ms),
			},
		});
	} catch (err) {
		// 建到一半失败:把手必须关上,不然下次 `open` 同一个键会抛「已经开着」。
		store.close();
		throw err;
	}
	// 连接池不随上下文收:`client.dispose()` 会让在途的请求失败,而上下文的收尾整个在 `stop` 段跑,那时抓图还没被等完。
	serviceCtx.onDispose(() => opened.http.client.dispose(), "drain");

	const ctx: BiliContext = { ...opened.handle.ctx, cookies: opened.http.cookies };
	let disposing: Promise<void> | undefined;
	return {
		ctx,
		dispose() {
			disposing ??= disposeThenClose(opened.handle, store);
			return disposing;
		},
	};
}
