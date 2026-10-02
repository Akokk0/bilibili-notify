import { ensureFollowed } from "@bilibili-notify/api";
import type { SubscriptionDTO } from "@bilibili-notify/contract";
import {
	BILIBILI_SOURCE_KEY,
	type CachedProfile,
	type Failure,
	fail,
	formatZodIssues,
	issuesFromZod,
	type Subscription,
	SubscriptionSchema,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import { decodeSubscriptionAvatar } from "../runtime/sub-avatar-store.js";
import { readJsonBody, readJsonObject } from "./request-body.js";
import { respondFailure } from "./respond-failure.js";
import { checkApprovalReachable } from "./roast-approval-guard.js";
import { createSubscriptionTagsRoute } from "./subscription-tags.js";
import type { RouteDeps } from "./types.js";

/** B 站接口没就绪(启动中 / 没登录,引擎还没挂上)时,查人的两个接口回的那一句。 */
const BILI_API_NOT_READY_MESSAGE = "B 站 API 尚未就绪，请等登录完成或稍后再试";

// DTO 形状在 @bilibili-notify/contract(web 同源消费):持久化 Subscription +
// SubRuntimeStore join 回来的外置运行时字段。

export interface SubsRouteOptions {
	/**
	 * 装了哪些拓展(装载器那份名单,**现取** —— 面板刚装上的也算)。新建拓展订阅时核「它是不是
	 * 订阅源」。不给 = 一个都没装:新建拓展订阅一律 400。
	 */
	extensions?: () => readonly ExtensionEntry[];
}

/** 头像那一口的缓存头:地址里的 `v` 随内容变,所以同一个地址的字节永远不变。 */
const AVATAR_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * 新建拓展订阅时随订阅一起交的资料 —— 面板挑中的那个解析门候选(决策 11 / 52)。
 *
 * 只收 `name` / `avatar` / `fans`:签名没人报过,刷新时间是服务端说了算,别的键一律丢。
 * `avatar` 要么不给 / 空串(没有),要么是位图 data URL,魔数另核(见 `decodeSubscriptionAvatar`)。
 */
const CreateProfileSchema = z.object({
	name: z
		.string({ error: "名字要是字符串" })
		.min(1, "名字不能是空串")
		.max(128, "名字不能超过 128 字"),
	avatar: z.string({ error: "头像要是字符串" }).optional(),
	fans: z
		.number({ error: "粉丝数要是数字" })
		.int("粉丝数要是整数")
		.nonnegative("粉丝数不能是负的")
		.optional(),
});
const CreateProfileBodySchema = z.object({
	cachedProfile: CreateProfileSchema.optional(),
});

/**
 * `/api/subs` — CRUD on the Subscription[] list.
 *
 * Body shapes:
 * - POST /api/subs  → full Subscription (validated by SubscriptionSchema in store)
 * - PATCH /api/subs/:id → DeepPartial<Subscription>; merged onto current then validated
 *
 * We deliberately require the full Subscription on POST rather than letting the
 * server fill in defaults — `makeEmptySubscription({id, identity})` exists in
 * `@bilibili-notify/internal` and clients (the dashboard) call that locally.
 * Keeps the server stateless about defaults.
 *
 * 订阅只有一种形状,订的是谁看 `identity`(ADR-0021 决策 14)。**新建拓展的订阅**(`identity.sourceKey`
 * 是拓展 id)由宿主把关(见 {@link createExtensionSubscription}):得是装着的 v2 订阅源(不要求在跑,
 * ADR-0019 决策 10),同一身份只许一条(决策 50);面板从解析门挑中的候选放进 `cachedProfile` 一起交,
 * 头像存成文件(决策 49)。**新建 B 站的订阅**核外部 id 是不是数字 uid。已经存在的订阅可以整份 POST 回来改
 * (面板的启用开关就是这么发的),身份改不动(store 拒)。关注、B 站资料种子、查 UID / 搜名字都只对 B 站。
 *
 * 失败一律经 `respondFailure`(ADR-0026):store 拒收时抛的 `ConfigValidationError` 自带标准码
 * (不合规 400、没这一条 404),路由按码回、不嗅文案;查 UID / 搜名字里 B 站自己的数字码只放
 * `upstreamCode`,不占 `code`(风控 / 未登录的分类留到 3a 的 `searchCreators`,这里不扩大)。
 */
export function createSubsRoute(deps: RouteDeps, opts: SubsRouteOptions = {}): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/** Join the externalized runtime fields back onto a config Subscription. */
	function toDTO(sub: Subscription): SubscriptionDTO {
		const rt = deps.runtime.subRuntimeStore.get(sub.id);
		const runtime = { cachedProfile: rt?.cachedProfile };
		// 关注状态只对 B 站订阅有意义(动态走 B 站的关注流);别的来源这两格缺着。
		if (subscriptionIdentityOf(sub).sourceKey !== BILIBILI_SOURCE_KEY)
			return { ...sub, ...runtime };
		return { ...sub, ...runtime, followed: rt?.followed, followError: rt?.followError };
	}

	/**
	 * 关注该 UP,并把结果记进 SubRuntimeStore。
	 *
	 * 动态走 `feed/all`(关注流)—— 没关注就一条动态都收不到,所以这不是可选的润色,
	 * 是订阅能否工作的前提。**失败不阻断创建**(主人拍板):订阅记录照留,但把「未关注」
	 * 如实写进 runtime 状态,前端在订阅卡片上持续显示,而不是弹一个转瞬即逝的 toast。
	 * 启动时的 follow-sync 会再试一次,所以未登录 / 临时风控都能自愈。
	 */
	async function followUp(sub: Subscription): Promise<void> {
		const engines = deps.runtime.engines;
		if (!engines) return; // 启动中 / 未登录 —— 交给启动时的 follow-sync 兜底。
		const uid = subscriptionIdentityOf(sub).externalId;
		const outcome = await ensureFollowed(engines.api, uid);
		if (!outcome.ok) {
			log.warn(
				`[sub] 关注 UID ${uid} 失败(code=${outcome.code}): ${outcome.message} —— 该订阅收不到动态`,
			);
		}
		await deps.runtime.subRuntimeStore.patch(sub.id, {
			followed: outcome.ok,
			followError: outcome.ok ? undefined : outcome.message || `code=${outcome.code}`,
		});
	}

	/**
	 * Server-owned cachedProfile seed on create. cachedProfile is a B-station
	 * mirror owned by the server (FansPoller), not client-supplied display data
	 * — so on a brand-new sub we fetch it once ourselves instead of trusting /
	 * peeling whatever the frontend POSTed (Zod strips it anyway). Best-effort:
	 * any failure just leaves it for the first FansPoller tick (~2min). Skipped
	 * when a cachedProfile already exists (re-POST / edit) to bound the call.
	 */
	async function seedCachedProfile(sub: Subscription): Promise<void> {
		if (deps.runtime.subRuntimeStore.get(sub.id)?.cachedProfile) return;
		const engines = deps.runtime.engines;
		if (!engines) return;
		const uid = subscriptionIdentityOf(sub).externalId;
		try {
			const res = await engines.api.getUserCardInfo(uid);
			if (res.code !== 0 || !res.data?.card) return;
			const card = res.data.card;
			const cachedProfile: CachedProfile = {
				name: card.name ?? uid,
				avatar: card.face ?? "",
				sign: card.sign ?? "",
				fans: typeof card.fans === "number" && card.fans >= 0 ? card.fans : 0,
				lastRefreshedAt: new Date().toISOString(),
			};
			await deps.runtime.subRuntimeStore.patch(sub.id, { cachedProfile });
		} catch (err) {
			log.warn(`/api/subs seed cachedProfile uid=${uid} failed: ${String(err)}`);
		}
	}

	/**
	 * 新建一条拓展订阅(ADR-0019 决策 9 / 10 / 49 / 50)。**能核的先全核完再落盘**:订阅的形状 →
	 * 带来的资料(连头像的魔数)→ 它是不是装着的订阅源;判重在 upsert 里(store 那道闸,B 站来源的也过它)。
	 * 都过了才存头像文件、种资料缓存 —— 这两步是展示用的缓存,失败只记一句,不让新建失败(同 B 站的资料种子)。
	 */
	async function createExtensionSubscription(
		c: Context,
		body: Record<string, unknown>,
	): Promise<Response> {
		const { cachedProfile: rawProfile, ...subBody } = body;
		const parsed = SubscriptionSchema.safeParse(subBody);
		if (!parsed.success) {
			// 与 store 拒收时同一个形状(下面 upsert 失败走的也是它)。
			return respondFailure(
				c,
				ConfigValidationError.fromZod("subscriptions", parsed.error).toFailure(),
			);
		}
		const sub = parsed.data;
		const identity = subscriptionIdentityOf(sub);

		const profile = CreateProfileBodySchema.safeParse({ cachedProfile: rawProfile });
		if (!profile.success) {
			return respondFailure(
				c,
				fail("invalid", `随订阅交来的资料不合规：${formatZodIssues(profile.error).join("；")}`, {
					issues: issuesFromZod(profile.error),
				}),
			);
		}
		const seed = profile.data.cachedProfile;
		// 空串就是「没有头像」,与 CachedProfile 自己的口径一样。
		const avatarDataUrl = seed?.avatar || undefined;
		if (avatarDataUrl) {
			const decoded = decodeSubscriptionAvatar(avatarDataUrl);
			if (!decoded.ok) {
				return respondFailure(
					c,
					fail("invalid", `随订阅交来的头像不合规：${decoded.reason}`, {
						issues: [{ path: ["cachedProfile", "avatar"], message: decoded.reason }],
					}),
				);
			}
		}

		const refusal = subscriptionSourceRefusal(identity.sourceKey, opts.extensions?.() ?? []);
		if (refusal) return respondFailure(c, refusal);

		try {
			// 形状由 schema 核、同一个人订第二条(身份判重)由 store 拒 —— 都在写盘那一层,两种来源同一道。
			await deps.store.upsertSubscription(subBody as never);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("POST /api/subs (extension) failed", err);
			throw err;
		}
		if (seed) await seedExtensionProfile(sub, seed, avatarDataUrl);
		return c.json(deps.store.getSubscriptions().map(toDTO), 200);
	}

	/**
	 * 拿面板挑中的那个候选种资料缓存。头像先存成文件(决策 49),资料里只放它的同源地址;存不下来
	 * 就先不带头像,等 ④ 的「报资料更新」再来。
	 */
	async function seedExtensionProfile(
		sub: Subscription,
		seed: z.infer<typeof CreateProfileSchema>,
		avatarDataUrl: string | undefined,
	): Promise<void> {
		let avatar = "";
		if (avatarDataUrl) {
			try {
				avatar = await deps.runtime.subAvatarStore.write(sub.id, avatarDataUrl);
			} catch (err) {
				log.warn(`[sub] 拓展订阅 ${sub.id} 的头像没存下来,资料先不带头像: ${String(err)}`);
			}
		}
		const cachedProfile: CachedProfile = {
			name: seed.name,
			avatar,
			sign: "",
			// 不知道就不写 —— 写 0 是在面板上印一句假话。
			...(seed.fans === undefined ? {} : { fans: seed.fans }),
			lastRefreshedAt: new Date().toISOString(),
		};
		try {
			await deps.runtime.subRuntimeStore.patch(sub.id, { cachedProfile });
		} catch (err) {
			log.warn(`[sub] 拓展订阅 ${sub.id} 的资料缓存没写进去: ${String(err)}`);
		}
	}

	app.get("/", (c) => c.json(deps.store.getSubscriptions().map(toDTO)));

	// 标签表(ADR-0034):和 `/search`、`/lookup` 一样是这一摊底下的固定子路径。这一摊没有 `GET /:id` / `PUT /:id`,
	// 撞不上;挂在 `/:id` 那几条前面,以后真加了也先认它。
	app.route("/tags", createSubscriptionTagsRoute(deps));

	/**
	 * 拓展订阅的头像(ADR-0019 决策 49)。在 `/api/*` 底下,吃同一道面板鉴权。地址里的 `v` 是内容
	 * 摘要,换了图地址就变 —— 所以同一个地址可以放心让浏览器永久缓存。
	 */
	app.get("/:id/avatar", async (c) => {
		const id = c.req.param("id");
		if (!z.uuid().safeParse(id).success) {
			return respondFailure(c, fail("invalid", "订阅 id 要是 uuid"));
		}
		const avatar = await deps.runtime.subAvatarStore.read(id);
		if (!avatar) return respondFailure(c, fail("not_found", "这条订阅没有头像"));
		return c.body(new Uint8Array(avatar.bytes), 200, {
			"Content-Type": avatar.contentType,
			// app 那头给整片 /api 挂过一道;这里再写一遍:这口发的是拓展交来的字节,不依赖挂在哪。
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": AVATAR_CACHE_CONTROL,
		});
	});

	/**
	 * Pre-flight UID resolution for the "add UP" dialog. Hits B-station's user
	 * card endpoint via BilibiliAPI; on success returns the four fields the
	 * client wants to show in confirmation (and writes back into
	 * Subscription.cachedProfile when the user clicks add).
	 *
	 * Errors are mapped to client-friendly statuses so the dialog can render
	 * a helpful message instead of a generic 500: 404 means B-station said
	 * the UID doesn't exist; 503 means we couldn't reach B-station / the
	 * API client wasn't ready yet.
	 */
	/**
	 * Name-search counterpart to /lookup. Hits B-station's wbi/search/type
	 * endpoint with `search_type=bili_user`, slices to 5 entries per page so the
	 * dashboard's "添加 UP" dialog can paginate without overwhelming the UI.
	 * The response shape mirrors /lookup's per-row payload so the frontend can
	 * pass either through to onSubmit without translation.
	 */
	app.get("/search", async (c) => {
		const q = c.req.query("q")?.trim();
		const pageParam = Number(c.req.query("page") ?? 1);
		const page =
			Number.isFinite(pageParam) && pageParam >= 1 ? Math.min(Math.floor(pageParam), 200) : 1;
		if (!q) return respondFailure(c, fail("invalid", "搜索关键词不能为空"));
		const engines = deps.runtime.engines;
		if (!engines) return respondFailure(c, fail("unavailable", BILI_API_NOT_READY_MESSAGE));
		try {
			const res = (await engines.api.searchByType("bili_user", q, {
				page,
				pageSize: 5,
			})) as {
				code?: number;
				message?: string;
				data?: { result?: unknown[]; numResults?: number };
			};
			if (res?.code !== 0) {
				// B 站的话(`message`)是平台的业务说明,可以给人看;它的数字码只放 upstreamCode。
				const message = res?.message ?? "搜索失败";
				return respondFailure(
					c,
					fail("unavailable", `无法访问 B 站：${message}`, {
						...(typeof res?.code === "number" ? { upstreamCode: res.code } : {}),
					}),
				);
			}
			const raw = (Array.isArray(res.data?.result) ? res.data.result : []) as Array<
				Record<string, unknown>
			>;
			const results = raw.slice(0, 5).map((r) => ({
				uid: String(r.mid),
				name: stripHtmlTags(String(r.uname ?? "")),
				avatar: normaliseAvatarUrl(r.upic),
				sign: typeof r.usign === "string" ? r.usign : "",
				fans: typeof r.fans === "number" ? r.fans : 0,
			}));
			return c.json({
				results,
				page,
				pageSize: 5,
				total: typeof res.data?.numResults === "number" ? res.data.numResults : results.length,
			});
		} catch (err) {
			// 抛出来的是原始报错:原话只进日志,回给面板一句固定的中文。
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`/api/subs/search q=${q} failed: ${message}`);
			return respondFailure(c, fail("unavailable", "无法访问 B 站，详情在日志里"));
		}
	});

	app.get("/lookup", async (c) => {
		const uid = c.req.query("uid")?.trim();
		if (!uid || !/^\d+$/.test(uid)) {
			return respondFailure(c, fail("invalid", "uid 必须是纯数字 UID"));
		}
		const engines = deps.runtime.engines;
		if (!engines) return respondFailure(c, fail("unavailable", BILI_API_NOT_READY_MESSAGE));
		try {
			const res = await engines.api.getUserCardInfo(uid);
			if (res.code !== 0 || !res.data?.card) {
				// 现在的意思照旧:B 站回了非 0 就当「查无此人」(风控 / 未登录也在里头 —— 分类是 3a 的
				// `searchCreators` 的事)。B 站的数字码只放 upstreamCode。
				return respondFailure(
					c,
					fail("not_found", "未找到该 UP 主，请检查 UID 是否正确", {
						...(typeof res.code === "number" ? { upstreamCode: res.code } : {}),
					}),
				);
			}
			const card = res.data.card;
			return c.json({
				uid: card.mid,
				name: card.name,
				avatar: card.face,
				sign: card.sign,
				fans: card.fans,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`/api/subs/lookup uid=${uid} failed: ${message}`);
			return respondFailure(c, fail("unavailable", "无法访问 B 站，详情在日志里"));
		}
	});

	app.post("/", async (c) => {
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		const body = read.body;
		// 新建的订阅按来源分:拓展的走宿主把关的那条路(见 createExtensionSubscription),B 站的先核 uid。
		// 已有的那条整份 POST 回来改照常走下面 —— 身份改不动由 store 把关,带来的 cachedProfile 被 schema 剥掉。
		const sourceKey =
			isPlainObject(body) && isPlainObject(body.identity) ? body.identity.sourceKey : undefined;
		const exists =
			isPlainObject(body) && deps.store.getSubscriptions().some((s) => s.id === body.id);
		if (isPlainObject(body) && !exists && typeof sourceKey === "string") {
			if (sourceKey !== BILIBILI_SOURCE_KEY) return createExtensionSubscription(c, body);
			const refusal = biliExternalIdRefusal(body.identity);
			if (refusal) return respondFailure(c, refusal);
		}
		try {
			// upsertSubscription validates via Zod internally
			await deps.store.upsertSubscription(body as never);
			const id = (body as { id?: unknown }).id;
			const created =
				typeof id === "string" ? deps.store.getSubscriptions().find((s) => s.id === id) : undefined;
			if (created && subscriptionIdentityOf(created).sourceKey === BILIBILI_SOURCE_KEY) {
				// 关注必须在响应前完成 —— 否则返回的 DTO 里 followed 还是 undefined,
				// 前端拿不到「这条订阅收不收得到动态」这个关键状态。
				await followUp(created);
				await seedCachedProfile(created);
			}
			return c.json(deps.store.getSubscriptions().map(toDTO), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("POST /api/subs failed", err);
			throw err;
		}
	});

	app.patch("/:id", async (c) => {
		const id = c.req.param("id");
		const read = await readJsonObject(c);
		if (!read.ok) return respondFailure(c, read);
		// per-UP 审批的前置检查 —— 与全局那条(checkApprovalEnable)同一道闸。
		// 只拦一半的话,主人换个地方开同一个开关就绕过去了。
		const roastPatch = read.body.roastSchedule;
		if (isPlainObject(roastPatch)) {
			const cur = deps.store.getSubscriptions().find((s) => s.id === id);
			// 单人定时锐评两支订阅都有(ADR-0020 决策 14),闸也两支都拦:这次没带 approval 就看它现在那一格。
			const approvalOn =
				typeof roastPatch.approval === "boolean"
					? roastPatch.approval
					: (cur?.roastSchedule.approval ?? false);
			const gate = checkApprovalReachable({
				approvalOn,
				masterTargetId: deps.store.getGlobals().master.targetId,
				targets: deps.store.getTargets(),
			});
			if (!gate.ok) return respondFailure(c, gate);
		}
		try {
			const next = await deps.store.patchSubscription(id, read.body);
			return c.json(toDTO(next));
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("PATCH /api/subs/:id failed", err);
			throw err;
		}
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const removed = await deps.store.deleteSubscription(id);
		if (!removed) return respondFailure(c, fail("not_found", "没有这条订阅"));
		return c.body(null, 204);
	});

	return app;
}

/**
 * 这个拓展能不能挂订阅:装着、v2、清单开了订阅源那一口(`contributes.subscription`)。**不要求在跑**
 * —— 订阅是数据,停着的拓展名下的订阅照样留着、开回来就恢复(决策 10)。能挂回 `undefined`,
 * 不能就回那句点名的原因。
 */
function subscriptionSourceRefusal(
	extensionId: string,
	entries: readonly ExtensionEntry[],
): Failure | undefined {
	const entry = entries.find((e) => e.id === extensionId);
	if (!entry) return fail("not_found", `拓展「${extensionId}」没装,建不了它的订阅`);
	const manifest = entry.manifest;
	if (!manifest) {
		return fail(
			"unsupported",
			`拓展「${extensionId}」的清单读不出来(${entry.state}),认不出它是不是订阅源`,
		);
	}
	if (manifest.apiVersion !== 2) {
		return fail(
			"unsupported",
			`拓展「${manifest.name}」(${extensionId})是 v1 清单,v1 的契约里没有订阅源`,
		);
	}
	if (!manifest.contributes.subscription) {
		return fail(
			"unsupported",
			`拓展「${manifest.name}」(${extensionId})的清单没开订阅源这一口(contributes.subscription)`,
		);
	}
	return undefined;
}

/** B-station search wraps matched keywords with `<em class="keyword">…</em>`. */
/**
 * B 站订阅的外部 id 就是 uid,只能是数字。核在新建这一处:身份建好以后改不动(store 拒),中立的订阅 schema
 * 不认得哪个来源的 id 长什么样(ADR-0021 决策 14)。
 */
function biliExternalIdRefusal(identity: unknown): Failure | undefined {
	const externalId = isPlainObject(identity) ? identity.externalId : undefined;
	if (typeof externalId === "string" && /^\d+$/.test(externalId)) return undefined;
	return fail("invalid", "B 站订阅的外部 id 就是 UID,只能是数字", {
		issues: [{ path: ["identity", "externalId"], message: "B 站的 UID 只能是数字" }],
	});
}

function stripHtmlTags(s: string): string {
	return s.replace(/<[^>]+>/g, "");
}

/** B-station avatar urls come back protocol-relative (`//…`); coerce to https. */
function normaliseAvatarUrl(raw: unknown): string {
	if (typeof raw !== "string" || !raw) return "";
	if (raw.startsWith("//")) return `https:${raw}`;
	return raw;
}

/** 只认真正的对象 —— 数组 / null 不是 patch 片段。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
