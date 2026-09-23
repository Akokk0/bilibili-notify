import { ensureFollowed } from "@bilibili-notify/api";
import type { SubscriptionDTO } from "@bilibili-notify/contract";
import {
	type BiliSubscription,
	type CachedProfile,
	type ExtensionSubscription,
	ExtensionSubscriptionSchema,
	formatZodIssues,
	isBiliSubscription,
	isExtensionSubscription,
	type Subscription,
} from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ConfigValidationError } from "../config/store.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import { decodeSubscriptionAvatar } from "../runtime/sub-avatar-store.js";
import { checkApprovalReachable } from "./roast-approval-guard.js";
import type { RouteDeps } from "./types.js";

// DTO 形状在 @bilibili-notify/contract(web 同源消费):持久化 Subscription +
// SubRuntimeStore join 回来的外置运行时字段。`state` 发常量 —— 唯一活字段
// (fansBaseline)是 FansPoller 私有、永不上线,其余(lastDynamicId/lastPushedAt/
// liveStatus)无任何写入方,固定默认值即可满足 web 的非可选 `state` 与恒
// "unknown" 的 Rules.tsx 读取,不算编造数据。

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
 * server fill in defaults — `makeEmptySubscription({id, uid})` exists in
 * `@bilibili-notify/internal` and clients (the dashboard) call that locally.
 * Keeps the server stateless about defaults.
 *
 * 两支订阅(ADR-0019 决策 9):GET 两支都回。**新建拓展订阅**由宿主把关(见
 * {@link createExtensionSubscription}):`extensionId` 得是装着的 v2 订阅源(不要求在跑,决策 10),
 * 同一个拓展名下同一个外部 id 只许一条(决策 50);面板从解析门挑中的候选放进 `cachedProfile`
 * 一起交,头像存成文件(决策 49)。已经存在的拓展订阅可以整份 POST 回来改(面板的启用开关就是
 * 这么发的),身份几格改不动(store 拒)。关注、B 站资料种子、查 UID / 搜名字都只对 B 站订阅。
 */
export function createSubsRoute(deps: RouteDeps, opts: SubsRouteOptions = {}): Hono {
	const app = new Hono();
	const log = deps.runtime.serviceCtx.logger;

	/** Join the externalized runtime fields back onto a config Subscription. */
	function toDTO(sub: Subscription): SubscriptionDTO {
		const rt = deps.runtime.subRuntimeStore.get(sub.id);
		const runtime = {
			cachedProfile: rt?.cachedProfile,
			state: { lastPushedAt: {}, liveStatus: "unknown" as const },
		};
		// 关注状态只对 B 站订阅有意义(动态走 B 站的关注流)。
		if (!isBiliSubscription(sub)) return { ...sub, ...runtime };
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
	async function followUp(sub: BiliSubscription): Promise<void> {
		const engines = deps.runtime.engines;
		if (!engines) return; // 启动中 / 未登录 —— 交给启动时的 follow-sync 兜底。
		const outcome = await ensureFollowed(engines.api, sub.uid);
		if (!outcome.ok) {
			log.warn(
				`[sub] 关注 UID ${sub.uid} 失败(code=${outcome.code}): ${outcome.message} —— 该订阅收不到动态`,
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
	async function seedCachedProfile(sub: BiliSubscription): Promise<void> {
		if (deps.runtime.subRuntimeStore.get(sub.id)?.cachedProfile) return;
		const engines = deps.runtime.engines;
		if (!engines) return;
		try {
			const res = await engines.api.getUserCardInfo(sub.uid);
			if (res.code !== 0 || !res.data?.card) return;
			const card = res.data.card;
			const cachedProfile: CachedProfile = {
				name: card.name ?? sub.uid,
				avatar: card.face ?? "",
				sign: card.sign ?? "",
				fans: typeof card.fans === "number" && card.fans >= 0 ? card.fans : 0,
				lastRefreshedAt: new Date().toISOString(),
			};
			await deps.runtime.subRuntimeStore.patch(sub.id, { cachedProfile });
		} catch (err) {
			log.warn(`/api/subs seed cachedProfile uid=${sub.uid} failed: ${String(err)}`);
		}
	}

	/**
	 * 新建一条拓展订阅(ADR-0019 决策 9 / 10 / 49 / 50)。**能核的先全核完再落盘**:订阅的形状 →
	 * 带来的资料(连头像的魔数)→ 它是不是装着的订阅源 → 判重。都过了才 upsert,之后存头像文件、
	 * 种资料缓存 —— 这两步是展示用的缓存,失败只记一句,不让新建失败(同 B 站的资料种子)。
	 */
	async function createExtensionSubscription(
		c: Context,
		body: Record<string, unknown>,
	): Promise<Response> {
		const { cachedProfile: rawProfile, ...subBody } = body;
		const parsed = ExtensionSubscriptionSchema.safeParse(subBody);
		if (!parsed.success) {
			// 与 store 拒收时同一个形状(下面 upsert 失败走的也是它)。
			return c.json(
				{ error: "validation_failed", scope: "subscriptions", issues: parsed.error.issues },
				400,
			);
		}
		const sub = parsed.data;

		const profile = CreateProfileBodySchema.safeParse({ cachedProfile: rawProfile });
		if (!profile.success) {
			return c.json(
				{ error: "invalid_profile", message: formatZodIssues(profile.error).join(";") },
				400,
			);
		}
		const seed = profile.data.cachedProfile;
		// 空串就是「没有头像」,与 CachedProfile 自己的口径一样。
		const avatarDataUrl = seed?.avatar || undefined;
		if (avatarDataUrl) {
			const decoded = decodeSubscriptionAvatar(avatarDataUrl);
			if (!decoded.ok) {
				return c.json(
					{ error: "invalid_profile", message: `cachedProfile.avatar: ${decoded.reason}` },
					400,
				);
			}
		}

		const refusal = subscriptionSourceRefusal(sub.extensionId, opts.extensions?.() ?? []);
		if (refusal) return c.json(refusal, 400);

		// 身份判重(决策 50):同一个人订两条,等 ④ 按订阅 id 推送时就会推两遍。
		const duplicate = deps.store
			.getSubscriptions()
			.find(
				(s) =>
					isExtensionSubscription(s) &&
					s.extensionId === sub.extensionId &&
					s.externalId === sub.externalId,
			);
		if (duplicate) {
			const name =
				duplicate.name ?? deps.runtime.subRuntimeStore.get(duplicate.id)?.cachedProfile?.name;
			return c.json(
				{
					error: "duplicate_subscription",
					id: duplicate.id,
					message: `拓展「${sub.extensionId}」名下的「${sub.externalId}」已经订阅过了${name ? `(${name})` : ""}`,
				},
				409,
			);
		}

		try {
			// upsertSubscription validates via Zod internally
			await deps.store.upsertSubscription(subBody as never);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
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
		sub: ExtensionSubscription,
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

	/**
	 * 拓展订阅的头像(ADR-0019 决策 49)。在 `/api/*` 底下,吃同一道面板鉴权。地址里的 `v` 是内容
	 * 摘要,换了图地址就变 —— 所以同一个地址可以放心让浏览器永久缓存。
	 */
	app.get("/:id/avatar", async (c) => {
		const id = c.req.param("id");
		if (!z.uuid().safeParse(id).success) {
			return c.json({ error: "invalid_id", message: "订阅 id 要是 uuid" }, 400);
		}
		const avatar = await deps.runtime.subAvatarStore.read(id);
		if (!avatar) return c.json({ error: "not_found", id }, 404);
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
		if (!q) {
			return c.json({ error: "invalid_query", message: "搜索关键词不能为空" }, 400);
		}
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json({ error: "api_not_ready", message: "B 站 API 尚未就绪" }, 503);
		}
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
				const message = res?.message ?? "搜索失败";
				return c.json({ error: "upstream_failed", code: res?.code, message }, 502);
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
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`/api/subs/search q=${q} failed: ${message}`);
			return c.json({ error: "upstream_failed", message }, 502);
		}
	});

	app.get("/lookup", async (c) => {
		const uid = c.req.query("uid")?.trim();
		if (!uid || !/^\d+$/.test(uid)) {
			return c.json({ error: "invalid_uid", message: "uid 必须是纯数字 UID" }, 400);
		}
		const engines = deps.runtime.engines;
		if (!engines) {
			return c.json({ error: "api_not_ready", message: "B 站 API 尚未就绪" }, 503);
		}
		try {
			const res = await engines.api.getUserCardInfo(uid);
			if (res.code !== 0 || !res.data?.card) {
				const message = (res as { message?: string }).message ?? "未找到该 UP 主";
				return c.json({ error: "not_found", code: res.code, message }, 404);
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
			return c.json({ error: "upstream_failed", message }, 502);
		}
	});

	app.post("/", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		// 新建拓展订阅走宿主把关的那条路(见 createExtensionSubscription)。已有的那条整份 POST
		// 回来改照常走下面 —— 身份改不动由 store 把关,带来的 cachedProfile 被 schema 剥掉。
		if (isPlainObject(body) && body.kind === "extension") {
			const exists = deps.store.getSubscriptions().some((s) => s.id === body.id);
			if (!exists) return createExtensionSubscription(c, body);
		}
		try {
			// upsertSubscription validates via Zod internally
			await deps.store.upsertSubscription(body as never);
			const id = (body as { id?: unknown }).id;
			const created =
				typeof id === "string" ? deps.store.getSubscriptions().find((s) => s.id === id) : undefined;
			if (created && isBiliSubscription(created)) {
				// 关注必须在响应前完成 —— 否则返回的 DTO 里 followed 还是 undefined,
				// 前端拿不到「这条订阅收不收得到动态」这个关键状态。
				await followUp(created);
				await seedCachedProfile(created);
			}
			return c.json(deps.store.getSubscriptions().map(toDTO), 200);
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, 400);
			}
			log.error("POST /api/subs failed", err);
			throw err;
		}
	});

	app.patch("/:id", async (c) => {
		const id = c.req.param("id");
		let body: unknown;
		try {
			body = await c.req.json();
		} catch (_err) {
			return c.json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
		}
		const shapeCheck = z.record(z.string(), z.unknown()).safeParse(body);
		if (!shapeCheck.success) {
			return c.json(
				{
					error: "invalid_payload",
					message: "PATCH body must be a JSON object",
					issues: shapeCheck.error.issues,
				},
				400,
			);
		}
		// per-UP 审批的前置检查 —— 与全局那条(checkApprovalEnable)同一道闸。
		// 只拦一半的话,主人换个地方开同一个开关就绕过去了。
		const roastPatch = shapeCheck.data.roastSchedule;
		if (isPlainObject(roastPatch)) {
			const cur = deps.store.getSubscriptions().find((s) => s.id === id);
			// 单人锐评只有 B 站订阅有(ADR-0019 决策 12);拓展订阅上这一段会被 schema 剥掉。
			const approvalOn =
				typeof roastPatch.approval === "boolean"
					? roastPatch.approval
					: cur && isBiliSubscription(cur)
						? cur.roastSchedule.approval
						: false;
			const gate = checkApprovalReachable({
				approvalOn,
				masterTargetId: deps.store.getGlobals().master.targetId,
				targets: deps.store.getTargets(),
			});
			if (!gate.ok) {
				return c.json(
					{ error: "enable_check_failed", scope: "roastSchedule", message: gate.message },
					400,
				);
			}
		}
		try {
			const next = await deps.store.patchSubscription(id, shapeCheck.data);
			return c.json(toDTO(next));
		} catch (err) {
			if (err instanceof ConfigValidationError) {
				const status = isNotFound(err) ? 404 : 400;
				return c.json({ error: "validation_failed", scope: err.scope, issues: err.issues }, status);
			}
			log.error("PATCH /api/subs/:id failed", err);
			throw err;
		}
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		const removed = await deps.store.deleteSubscription(id);
		if (!removed) return c.json({ error: "not_found", id }, 404);
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
): { error: string; message: string } | undefined {
	const entry = entries.find((e) => e.id === extensionId);
	if (!entry) {
		return {
			error: "extension_not_installed",
			message: `拓展「${extensionId}」没装,建不了它的订阅`,
		};
	}
	const manifest = entry.manifest;
	if (!manifest) {
		return {
			error: "not_subscription_source",
			message: `拓展「${extensionId}」的清单读不出来(${entry.state}),认不出它是不是订阅源`,
		};
	}
	if (manifest.apiVersion !== 2) {
		return {
			error: "not_subscription_source",
			message: `拓展「${manifest.name}」(${extensionId})是 v1 清单,v1 的契约里没有订阅源`,
		};
	}
	if (!manifest.contributes.subscription) {
		return {
			error: "not_subscription_source",
			message: `拓展「${manifest.name}」(${extensionId})的清单没开订阅源这一口(contributes.subscription)`,
		};
	}
	return undefined;
}

function isNotFound(err: ConfigValidationError): boolean {
	const issues = err.issues as { message?: string } | undefined;
	return issues?.message === "subscription not found" || issues?.message === "target not found";
}

/** B-station search wraps matched keywords with `<em class="keyword">…</em>`. */
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
