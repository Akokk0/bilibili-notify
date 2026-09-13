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
 *   一律 409 并把用家列出来。不拦的话,删完出图静默回落默认皮肤,而主人只会觉得
 *   「皮肤突然没了」——「失去界面入口的老字段仍被直读」那一族的同款。
 * - **`:id` 一律先过 `CardSkinIdSchema`**。它要拼进磁盘路径,而 store 那头虽然自己也挡
 *   (`index.has` + 白名单正则),门口这一道让「id 写错了」与「没这套皮肤」分得开。
 */

import type {
	CardSkinDuplicateResponse,
	CardSkinFallback,
	CardSkinInstallResponse,
	CardSkinInUseResponse,
	CardSkinListResponse,
	CardSkinManifestResponse,
	CardSkinSaveResponse,
} from "@bilibili-notify/contract";
import { CardSkinIdSchema, DEFAULT_CARD_SKIN_ID } from "@bilibili-notify/internal";
import { type Context, Hono } from "hono";
import { MAX_CARD_SKIN_TOTAL_BYTES } from "../card-skins/package.js";
import { CardSkinPackageError, type CardSkinStore } from "../card-skins/store.js";
import type { ConfigStore } from "../config/store.js";
import { FONT_EXT_TO_MIME } from "../runtime/font-mime.js";
import { EXT_TO_MIME } from "../runtime/image-mime.js";
import { uploadBodyLimit } from "./upload-limit.js";

/**
 * 卡片皮肤包 zip 的入口上限。**从包自己的上限算出来**,不另拍一个数:满配包
 * (12 份资产 + 顶格清单)解压后就是这么大,而 zip 只会更小 —— 这条线因此**不可能
 * 误伤一份合法的包**,又把明显的巨物挡在 `parseBody()` 之前(那一步会把整个 body
 * 实体化进堆,而镜像里 old-space 只有 512MB)。真正的 zip-bomb 两道闸在 package.ts。
 */
const MAX_CARD_SKIN_ZIP_BYTES = MAX_CARD_SKIN_TOTAL_BYTES;

/** 「这个 id 没有皮肤」。装包 / 保存两条路的成功体带着 `warnings`,失败体就得带 `errors`。 */
function notFound(c: Context, shape: "err" | "errors" = "err") {
	return shape === "errors"
		? c.json({ ok: false, errors: ["卡片皮肤不存在"] }, 404)
		: c.json({ ok: false, err: "卡片皮肤不存在" }, 404);
}

function badId(c: Context, shape: "err" | "errors" = "err") {
	const msg = "皮肤 id 只准小写字母、数字、连字符";
	return shape === "errors"
		? c.json({ ok: false, errors: [msg] }, 400)
		: c.json({ ok: false, err: msg }, 400);
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
}): Hono {
	const { store, config } = deps;
	const app = new Hono();

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
			return c.json({ ok: false, errors: ["缺少皮肤包文件(multipart 字段 file)"] }, 400);
		}
		try {
			const installed = await store.install(new Uint8Array(await file.arrayBuffer()));
			const res: CardSkinInstallResponse = installed;
			return c.json(res, 201);
		} catch (e) {
			if (e instanceof CardSkinPackageError) return c.json({ ok: false, errors: e.errors }, 400);
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
		if (typeof id !== "string") return c.json({ ok: false, err: "id 必须是皮肤 id" }, 400);
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (!store.has(id)) return notFound(c);
		await config.patchGlobals({ defaults: { cardSkin: id } });
		return c.json({ ok: true });
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
			return c.json({ ok: false, err: "name 必须是文本" }, 400);
		}
		const res: CardSkinDuplicateResponse = await store.duplicate(id, name);
		return c.json(res, 201);
	});

	app.delete("/:id", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		if (id === DEFAULT_CARD_SKIN_ID) {
			return c.json({ ok: false, err: "内置的默认皮肤删不掉 —— 想改它请先「复制一份」" }, 400);
		}
		if (!store.has(id)) return notFound(c);
		const global = config.getGlobals().defaults.cardSkin === id;
		const subscriptions = config
			.getSubscriptions()
			.filter((s) => s.overrides?.cardSkin === id)
			.map((s) => s.name || s.uid);
		if (global || subscriptions.length > 0) {
			const who = [
				...(global ? ["全局默认"] : []),
				...(subscriptions.length > 0 ? [`${subscriptions.join("、")} 单独指定了它`] : []),
			].join("，");
			const body: CardSkinInUseResponse = {
				ok: false,
				err: `这套皮肤还在用（${who}），换掉之后再删`,
				usedBy: { global, subscriptions },
			};
			return c.json(body, 409);
		}
		await store.remove(id);
		return c.json({ ok: true });
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
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c, "errors");
		if (id === DEFAULT_CARD_SKIN_ID) {
			return c.json({ ok: false, errors: ["内置的默认皮肤改不了 —— 想改它请先「复制一份」"] }, 400);
		}
		if (!store.has(id)) return notFound(c, "errors");
		const body = await c.req.json().catch(() => null);
		if (body === null) return c.json({ ok: false, errors: ["请求体不是合法 JSON"] }, 400);
		try {
			const res: CardSkinSaveResponse = await store.save(id, body);
			return c.json(res);
		} catch (e) {
			if (e instanceof CardSkinPackageError) return c.json({ ok: false, errors: e.errors }, 400);
			throw e;
		}
	});

	app.get("/:id/assets/:name", async (c) => {
		const id = c.req.param("id");
		if (!CardSkinIdSchema.safeParse(id).success) return badId(c);
		// store 那头按白名单正则认名字(`assets/` 一级 + 后缀),`..` 与 `/` 连正则都进不来。
		const data = await store.readAsset(id, `assets/${c.req.param("name")}`);
		if (!data) return c.json({ ok: false, err: "资产不存在" }, 404);
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
