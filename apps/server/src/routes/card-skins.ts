/**
 * 卡片皮肤库 API(ADR-0014 决策 2 / 5 / 17)。上传是 multipart zip(闸在 parseBody 之前,
 * 见 upload-limit.ts);校验 / 清洗 / 路径穿越防御在 `card-skins/package.ts` 与
 * `card-skins/store.ts`,这里只做 wire。
 *
 * 与 dashboard 皮肤路由(`skins.ts`)刻意的三处不同:
 *
 * - **启用指针不在店里**,在配置里(`globals.defaults.cardSkin`)。`PUT /active` 走
 *   `patchGlobals` —— 店不认识配置,配置也不该认识店。
 * - **删之前先问「谁在用」**:全局指着它、或任一订阅的 `overrides.cardSkin` 指着它,
 *   一律 `conflict`(409)并把用家点名写进 `message`。不拦的话,删完出图静默回落默认皮肤,而主人只会觉得
 *   「皮肤突然没了」——「失去界面入口的老字段仍被直读」那一族的同款。
 * - **`:id` 一律先过 `CardSkinIdSchema`**。它要拼进磁盘路径,而 store 那头虽然自己也挡
 *   (`index.has` + 白名单正则),门口这一道让「id 写错了」与「没这套皮肤」分得开。
 */

import {
	CARD_SKIN_AI_INSTRUCTION_MAX,
	type CardSkinAiCssEvent,
	type CardSkinDuplicateResponse,
	type CardSkinFallback,
	type CardSkinInstallResponse,
	type CardSkinListResponse,
	type CardSkinManifestResponse,
	type CardSkinPreviewResponse,
	type CardSkinSaveResponse,
} from "@bilibili-notify/contract";
import {
	CARD_SKIN_LIMITS,
	CardSkinIdSchema,
	CardSkinKindSchema,
	DEFAULT_CARD_SKIN_ID,
	fail,
	issuesFromZod,
	ok,
	parseCardSkin,
	subscriptionIdentityOf,
} from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { buildCardCssAiSystem, prepareCardCssAi, runCardCssAiRound } from "../card-skins/ai-css.js";
import { MAX_CARD_SKIN_TOTAL_BYTES } from "../card-skins/package.js";
import { renderSkinPreviewHtml } from "../card-skins/preview-html.js";
import { CardSkinPackageError, type CardSkinStore } from "../card-skins/store.js";
import type { ConfigStore } from "../config/store.js";
import { FONT_EXT_TO_MIME } from "../runtime/font-mime.js";
import { EXT_TO_MIME } from "../runtime/image-mime.js";
import { failureOfChecks, listUsers } from "../util/failure-text.js";
import { readJsonBody } from "./request-body.js";
import { errorBodyOf, respondFailure } from "./respond-failure.js";
import { uploadBodyLimit } from "./upload-limit.js";

/**
 * 卡片皮肤包 zip 的入口上限。**从包自己的上限算出来**,不另拍一个数:满配包
 * (12 份资产 + 顶格清单)解压后就是这么大,而 zip 只会更小 —— 这条线因此**不可能
 * 误伤一份合法的包**,又把明显的巨物挡在 `parseBody()` 之前(那一步会把整个 body
 * 实体化进堆,而镜像里 old-space 只有 512MB)。真正的 zip-bomb 两道闸在 package.ts。
 */
const MAX_CARD_SKIN_ZIP_BYTES = MAX_CARD_SKIN_TOTAL_BYTES;

/** 预览请求体。`manifest` 不在这儿校形 —— 它要过的是装包门那一整套,比 zod 这层严得多。 */
const PreviewBodySchema = z.object({
	kind: CardSkinKindSchema,
	scene: z.string().max(40).optional(),
	manifest: z.unknown(),
});

/** 「请女仆帮忙写」的请求体。草稿同预览那条,形状交给装包门去判。 */
const AiCssBodySchema = z.object({
	kind: CardSkinKindSchema,
	blockId: z.string().max(64).optional(),
	instruction: z.string().trim().min(1).max(CARD_SKIN_AI_INSTRUCTION_MAX),
	manifest: z.unknown(),
});

/**
 * 编辑器那口 AI 要的最小面;engines.commentary 的 `generateRaw` 即是。
 * 第三个参数(字数进度)这条路用不着 —— 字本身就流到框里了。
 */
export interface CardCssAiEngine {
	generateRaw(
		system: string,
		user: string,
		onProgress: undefined,
		stream: { onText: (text: string) => void; signal?: AbortSignal },
	): Promise<string>;
}

/** 「这个 id 没有皮肤」。失败只有一种形状(ADR-0026):`{ code: "not_found", message }`。 */
function notFound(c: Context) {
	return respondFailure(c, fail("not_found", "卡片皮肤不存在"));
}

function badId(c: Context) {
	return respondFailure(c, fail("invalid", "皮肤 id 只准小写字母、数字、连字符"));
}

export function createCardSkinsRoute(deps: {
	store: CardSkinStore;
	config: ConfigStore;
	/** 开机读盘跳过了哪些目录 —— 只打一次,别让皮肤悄悄消失。 */
	logger?: { warn: (msg: string) => void };
	/**
	 * 出图回落的账本(`card-skins/fallbacks.ts`)。列表里带上它,面板才看得见
	 * 「皮肤 XX 渲染失败已回落」——ADR-0014 决策 19 的「回落必须可见」。没接 = 空。
	 */
	fallbacks?: () => CardSkinFallback[];
	/** 面板上那句「知道了」:账本是一次性痕迹,看过就该翻篇(见 `card-skins/fallbacks.ts`)。 */
	clearFallbacks?: () => void;
	/** AI 引擎,**热读**:engines 是后挂的,每次现取。`null` = 没配模型。 */
	commentary?: () => CardCssAiEngine | null;
}): Hono {
	const { store, config } = deps;
	const app = new Hono();
	/** CSS 助手的 system 只由常量拼成,拼一次就够(同 `routes/ai.ts` 的卡片工坊那份)。 */
	const cssAiSystem = buildCardCssAiSystem();

	// createApp 是同步装配,读盘重建索引推迟到首个请求(同 dashboard 皮肤库)。
	// init 的 warnings 跟着这一次性凭据走:每次请求都刷一遍等于把日志淹了。
	let ready: Promise<void> | undefined;
	app.use("*", async (_c, next) => {
		ready ??= (async () => {
			await store.ensureReady();
			for (const w of store.warnings()) deps.logger?.warn(`[card-skin] ${w}`);
		})();
		await ready;
		await next();
	});

	app.get("/", (c) => {
		const body: CardSkinListResponse = {
			skins: store.list(),
			active: config.getGlobals().defaults.cardSkin,
			fallbacks: deps.fallbacks?.() ?? [],
		};
		return c.json(body);
	});

	app.post("/", uploadBodyLimit(MAX_CARD_SKIN_ZIP_BYTES, "卡片皮肤包"), async (c) => {
		const body = await c.req.parseBody().catch(() => null);
		const file = body?.file;
		if (!(file instanceof File)) {
			return respondFailure(c, fail("invalid", "缺少皮肤包文件(multipart 字段 file)"));
		}
		try {
			const installed = await store.install(new Uint8Array(await file.arrayBuffer()));
			const res: CardSkinInstallResponse = installed;
			return c.json(res, 201);
		} catch (e) {
			if (e instanceof CardSkinPackageError) return respondFailure(c, e.toFailure("这个皮肤包"));
			throw e;
		}
	});

	/**
	 * 全局换皮肤。**静态段必须抢在 `/:id` 前面注册** —— `active` 本身就长得像一个合法
	 * id(`CardSkinIdSchema` 认它),掉进 `PUT /:id` 的话主人收到的是「皮肤不存在」。
	 */
	app.put("/active", async (c) => {
		const body = await c.req.json().catch(() => null);
		const id = body && typeof body === "object" ? (body as { id?: unknown }).id : null;
		if (typeof id !== "string") return respondFailure(c, fail("invalid", "id 必须是皮肤 id"));
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (!store.has(id)) return notFound(c);
		await config.patchGlobals({ defaults: { cardSkin: id } });
		return c.json(ok());
	});

	app.get("/:id", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		const manifest = store.get(id);
		if (!manifest) return notFound(c);
		const body: CardSkinManifestResponse = { manifest, assets: await store.listAssets(id) };
		return c.json(body);
	});

	app.post("/:id/duplicate", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (!store.has(id)) return notFound(c);
		const body = await c.req.json().catch(() => null);
		const name = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
		if (name !== undefined && typeof name !== "string") {
			return respondFailure(c, fail("invalid", "name 必须是文本"));
		}
		const res: CardSkinDuplicateResponse = await store.duplicate(id, name);
		// 拧好的设置跟着走(2026-09-14 主人拍板):旋钮覆盖按皮肤 id 存,副本是新 id,不抄
		// 一份的话「复制一份再改」会先把人拧好的配色清零。没拧过就什么都不写 —— 空覆盖是
		// 残渣,且「键在不在」正是面板判「动没动过」的依据。
		const srcKnobs = config.getGlobals().defaults.cardSkinKnobs?.[id];
		if (srcKnobs && Object.keys(srcKnobs).length > 0) {
			await config.patchGlobals({ defaults: { cardSkinKnobs: { [res.id]: { ...srcKnobs } } } });
		}
		return c.json(res, 201);
	});

	// **注册在 `/:id` 之前**:排在后面的话 `/fallbacks` 会先被当成一个皮肤 id,主人点
	// 「知道了」收到的是一句「id 不合法」。同 `PUT /active` 与 `PUT /:id` 那一对。
	app.delete("/fallbacks", (c) => {
		deps.clearFallbacks?.();
		return c.json(ok());
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (id === DEFAULT_CARD_SKIN_ID) {
			return respondFailure(c, fail("conflict", "内置的默认皮肤删不掉 —— 想改它请先「复制一份」"));
		}
		if (!store.has(id)) return notFound(c);
		const global = config.getGlobals().defaults.cardSkin === id;
		// 所有订阅都算(ADR-0019 决策 47):拓展订阅也能单独指定皮肤,漏看它就会删掉一套
		// 还有人在用的皮肤。用身份里的外部 id 指认(B 站就是 uid)。
		const subscriptions = config
			.getSubscriptions()
			.filter((s) => s.overrides?.cardSkin === id)
			.map((s) => subscriptionIdentityOf(s).externalId);
		if (global || subscriptions.length > 0) {
			// 用家点名并进 `message`(不另占一格 `usedBy`):订阅多了只列前几个,后面报个数。
			const who = [
				...(global ? ["全局默认"] : []),
				...(subscriptions.length > 0 ? [`${listUsers(subscriptions)} 单独指定了它`] : []),
			].join("，");
			return respondFailure(c, fail("conflict", `这套皮肤还在用（${who}），换掉之后再删`));
		}
		await store.remove(id);
		return c.json(ok());
	});

	// 导出:manifest + 全部资产打回标准 zip,和装包收的是同一种包(往返闭环)。
	app.get("/:id/export", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		const manifest = store.get(id);
		if (!manifest) return notFound(c);
		// `new Uint8Array(...)` 不是多余的一层:fflate 交回的是 `Uint8Array<ArrayBufferLike>`,
		// 而 hono 的 body 只收 `Uint8Array<ArrayBuffer>`(SharedArrayBuffer 不能当响应体)。
		return c.body(new Uint8Array(await store.exportZip(id)), 200, {
			"content-type": "application/zip",
			// 皮肤名是主人写的任意文本(引号 / 换行 / 分号都可能有),整段 percent-encode
			// 之后塞 `filename*` —— 拼进 header 之前就没有能越出这个字段的字符了。
			"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(manifest.name)}.zip`,
		});
	});

	// 编辑器保存:与装包同一道验+洗,只是资产清单来自盘上。
	app.put("/:id", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (id === DEFAULT_CARD_SKIN_ID) {
			return respondFailure(c, fail("conflict", "内置的默认皮肤改不了 —— 想改它请先「复制一份」"));
		}
		if (!store.has(id)) return notFound(c);
		const read = await readJsonBody(c);
		if (!read.ok) return respondFailure(c, read);
		try {
			const res: CardSkinSaveResponse = await store.save(id, read.body);
			return c.json(res);
		} catch (e) {
			if (e instanceof CardSkinPackageError) return respondFailure(c, e.toFailure());
			throw e;
		}
	});

	/**
	 * 编辑器的实时预览(决策 22):草稿清单 + 出厂示例数据 → **一整份 HTML**。
	 *
	 * 回 HTML 不回图,是为了「没装 Chrome 也能编皮肤」—— 走截图的话这一条当场没了。
	 * 像素级与截图仍有细微差(这边是看的人的浏览器在画,那边是 server 上的 Chrome),
	 * 所以面板上「最终效果」那颗按钮还得留着。
	 *
	 * **草稿走的是与保存同一道装包门**:预览要显示的是「存下去之后长什么样」。两边各走
	 * 各的话,作者会看着一个能用的预览、存出一套被清洗器削过的皮肤,而两边都说不出哪儿
	 * 错了 —— `warnings` 跟着一起回,削掉了什么当场就看得见。
	 */
	app.post("/:id/preview", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		// 资产(图 / 字体)仍住在**已存盘**那套皮肤的目录里 —— 草稿只带清单,引用的是名字。
		if (!store.has(id)) return notFound(c);
		const parsed = PreviewBodySchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail("invalid", "请求体要 { kind, scene?, manifest }", {
					issues: issuesFromZod(parsed.error),
				}),
			);
		}
		const { kind, scene, manifest: raw } = parsed.data;

		// 「清单 → HTML」那一步与「最终效果」截图共用(见 `card-skins/preview-html.ts`):
		// 两边必须同源,否则预览能用而截图不一样,谁也说不出哪儿错了。
		const out = await renderSkinPreviewHtml({
			store,
			skinId: id,
			kind,
			scene,
			manifest: raw,
			// 这条回的 HTML 是塞进编辑器的 iframe 看的 —— 卡外那片默认白底不该在。
			// 截图那条(`POST /api/cards/skin-shot`)不开,见 `transparentPage` 的说明。
			transparentPage: true,
		});
		if (!out.ok) return respondFailure(c, failureOfChecks("invalid", "这版草稿", out.errors));
		const body: CardSkinPreviewResponse = {
			html: out.html,
			width: out.width,
			warnings: out.warnings,
			scene: out.scene,
		};
		return c.json(body);
	});

	/**
	 * CSS 框旁那颗「请女仆帮忙写」(ADR-0015 决策 3–10)。
	 *
	 * 能拒的都在开流**之前**拒,回普通 JSON —— 开了流再报错,前端得在两种形状里分辨。
	 * 默认皮肤也在这儿拒:它的草稿存不下来,「复制一份」复制的又是出厂那份,写了白烧 key。
	 *
	 * 客户端断开就是用户点了「停」:流的 `onAbort` 与请求自己的信号都接到同一个控制器上,
	 * 到模型的请求跟着掐断(见 `generateRaw` 的 `signal`)。
	 */
	app.post("/:id/ai-css", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (id === DEFAULT_CARD_SKIN_ID) {
			return respondFailure(
				c,
				fail("conflict", "内置的默认皮肤改不了 —— 先「复制一份」再请女仆写"),
			);
		}
		if (!store.has(id)) return notFound(c);
		const parsed = AiCssBodySchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) {
			return respondFailure(
				c,
				fail(
					"invalid",
					`请求体要 { kind, blockId?, instruction(1~${CARD_SKIN_AI_INSTRUCTION_MAX} 字), manifest }`,
					{ issues: issuesFromZod(parsed.error) },
				),
			);
		}
		const engine = deps.commentary?.() ?? null;
		if (!engine) {
			// `commentary` 回 null 分不出「没配模型」与「引擎还没挂上」;那句话本来就是叫主人去接模型,按没配。
			return respondFailure(
				c,
				fail("not_configured", "还没配好模型 —— 先到「智能女仆」页接好模型"),
			);
		}
		const draft = parseCardSkin(parsed.data.manifest);
		if (!draft.ok) return respondFailure(c, failureOfChecks("invalid", "这版草稿", draft.errors));
		const { kind, blockId, instruction } = parsed.data;
		const prepared = prepareCardCssAi(draft.manifest, { kind, blockId });
		if (!prepared.ok) return respondFailure(c, fail("invalid", prepared.error));

		const abort = new AbortController();
		const stop = () => abort.abort();
		c.req.raw.signal.addEventListener("abort", stop, { once: true });

		return streamSSE(c, async (sse) => {
			sse.onAbort(stop);
			const send = (e: CardSkinAiCssEvent) =>
				sse.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
			try {
				const res = await runCardCssAiRound({
					generate: (system, user, stream) => engine.generateRaw(system, user, undefined, stream),
					system: cssAiSystem,
					user: prepared.user(instruction),
					sanitize: prepared.sanitize,
					onRule: (text) => void send({ event: "rule", data: { text } }),
					onRetry: (errors) =>
						void send({
							event: "retry",
							data: { issues: errors.map((message) => ({ message })) },
						}),
					signal: abort.signal,
				});
				// 错误帧与非 2xx 的错误体同形(`{ code, message, issues? }`):两趟都没过清洗器是 `invalid`,
				// 清洗器逐条的意见进 `issues`。
				await send(
					res.ok
						? { event: "done", data: { css: res.css, warnings: res.warnings } }
						: {
								event: "error",
								data: errorBodyOf(
									failureOfChecks("invalid", "女仆写的样式", res.errors, { listSingle: true }),
								),
							},
				);
			} catch (e) {
				// 被掐的那一种没人在听了,不必再写。
				if (abort.signal.aborted) return;
				// 生成本身失败(模型那头的错、网络):对端给的原因就是主人要看的,原话进 `message`。
				const reason = e instanceof Error ? e.message : String(e);
				await send({
					event: "error",
					data: errorBodyOf(fail("unavailable", `女仆那边没写成：${reason}`)),
				});
			} finally {
				c.req.raw.signal.removeEventListener("abort", stop);
			}
		});
	});

	/**
	 * 这套皮肤盘上有哪些资产。编辑器照它画「自带字体」那张表的候选 —— 清单里的
	 * `asset:assets/<文件>` 只能指包内文件,候选表就是这一份。
	 */
	app.get("/:id/assets", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (!store.has(id)) return notFound(c);
		return c.json({ assets: await store.listAssets(id) });
	});

	/**
	 * 往一套已存盘的皮肤里传一份资产(图或字体)。**闸全在店里** —— 名字白名单、单份体积、
	 * 份数上限与装包门同一把尺,这儿只做 wire。
	 *
	 * 回的是**清单里该写的那个名字**(`assets/<文件>`):作者要照它写 `asset:assets/<文件>`,
	 * 而落盘时名字被小写过,回一句「传好了」他就得自己猜。
	 */
	app.post(
		"/:id/assets",
		uploadBodyLimit(CARD_SKIN_LIMITS.maxAssetBytes, "皮肤资产"),
		async (c) => {
			const id = c.req.param("id");
			if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
			if (!store.has(id)) return notFound(c);
			const body = await c.req.parseBody().catch(() => null);
			const file = body?.file;
			if (!(file instanceof File)) {
				return respondFailure(c, fail("invalid", "缺少文件(multipart 字段 file)"));
			}
			try {
				const added = await store.addAsset(id, file.name, new Uint8Array(await file.arrayBuffer()));
				return c.json(added, 201);
			} catch (e) {
				if (e instanceof CardSkinPackageError) return respondFailure(c, e.toFailure());
				throw e;
			}
		},
	);

	/**
	 * 删一份资产。**清单还引用着 → `conflict`(409)并把用家写进 `message`**(同「删皮肤先问谁在用」那条):
	 * 删了之后这套皮肤连自己都存不下去,而主人看到的只会是下次保存时一句莫名其妙的报错。
	 */
	app.delete("/:id/assets/:name", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (!store.has(id)) return notFound(c);
		try {
			await store.removeAsset(id, c.req.param("name"));
			return c.json(ok());
		} catch (e) {
			// 「还被用着」(`conflict`,换掉引用就能删)与「名字不合法」(`invalid`)都从店里抛,码由店里带,
			// 这里不再按话分档。
			if (e instanceof CardSkinPackageError) return respondFailure(c, e.toFailure());
			throw e;
		}
	});

	app.get("/:id/assets/:name", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		// store 那头按白名单正则认名字(`assets/` 一级 + 后缀),`..` 与 `/` 连正则都进不来。
		const data = await store.readAsset(id, `assets/${c.req.param("name")}`);
		if (!data) return respondFailure(c, fail("not_found", "资产不存在"));
		const ext = c.req.param("name").split(".").pop()?.toLowerCase() ?? "";
		return c.body(new Uint8Array(data), 200, {
			// 图与字体两张表都查一遍 —— 字体给错 content-type 浏览器直接不认这份 @font-face。
			"content-type": EXT_TO_MIME[ext] ?? FONT_EXT_TO_MIME[ext] ?? "application/octet-stream",
			// 皮肤资产内容不可变(改资产 = 换名字),放心长缓存。
			"cache-control": "public, max-age=31536000, immutable",
		});
	});

	return app;
}
