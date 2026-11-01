import type {
	CreatorCandidateView,
	CreatorsResponse,
	SourceAuthResponse,
	SourceEntry,
	SourcesResponse,
} from "@bilibili-notify/contract";
import {
	type CreatorCandidate,
	type Failure,
	fail,
	type Result,
	type SourceAuth,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import { manifestSourceDescriptor } from "../extensions/extension-source.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import { t } from "../i18n/index.js";
import { imageRefDataUrl } from "../images/image-data-url.js";
import type { ImageStore } from "../images/image-store.js";
import type { SourceView } from "../subscriptions/registry.js";
import { createSourceStatusReader } from "../subscriptions/source-status.js";
import { errorMessageOf } from "../util/error-message.js";
import { ENGINES_NOT_READY_MESSAGE, respondFailure } from "./respond-failure.js";
import type { RouteDeps } from "./types.js";

/** 搜人那句话最多几个字(输入框里粘一段长链接也够)。 */
export const CREATOR_QUERY_MAX_CHARS = 1024;

/**
 * 搜人的 `q`:首尾空白去掉(粘链接时常带进来),除此之外一个字不动 —— 怎么解读是来源的事。话在出字那一刻取
 * (zod 的 `error` 回调),换了语言不用重建路由。
 */
const CreatorQuerySchema = z
	.string({ error: () => t("sources.creators.queryMissing") })
	.trim()
	.min(1, { error: () => t("sources.creators.queryBlank") })
	.max(CREATOR_QUERY_MAX_CHARS, {
		error: () => t("sources.creators.queryTooLong", { max: CREATOR_QUERY_MAX_CHARS }),
	});

export interface SourcesRouteOptions {
	/** 装载器那张表,现读:拓展的来源照清单列,跑没跑都有。没接装载器的构建是空表。 */
	extensions: () => readonly ExtensionEntry[];
	/** 等装载器头一轮扫完再答,免得开机那一刻拓展的来源全缺。没接装载器的构建没有。 */
	settle?: () => Promise<void>;
	/**
	 * 在来源里搜人(推送链路的 `searchCreators`:与女仆搜人、取资料、查直播状态共用同一道来源串行闸与超时)。
	 * 热读:链路还没挂上就是 `undefined`,搜人口回 `unavailable`。不给 = 搜人口一直 `unavailable`。
	 */
	searchCreators?: (
		sourceKey: string,
		query: string,
	) => Promise<Result<{ candidates: CreatorCandidate[] }> | undefined>;
	/** 候选头像的图库引用在这里读回字节、拼成 data URL 交给面板;不给 = 候选都不带头像。 */
	images?: Pick<ImageStore, "read">;
}

/** 来源实现了哪些可选成员,宿主自己看,不让来源自报。 */
function hasOf(view: SourceView): NonNullable<SourceEntry["has"]> {
	return {
		auth: view.auth !== undefined,
		liveStatus: view.fetchLiveStatus !== undefined,
		preview: view.fetchPreview !== undefined,
	};
}

/**
 * `/api/sources` — 来源表与来源的登录口。
 *
 * - `GET    /:sourceKey/creators?q=` 新建订阅时在这个来源里搜人(4-15,所有来源同一口);
 * - `GET    /` 来源表(ADR-0027 决策 6):每个来源一条 `{ key, descriptor, status, has?, failure? }`。两张表合起来:登记表里
 *   不是拓展的取登记时交的描述符,启动失败释放键后仍保留宿主视图;拓展一律取装载器那份清单 —— 停用、没起来的也列(不带 `has`),
 *   在跑的也不取登记时那份(那份冻在登记那一刻的语言上,装载器那份按此刻的语言盖好译文);
 * - `GET    /:sourceKey/auth` 读状态与账号(登录口是 `Source.auth`,ADR-0021 决策 45);
 * - `POST   /:sourceKey/auth` 发起扫码登录(已经在等扫码时回 `conflict`);
 * - `DELETE /:sourceKey/auth` 退出登录。
 *
 * 路由直接问来源登记表,不持有状态:来源不在回 `unavailable`、没有登录口回 `unsupported`;实现抛了算 bug,
 * 记一行 error(只记抛出来的话)、回 `unavailable`。回包逐格挑,里面没有 cookie 与令牌。
 *
 * 拒绝重复发起放在这里而不是实现里:`confirming` 同时表示「开机还没确认」,那时必须能发起扫码,路由只看得到
 * `AuthState`、分不出两种情况,所以只在 `awaiting-scan` 时拦;`confirming` 时放行并换一张新码。
 */
export function createSourcesRoute(deps: RouteDeps, opts: SourcesRouteOptions): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;
	const registry = deps.runtime.sourceRegistry;
	const resolveAvatar = opts.images ? imageRefDataUrl(opts.images) : undefined;

	app.get("/", async (c) => {
		await opts.settle?.();
		const extensions = opts.extensions();
		const extensionIds = new Set(extensions.map((entry) => entry.id));
		const sources: SourceEntry[] = [];
		const status = createSourceStatusReader({ sources: registry, extensions: () => extensions });
		for (const run of registry.listRunViews()) {
			const view = registry.get(run.sourceKey);
			if (extensionIds.has(run.sourceKey)) continue;
			sources.push({
				key: run.sourceKey,
				descriptor: run.descriptor,
				status: status.status(run.sourceKey),
				...(run.failure ? { failure: run.failure } : {}),
				...(view ? { has: hasOf(view) } : {}),
			});
		}
		for (const entry of extensions) {
			const descriptor = entry.manifest && manifestSourceDescriptor(entry.manifest);
			if (!descriptor) continue;
			const view = registry.get(entry.id);
			sources.push({
				key: entry.id,
				descriptor,
				status: status.status(entry.id),
				...(entry.detail ? { failure: fail("unavailable", entry.detail) } : {}),
				...(view ? { has: hasOf(view) } : {}),
			});
		}
		return c.json({ sources } satisfies SourcesResponse);
	});

	/**
	 * 搜人(ADR-0019 决策 11 / 52):输入框里那句原样交给来源,回候选。🔴 只在 `/api/*` 底下、吃面板会话鉴权 ——
	 * 来源拿它去问平台用的是主人的登录态,挂到鉴权外就是谁都能借主人的号去平台上查人。
	 *
	 * 来源回的失败码与话原样回(风控 429、没登录 403、超时 504、来源不在 404),不折成「查无此人」。
	 * 走到这里的 `invalid` 只会是来源交回的候选不合规矩(`q` 在上面就核过了):请求本身没错,是对端交回了
	 * 不合格的东西,所以显式回 502,不回怪发请求那头的 400 —— 并成一种,主人与拓展作者都不知道该找谁。
	 */
	app.get("/:sourceKey/creators", async (c) => {
		const query = CreatorQuerySchema.safeParse(c.req.query("q"));
		if (!query.success) {
			return respondFailure(c, fail("invalid", query.error.issues[0]?.message ?? ""));
		}
		const found = await opts.searchCreators?.(c.req.param("sourceKey"), query.data);
		if (!found) return respondFailure(c, fail("unavailable", ENGINES_NOT_READY_MESSAGE));
		if (!found.ok) return respondFailure(c, found, found.code === "invalid" ? 502 : undefined);
		const body: CreatorsResponse = {
			candidates: await Promise.all(found.candidates.map(candidateView)),
		};
		return c.json(body);
	});

	/**
	 * 核心的候选 → 面板看的候选:头像的图库引用读回字节、拼成 data URL;读不到(引用已被清扫、读盘出错)
	 * 就缺这一格,一个人的头像坏了不拖累整张候选表。
	 */
	async function candidateView(candidate: CreatorCandidate): Promise<CreatorCandidateView> {
		const avatarUrl =
			candidate.avatar === undefined ? undefined : await resolveAvatar?.(candidate.avatar);
		return {
			externalId: candidate.externalId,
			name: candidate.name,
			...(avatarUrl === undefined ? {} : { avatarUrl }),
			...(candidate.bio === undefined ? {} : { bio: candidate.bio }),
			...(candidate.followers === undefined ? {} : { followers: candidate.followers }),
		};
	}

	/** 键 → 来源的登录口;不成立就地回失败。 */
	function authOf(sourceKey: string): { auth: SourceAuth } | { failure: Failure } {
		const view = deps.runtime.sourceRegistry.get(sourceKey);
		if (!view) return { failure: fail("unavailable", t("sources.notRunning")) };
		if (!view.auth) return { failure: fail("unsupported", t("sources.auth.unsupported")) };
		return { auth: view.auth };
	}

	function responseOf(auth: SourceAuth): SourceAuthResponse {
		const account = auth.account?.();
		if (!account) return { state: auth.state() };
		// 逐格挑:实现多带的格不外泄。
		return {
			state: auth.state(),
			account:
				account.avatar === undefined
					? { name: account.name }
					: { name: account.name, avatar: account.avatar },
		};
	}

	app.get("/:sourceKey/auth", (c) => {
		const found = authOf(c.req.param("sourceKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		try {
			return c.json(responseOf(found.auth));
		} catch (err) {
			log.error(`GET /api/sources/:sourceKey/auth threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", t("sources.auth.readFailed")));
		}
	});

	app.post("/:sourceKey/auth", async (c) => {
		const found = authOf(c.req.param("sourceKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		try {
			if (found.auth.state().status === "awaiting-scan") {
				return respondFailure(c, fail("conflict", t("sources.auth.alreadyScanning")));
			}
			const begun = await found.auth.beginLogin();
			if (!begun.ok) return respondFailure(c, begun);
			return c.json(responseOf(found.auth));
		} catch (err) {
			log.error(`POST /api/sources/:sourceKey/auth threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", t("sources.auth.beginFailed")));
		}
	});

	app.delete("/:sourceKey/auth", async (c) => {
		const found = authOf(c.req.param("sourceKey"));
		if ("failure" in found) return respondFailure(c, found.failure);
		try {
			const out = await found.auth.logout();
			if (!out.ok) return respondFailure(c, out);
			return c.json(responseOf(found.auth));
		} catch (err) {
			log.error(`DELETE /api/sources/:sourceKey/auth threw: ${errorMessageOf(err)}`);
			return respondFailure(c, fail("unavailable", t("sources.auth.logoutFailed")));
		}
	});

	return app;
}
