import type { SubscriptionCreateRequest, SubscriptionDTO } from "@bilibili-notify/contract";
import {
	type Failure,
	fail,
	formatZodIssues,
	type ImageRef,
	issuesFromZod,
	type Problem,
	type Subscription,
	SubscriptionSchema,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import { t } from "../i18n/index.js";
import { decodeSubscriptionAvatar } from "../runtime/subscription-avatar.js";
import {
	type ExternalIdSpec,
	externalIdRefusal,
	specialViewerIdRefusal,
} from "../subscriptions/external-id.js";
import { readJsonBody, readJsonObject } from "./request-body.js";
import { respondFailure } from "./respond-failure.js";
import { checkApprovalReachable } from "./roast-approval-guard.js";
import { createSubscriptionTagsRoute } from "./subscription-tags.js";
import type { RouteDeps } from "./types.js";

// DTO 形状在 @bilibili-notify/contract(web 同源消费):持久化 Subscription +
// SubscriptionStateStore join 回来的外置运行时字段。

/** 搜人不在这里(在来源那一摊:`GET /api/sources/:sourceKey/creators`)。 */
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
 * 只收 `name` / `avatarUrl` / `followers`:签名没人报过,刷新时间是服务端说了算,别的键一律丢。
 * `avatarUrl` 要么不给(没有头像),要么是位图 data URL(它是个网址,所以叫 `avatarUrl`),魔数另核(见
 * `decodeSubscriptionAvatar`)。服务端把它存进图库,资料里换成图库引用 `avatar`。话在出字那一刻取(zod 的
 * `error` 回调),换了语言不用重建。
 */
const CreateProfileSchema: z.ZodType<NonNullable<SubscriptionCreateRequest["cachedProfile"]>> =
	z.object({
		name: z
			.string({ error: () => t("subscriptions.profile.nameType") })
			.min(1, { error: () => t("subscriptions.profile.nameBlank") })
			.max(128, { error: () => t("subscriptions.profile.nameTooLong", { max: 128 }) }),
		avatarUrl: z.string({ error: () => t("subscriptions.profile.avatarType") }).optional(),
		followers: z
			.number({ error: () => t("subscriptions.profile.followersType") })
			.int({ error: () => t("subscriptions.profile.followersInteger") })
			.nonnegative({ error: () => t("subscriptions.profile.followersNegative") })
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
 * 订阅只有一种形状,订的是谁看 `identity`(ADR-0021 决策 14)。**新建订阅只有一道门**(见
 * {@link createSubscription},4-15):先按来源描述符声明的格式核外部 id(`externalIdRegex`,见
 * `subscriptions/external-id.ts`);来源认不认得问来源登记表(在册就认),不在册的得是装着的订阅源拓展(不要求在跑,
 * ADR-0019 决策 10);同一身份只许一条(决策 50);面板从搜人挑中的候选放进 `cachedProfile` 一起交,头像存进图库
 * (决策 49)。已经存在的订阅可以整份 POST 回来改(面板的启用开关就是这么发的),身份改不动(store 拒)。搜人在
 * 来源那一摊(`GET /api/sources/:sourceKey/creators`);关注归来源自己在名单变化时做。
 *
 * 失败一律经 `respondFailure`(ADR-0026):store 拒收时抛的 `ConfigValidationError` 自带标准码
 * (不合规 400、没这一条 404),路由按码回、不嗅文案。
 */
export function createSubscriptionsRoute(deps: RouteDeps, opts: SubsRouteOptions): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/**
	 * 这个来源声明的外部 id 格式从哪儿来:登记表里的来源取它的描述符;没在登记的拓展取清单里订阅源
	 * 那一段(同样有 `label` 与 `externalIdRegex`)。认不出的来源返回
	 * `undefined`,不替它核 —— 认不认得这个来源由 {@link createSubscription} 的门回话。
	 */
	function externalIdSpecOf(sourceKey: string): ExternalIdSpec | undefined {
		const registered = deps.runtime.sourceRegistry.get(sourceKey);
		if (registered) return registered.descriptor;
		const entry = opts.extensions?.().find((one) => one.id === sourceKey);
		return entry?.manifest?.contributes.subscription;
	}

	/** 这条订阅盘上已有的特别关注名单 id(没有这条订阅就是空)。 */
	function knownSpecialViewerIds(subscriptionId: unknown): string[] {
		const stored = deps.store.getSubscriptions().find((s) => s.id === subscriptionId);
		return (stored?.specialViewers ?? []).map((v) => v.id);
	}

	/**
	 * 问题表读一次,按 `about.subscriptionId` 分好组;每组按 `since` 先后(ISO 串,字典序即时间序)。
	 * 一张表给一次回应用:别按订阅各读一遍、各过滤一遍。
	 */
	function problemsBySubscription(): Map<string, Problem[]> {
		const grouped = new Map<string, Problem[]>();
		for (const problem of deps.runtime.problems.list()) {
			const about = problem.about;
			if (about === undefined || !("subscriptionId" in about)) continue;
			const group = grouped.get(about.subscriptionId);
			if (group) group.push(problem);
			else grouped.set(about.subscriptionId, [problem]);
		}
		for (const group of grouped.values()) {
			group.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
		}
		return grouped;
	}

	/** Join the externalized runtime fields back onto a config Subscription. */
	function toDTO(sub: Subscription, problems: Map<string, Problem[]>): SubscriptionDTO {
		const rt = deps.runtime.subscriptionStateStore.get(sub.id);
		return {
			...sub,
			cachedProfile: rt?.cachedProfile,
			problems: problems.get(sub.id) ?? [],
		};
	}

	/** 整张订阅表的 DTO(GET / POST 的回应)。 */
	function toDTOs(): SubscriptionDTO[] {
		const problems = problemsBySubscription();
		return deps.store.getSubscriptions().map((sub) => toDTO(sub, problems));
	}

	/**
	 * 新建一条订阅(ADR-0019 决策 9 / 10 / 49 / 50;所有来源同一道门,4-15)。**能核的先全核完再落盘**:订阅的
	 * 形状 → 带来的资料(连头像的魔数)→ 认不认得这个来源;判重在 upsert 里(store 那道闸)。都过了才把头像存进
	 * 图库、种资料缓存 —— 这两步是展示用的缓存,失败只记一句,不让新建失败。没带资料就只建订阅、不当场去取:
	 * 等来源自己报或定时刷新(4-15 主人定只种不刷;面板新建一律带候选资料)。
	 */
	async function createSubscription(c: Context, body: Record<string, unknown>): Promise<Response> {
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
				fail(
					"invalid",
					t("subscriptions.create.badProfile", {
						detail: formatZodIssues(profile.error).join("；"),
					}),
					{
						issues: issuesFromZod(profile.error),
					},
				),
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
					fail("invalid", t("subscriptions.create.badAvatar", { reason: decoded.message }), {
						issues: [{ path: ["cachedProfile", "avatarUrl"], message: decoded.message }],
					}),
				);
			}
			avatarBytes = decoded.bytes;
		}

		if (!deps.runtime.sourceRegistry.get(identity.sourceKey)) {
			const refusal = subscriptionSourceRefusal(identity.sourceKey, opts.extensions?.() ?? []);
			if (refusal) return respondFailure(c, refusal);
		}

		try {
			// 形状由 schema 核、同一个人订第二条(身份判重)由 store 拒 —— 都在写盘那一层,所有来源同一道。
			await deps.store.upsertSubscription(subBody as never);
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("POST /api/subscriptions failed", err);
			throw err;
		}
		if (seed) await seedProfile(sub, seed, avatarBytes);
		return c.json(toDTOs(), 200);
	}

	/**
	 * 拿面板挑中的那个候选种资料缓存,走全进程唯一的资料缓存写口:轮到时还没有资料才种,来源收到新建通知
	 * 先报了的不动。头像在要种时才存进图库(决策 49),资料里只放回来的引用;存不下来就先不带头像,
	 * 等来源下一次报资料或资料刷新再来。
	 */
	async function seedProfile(
		sub: Subscription,
		seed: z.infer<typeof CreateProfileSchema>,
		avatarBytes: Buffer | undefined,
	): Promise<void> {
		const storeAvatar = async (): Promise<ImageRef | undefined> => {
			if (!avatarBytes) return undefined;
			try {
				const stored = await deps.runtime.profileImages.put(avatarBytes);
				if (stored.ok) return stored.ref;
				log.warn(`[sub] 订阅 ${sub.id} 的头像没存下来,资料先不带头像: ${stored.message}`);
			} catch (err) {
				log.warn(`[sub] 订阅 ${sub.id} 的头像没存下来,资料先不带头像: ${String(err)}`);
			}
			return undefined;
		};
		try {
			await deps.runtime.profileCache.seed(sub.id, async () => {
				const avatar = await storeAvatar();
				return {
					name: seed.name,
					// 没有头像就是这一格缺,不写空串;不知道粉丝数就不写 —— 写 0 是在面板上印一句假话。
					...(avatar === undefined ? {} : { avatar }),
					...(seed.followers === undefined ? {} : { followers: seed.followers }),
				};
			});
		} catch (err) {
			log.warn(`[sub] 订阅 ${sub.id} 的资料缓存没写进去: ${String(err)}`);
		}
	}

	app.get("/", (c) => c.json(toDTOs()));

	// 标签表(ADR-0034):这一摊底下的固定子路径。这一摊没有 `GET /:id` / `PUT /:id`,
	// 撞不上;挂在 `/:id` 那几条前面,以后真加了也先认它。
	app.route("/tags", createSubscriptionTagsRoute(deps));

	app.post("/", async (c) => {
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		const body = read.body;
		// 新建的走那道门(见 createSubscription);已有的那条整份 POST 回来改照常走下面 —— 身份改不动由 store
		// 把关,带来的 cachedProfile 被 schema 剥掉。
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
			// 外部 id 的格式由来源在描述符里声明,所有来源同一道。
			const externalId = isPlainObject(body.identity) ? body.identity.externalId : undefined;
			const refusal = externalIdRefusal(externalIdSpecOf(sourceKey), externalId);
			if (refusal) return respondFailure(c, refusal);
			return createSubscription(c, body);
		}
		try {
			// upsertSubscription validates via Zod internally
			await deps.store.upsertSubscription(body as never);
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
				// 推送链路还没起来时取不到能力,按「还不知道」算。
				capabilitiesOf: (connectionId) =>
					deps.runtime.pipeline?.connectionCapabilities(connectionId),
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
			return c.json(toDTO(next, problemsBySubscription()));
		} catch (err) {
			if (err instanceof ConfigValidationError) return respondFailure(c, err.toFailure());
			log.error("PATCH /api/subscriptions/:id failed", err);
			throw err;
		}
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const removed = await deps.store.deleteSubscription(id);
		if (!removed) return respondFailure(c, fail("not_found", t("subscriptions.notFound")));
		return c.body(null, 204);
	});

	return app;
}

/**
 * 不在来源登记表里的键能不能挂订阅:得是装着的拓展、清单能读、开了订阅源那一口(`contributes.subscription`)。
 * **不要求在跑** —— 订阅是数据,停着的拓展名下的订阅照样留着、开回来就恢复(决策 10)。能挂回 `undefined`,
 * 不能就回那句点名的原因。
 */
function subscriptionSourceRefusal(
	extensionId: string,
	entries: readonly ExtensionEntry[],
): Failure | undefined {
	const entry = entries.find((e) => e.id === extensionId);
	if (!entry) {
		return fail("not_found", t("subscriptions.create.unknownSource", { sourceKey: extensionId }));
	}
	const manifest = entry.manifest;
	if (!manifest) {
		return fail(
			"unsupported",
			t("subscriptions.create.manifestUnreadable", { extensionId, state: entry.state }),
		);
	}
	if (!manifest.contributes.subscription) {
		return fail(
			"unsupported",
			t("subscriptions.create.notSubscriptionSource", { name: manifest.name, extensionId }),
		);
	}
	return undefined;
}

/** 只认真正的对象 —— 数组 / null 不是 patch 片段。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
