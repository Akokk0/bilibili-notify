import type { SubscriptionDTO } from "@bilibili-notify/contract";
import {
	BILIBILI_SOURCE_KEY,
	type CachedProfile,
	type Failure,
	fail,
	formatZodIssues,
	type ImageRef,
	issuesFromZod,
	type Subscription,
	SubscriptionSchema,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ensureFollowed } from "../bilibili/api/index.js";
import { syncProfileAvatar } from "../bilibili/images.js";
import { ConfigValidationError } from "../config/store.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import { createImageFetcher } from "../images/image-fetcher.js";
import { followTargetSubscriptions } from "../runtime/follow-sync.js";
import { decodeSubscriptionAvatar } from "../runtime/subscription-avatar.js";
import {
	type ExternalIdSpec,
	externalIdRefusal,
	specialViewerIdRefusal,
} from "../subscriptions/external-id.js";
import { stripHtmlTags } from "../util/strip-html-tags.js";
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

/**
 * 新建拓展订阅时随订阅一起交的资料 —— 面板挑中的那个解析门候选(决策 11 / 52)。
 *
 * 只收 `name` / `avatarUrl` / `fans`:签名没人报过,刷新时间是服务端说了算,别的键一律丢。
 * `avatarUrl` 要么不给(没有头像),要么是位图 data URL(它是个网址,所以叫 `avatarUrl`),魔数另核(见
 * `decodeSubscriptionAvatar`)。服务端把它存进图库,资料里换成图库引用 `avatar`。
 */
const CreateProfileSchema = z.object({
	name: z
		.string({ error: "名字要是字符串" })
		.min(1, "名字不能是空串")
		.max(128, "名字不能超过 128 字"),
	avatarUrl: z.string({ error: "头像要是字符串" }).optional(),
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
 * `/api/subscriptions` — CRUD on the Subscription[] list.
 *
 * Body shapes:
 * - POST /api/subscriptions  → full Subscription (validated by SubscriptionSchema in store)
 * - PATCH /api/subscriptions/:id → DeepPartial<Subscription>; merged onto current then validated
 *
 * We deliberately require the full Subscription on POST rather than letting the
 * server fill in defaults — `makeEmptySubscription({id, identity})` exists in
 * `@bilibili-notify/internal` and clients (the dashboard) call that locally.
 * Keeps the server stateless about defaults.
 *
 * 订阅只有一种形状,订的是谁看 `identity`(ADR-0021 决策 14)。**新建拓展的订阅**(`identity.sourceKey`
 * 是拓展 id)由宿主把关(见 {@link createExtensionSubscription}):得是装着的 v2 订阅源(不要求在跑,
 * ADR-0019 决策 10),同一身份只许一条(决策 50);面板从解析门挑中的候选放进 `cachedProfile` 一起交,
 * 头像存进图库(决策 49)。**新建订阅**(两种来源都是)先按来源描述符声明的格式核外部 id(`externalIdRegex`,
 * 见 `subscriptions/external-id.ts`);B 站声明的是纯数字 uid。已经存在的订阅可以整份 POST 回来改
 * (面板的启用开关就是这么发的),身份改不动(store 拒)。关注、B 站资料种子、查 UID / 搜名字都只对 B 站。
 *
 * 失败一律经 `respondFailure`(ADR-0026):store 拒收时抛的 `ConfigValidationError` 自带标准码
 * (不合规 400、没这一条 404),路由按码回、不嗅文案;查 UID / 搜名字里 B 站自己的数字码只放
 * `upstreamCode`,不占 `code`(风控 / 未登录的分类留到 3a 的 `searchCreators`,这里不扩大)。
 */
export function createSubscriptionsRoute(deps: RouteDeps, opts: SubsRouteOptions = {}): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/**
	 * 这个来源声明的外部 id 格式从哪儿来:在来源登记表里的(B 站、进程内的来源)取它的描述符;拓展来源不进
	 * 登记表,取清单里订阅源那一段的外观(同样有 `label` 与 `externalIdRegex`)。认不出的来源返回
	 * `undefined`,不替它核 —— 装没装、是不是订阅源由 {@link createExtensionSubscription} 的闸回话。
	 */
	function externalIdSpecOf(sourceKey: string): ExternalIdSpec | undefined {
		const registered = deps.runtime.sourceRegistry.get(sourceKey);
		if (registered) return registered.descriptor;
		const entry = opts.extensions?.().find((one) => one.id === sourceKey);
		return entry?.manifest?.contributes.subscription?.display;
	}

	/** 这条订阅盘上已有的特别关注名单 id(没有这条订阅就是空)。 */
	function knownSpecialViewerIds(subscriptionId: unknown): string[] {
		const stored = deps.store.getSubscriptions().find((s) => s.id === subscriptionId);
		return (stored?.specialViewers ?? []).map((v) => v.id);
	}

	/** Join the externalized runtime fields back onto a config Subscription. */
	function toDTO(sub: Subscription, needFollow: ReadonlySet<string>): SubscriptionDTO {
		const rt = deps.runtime.subRuntimeStore.get(sub.id);
		const runtime = { cachedProfile: rt?.cachedProfile };
		// 关注状态只对需要关注的 B 站订阅有意义(动态走 B 站的关注流):别的来源、停用的、没开作品的
		// (直播用不着关注)这两格缺着 —— 运行时状态里留着的旧「未关注」不该再挂在卡片上吓人。
		if (!needFollow.has(sub.id)) return { ...sub, ...runtime };
		return { ...sub, ...runtime, followed: rt?.followed, followError: rt?.followError };
	}

	/** 需要关注的订阅 id:启用中、作品开关开着的 B 站订阅(见 `followTargetSubscriptions`)。 */
	function followTargetIds(): Set<string> {
		const targets = followTargetSubscriptions(
			deps.store.getSubscriptions(),
			deps.store.getGlobals().defaults,
		);
		return new Set(targets.map((s) => s.id));
	}

	/** 整张订阅表的 DTO(GET / POST 的回应)。 */
	function toDTOs(): SubscriptionDTO[] {
		const needFollow = followTargetIds();
		return deps.store.getSubscriptions().map((sub) => toDTO(sub, needFollow));
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
			const res = await engines.api.fetchUserCard(uid);
			if (!res.ok || !res.data?.card) return;
			const card = res.data.card;
			// 头像当场抓进图库再回应(经 B 站接口那个请求客户端,引用方是订阅资料这一家);抓不到不让新建失败,
			// 资料里先只记地址,下一轮粉丝轮询的冷刷会补(见 `syncProfileAvatar`)。
			const avatarFields = await syncProfileAvatar(undefined, card.face, {
				images: createImageFetcher({
					http: engines.api.http,
					images: deps.runtime.profileImages,
				}),
				logger: log,
			});
			const cachedProfile: CachedProfile = {
				name: card.name ?? uid,
				...avatarFields,
				sign: card.sign ?? "",
				fans: typeof card.fans === "number" && card.fans >= 0 ? card.fans : 0,
				lastRefreshedAt: new Date().toISOString(),
			};
			await deps.runtime.subRuntimeStore.patch(sub.id, { cachedProfile });
		} catch (err) {
			log.warn(`/api/subscriptions seed cachedProfile uid=${uid} failed: ${String(err)}`);
		}
	}

	/**
	 * 新建一条拓展订阅(ADR-0019 决策 9 / 10 / 49 / 50)。**能核的先全核完再落盘**:订阅的形状 →
	 * 带来的资料(连头像的魔数)→ 它是不是装着的订阅源;判重在 upsert 里(store 那道闸,B 站来源的也过它)。
	 * 都过了才把头像存进图库、种资料缓存 —— 这两步是展示用的缓存,失败只记一句,不让新建失败(同 B 站的资料种子)。
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
		// 不给就是没有头像。解开的字节留着,订阅落盘之后直接存进图库,不再解第二遍。
		let avatarBytes: Buffer | undefined;
		if (seed?.avatarUrl !== undefined) {
			const decoded = decodeSubscriptionAvatar(seed.avatarUrl);
			if (!decoded.ok) {
				return respondFailure(
					c,
					fail("invalid", `随订阅交来的头像不合规：${decoded.message}`, {
						issues: [{ path: ["cachedProfile", "avatarUrl"], message: decoded.message }],
					}),
				);
			}
			avatarBytes = decoded.bytes;
		}

		const refusal = subscriptionSourceRefusal(identity.sourceKey, opts.extensions?.() ?? []);
		if (refusal) return respondFailure(c, refusal);

		try {
			// 形状由 schema 核、同一个人订第二条(身份判重)由 store 拒 —— 都在写盘那一层,两种来源同一道。
			await deps.store.upsertSubscription(subBody as never);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("POST /api/subscriptions (extension) failed", err);
			throw err;
		}
		if (seed) await seedExtensionProfile(sub, seed, avatarBytes);
		return c.json(toDTOs(), 200);
	}

	/**
	 * 拿面板挑中的那个候选种资料缓存。头像先存进图库(决策 49),资料里只放回来的引用;存不下来
	 * 就先不带头像,等 ④ 的「报资料更新」再来。
	 */
	async function seedExtensionProfile(
		sub: Subscription,
		seed: z.infer<typeof CreateProfileSchema>,
		avatarBytes: Buffer | undefined,
	): Promise<void> {
		let avatar: ImageRef | undefined;
		if (avatarBytes) {
			try {
				const stored = await deps.runtime.profileImages.put(avatarBytes);
				if (stored.ok) avatar = stored.ref;
				else log.warn(`[sub] 拓展订阅 ${sub.id} 的头像没存下来,资料先不带头像: ${stored.message}`);
			} catch (err) {
				log.warn(`[sub] 拓展订阅 ${sub.id} 的头像没存下来,资料先不带头像: ${String(err)}`);
			}
		}
		const cachedProfile: CachedProfile = {
			name: seed.name,
			// 没有头像就是这一格缺,不写空串。
			...(avatar === undefined ? {} : { avatar }),
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

	app.get("/", (c) => c.json(toDTOs()));

	// 标签表(ADR-0034):和 `/search`、`/lookup` 一样是这一摊底下的固定子路径。这一摊没有 `GET /:id` / `PUT /:id`,
	// 撞不上;挂在 `/:id` 那几条前面,以后真加了也先认它。
	app.route("/tags", createSubscriptionTagsRoute(deps));

	/**
	 * Pre-flight UID resolution for the "add UP" dialog. Hits B-station's user
	 * card endpoint via Api; on success returns the four fields the
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
			const res = await engines.api.searchByType("bili_user", q, {
				page,
				pageSize: 5,
			});
			if (!res.ok) {
				// B 站的话(`message`)是平台的业务说明,可以给人看;它的数字码只放 upstreamCode。
				const message = res.message || "搜索失败";
				return respondFailure(
					c,
					fail("unavailable", `无法访问 B 站：${message}`, {
						...(typeof res.upstreamCode === "number" ? { upstreamCode: res.upstreamCode } : {}),
					}),
				);
			}
			const data = res.data as { result?: unknown[]; numResults?: number } | null | undefined;
			const raw = (Array.isArray(data?.result) ? data.result : []) as Array<
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
				total: typeof data?.numResults === "number" ? data.numResults : results.length,
			});
		} catch (err) {
			// 抛出来的是原始报错:原话只进日志,回给面板一句固定的中文。
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`/api/subscriptions/search q=${q} failed: ${message}`);
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
			const res = await engines.api.fetchUserCard(uid);
			if (!res.ok || !res.data?.card) {
				// 现在的意思照旧:B 站回了非 0 就当「查无此人」(风控 / 未登录也在里头 —— 分类是 3a 的
				// `searchCreators` 的事)。B 站的数字码只放 upstreamCode。
				const upstreamCode = res.ok ? 0 : res.upstreamCode;
				return respondFailure(
					c,
					fail("not_found", "未找到该 UP 主，请检查 UID 是否正确", {
						...(upstreamCode === undefined ? {} : { upstreamCode }),
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
			log.warn(`/api/subscriptions/lookup uid=${uid} failed: ${message}`);
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
		// 特别关注名单上新加的观众 id,同样按来源声明的格式核(盘上已有的条目不回头核)。
		if (isPlainObject(body) && typeof sourceKey === "string") {
			const listRefusal = specialViewerIdRefusal(
				externalIdSpecOf(sourceKey),
				body.specialViewers,
				knownSpecialViewerIds(body.id),
			);
			if (listRefusal) return respondFailure(c, listRefusal);
		}
		if (isPlainObject(body) && !exists && typeof sourceKey === "string") {
			// 外部 id 的格式由来源在描述符里声明,两种来源同一道,核在分岔之前。
			const externalId = isPlainObject(body.identity) ? body.identity.externalId : undefined;
			const refusal = externalIdRefusal(externalIdSpecOf(sourceKey), externalId);
			if (refusal) return respondFailure(c, refusal);
			if (sourceKey !== BILIBILI_SOURCE_KEY) return createExtensionSubscription(c, body);
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
				// 只对新建、且需要关注的(启用中、作品开着)当场关注:没开作品的用不着(直播不走关注流);
				// 整份回来改的那条(面板的启用开关)不在这里,开关翻开补关注由引擎听订阅变更去做。
				if (!exists && followTargetIds().has(created.id)) await followUp(created);
				await seedCachedProfile(created);
			}
			return c.json(toDTOs(), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("POST /api/subscriptions failed", err);
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
				connections: deps.store.getConnections(),
				// 引擎还没起来时取不到能力,按「还不知道」算。
				capabilitiesOf: (connectionId) =>
					deps.runtime.engines?.connectionCapabilities(connectionId),
			});
			if (!gate.ok) return respondFailure(c, gate);
		}
		// 名单上新加的观众 id 按这条订阅所属来源的格式核;订阅不存在的留给 store 报 not_found。
		const current = deps.store.getSubscriptions().find((s) => s.id === id);
		if (current && Array.isArray(read.body.specialViewers)) {
			const listRefusal = specialViewerIdRefusal(
				externalIdSpecOf(subscriptionIdentityOf(current).sourceKey),
				read.body.specialViewers,
				knownSpecialViewerIds(id),
			);
			if (listRefusal) return respondFailure(c, listRefusal);
		}
		try {
			const next = await deps.store.patchSubscription(id, read.body);
			return c.json(toDTO(next, followTargetIds()));
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("PATCH /api/subscriptions/:id failed", err);
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
	if (!manifest.contributes.subscription) {
		return fail(
			"unsupported",
			`拓展「${manifest.name}」(${extensionId})的清单没开订阅源这一口(contributes.subscription)`,
		);
	}
	return undefined;
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
