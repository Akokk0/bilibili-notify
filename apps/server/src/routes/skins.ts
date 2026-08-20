/**
 * 皮肤库 API。上传是 multipart zip(闸在 parseBody 之前,见 upload-limit.ts);
 * 校验/白名单/路径穿越防御在 skins/package.ts 与 skins/store.ts,这里只做 wire。
 */

import { readFile } from "node:fs/promises";
import type {
	ActiveSkinResponse,
	SkinDefaultResponse,
	SkinManifestResponse,
	SkinsListResponse,
} from "@bilibili-notify/contract";
import { strToU8, zipSync } from "fflate";
import { Hono } from "hono";
import { FONT_EXT_TO_MIME, fontExtOf } from "../runtime/font-mime.js";
import { EXT_TO_MIME, MIME_TO_EXT } from "../runtime/image-mime.js";
import { runSkinAiEdit, type SkinAiGenerator } from "../skins/ai-edit.js";
import { ASSET_NAMES_FILE } from "../skins/asset-names.js";
import { MAX_FONT_BYTES, openSkinPackage, referencedAssets } from "../skins/package.js";
import { parseSkinManifest } from "../skins/schema.js";
import type { SkinStore } from "../skins/store.js";
import { uploadBodyLimit } from "./upload-limit.js";

/**
 * 皮肤包 zip 的上限。
 *
 * 从 10MB 抬到 30MB 是为自带字体:一款完整中文 woff2 就有八九兆,而 woff2 本身
 * 已经压过,进 zip 几乎不缩水 —— 10MB 那条线会让一套带字体的皮肤**传不回自己的
 * 导出**(导得出、装不回,往返闭环就断了)。
 */
const MAX_SKIN_ZIP_BYTES = 30 * 1024 * 1024;

export function createSkinsRoute(deps: {
	skinStore: SkinStore;
	/** 活的 AI 生成器热读口;null = AI 未配置/未就绪(ai-edit 回 503)。 */
	commentary?: () => SkinAiGenerator | null;
}): Hono {
	const { skinStore } = deps;
	const app = new Hono();

	// createApp 是同步装配,读盘重建索引推迟到首个请求。凭据记在 store 上而不是这里
	// ——聊天里的 create_skin 用的是**同一个实例**,它也得能把这一步补上(见 ensureReady)。
	app.use("*", async (_c, next) => {
		await skinStore.ensureReady();
		await next();
	});

	app.get("/", async (c) => {
		const body: SkinsListResponse = {
			list: await skinStore.list(),
			active: skinStore.getActive(),
		};
		return c.json(body);
	});

	app.post("/", uploadBodyLimit(MAX_SKIN_ZIP_BYTES, "皮肤包"), async (c) => {
		const body = await c.req.parseBody().catch(() => null);
		const file = body?.file;
		if (!(file instanceof File)) {
			return c.json({ ok: false, errors: ["缺少皮肤包文件(multipart 字段 file)"] }, 400);
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		const opened = openSkinPackage(bytes);
		if (!opened.ok) return c.json({ ok: false, errors: opened.errors }, 400);
		const { id } = await skinStore.save({
			manifest: opened.manifest,
			assets: opened.assets,
			names: opened.names,
		});
		return c.json({ ok: true, id, warnings: opened.warnings }, 201);
	});

	app.get("/active", async (c) => {
		const ids = skinStore.getActive();
		const slot = async (id: string | null) => {
			const manifest = id ? await skinStore.get(id) : null;
			return id && manifest ? { id, manifest } : null;
		};
		const body: ActiveSkinResponse = {
			active: { light: await slot(ids.light), dark: await slot(ids.dark) },
		};
		return c.json(body);
	});

	// 不带 theme = 整套启用(按皮肤具备的模式落槽,null 清两槽);带 theme = 单槽设置。
	app.put("/active", async (c) => {
		const body = await c.req.json().catch(() => null);
		const req = body && typeof body === "object" ? (body as { id?: unknown; theme?: unknown }) : {};
		const { id, theme } = req;
		if (id !== null && typeof id !== "string") {
			return c.json({ ok: false, err: "id 必须是皮肤 id 或 null" }, 400);
		}
		if (theme !== undefined && theme !== "light" && theme !== "dark") {
			return c.json({ ok: false, err: "theme 只能是 light 或 dark" }, 400);
		}
		if (id !== null && !(await skinStore.get(id))) {
			return c.json({ ok: false, err: "皮肤不存在" }, 404);
		}
		try {
			if (theme === undefined) await skinStore.activate(id);
			else await skinStore.setActiveSlot(theme, id);
		} catch (e) {
			return c.json({ ok: false, err: String((e as Error).message) }, 400);
		}
		return c.json({ ok: true });
	});

	// 「让女仆改」:AI 产物只回编辑器 draft 做实时预览,**不落盘** —— 保存永远主人点。
	app.post("/:id/ai-edit", async (c) => {
		const id = c.req.param("id");
		if (!(await skinStore.get(id))) return c.json({ ok: false, errors: ["皮肤不存在"] }, 404);
		const generator = deps.commentary?.() ?? null;
		if (!generator) {
			return c.json(
				{ ok: false, errors: ["智能女仆尚未配置或未就绪,先去 AI 设置页接好模型"] },
				503,
			);
		}
		const body = await c.req.json().catch(() => null);
		const instruction =
			body && typeof body === "object" ? (body as { instruction?: unknown }).instruction : null;
		const draft = body && typeof body === "object" ? (body as { draft?: unknown }).draft : null;
		if (typeof instruction !== "string" || instruction.trim() === "" || instruction.length > 2000) {
			return c.json({ ok: false, errors: ["修改要求必须是 1~2000 字的文本"] }, 400);
		}
		if (typeof draft !== "object" || draft === null) {
			return c.json({ ok: false, errors: ["draft 必须是当前 manifest 对象"] }, 400);
		}
		const result = await runSkinAiEdit({
			generateRaw: (s, u) => generator.generateRaw(s, u),
			assets: await skinStore.listAssets(id),
			draft,
			instruction: instruction.trim(),
		});
		if (!result.ok) return c.json(result, 422);
		return c.json(result);
	});

	app.get("/:id/manifest", async (c) => {
		const id = c.req.param("id");
		const manifest = await skinStore.get(id);
		if (!manifest) return c.json({ ok: false, err: "皮肤不存在" }, 404);
		// assets 给编辑器画两个下拉,assetNames 给它们当标签(盘上是生成名,
		// 光有 hex 主人认不出哪个是哪个)。试穿路径拿到也无害。
		const body: SkinManifestResponse = {
			manifest,
			assets: await skinStore.listAssets(id),
			assetNames: await skinStore.assetNames(id),
		};
		return c.json(body);
	});

	/**
	 * 编辑器里往这套皮肤加一份资产:壁纸图,或主人自带的字体。加完就能在对应的
	 * 下拉里选中它。
	 *
	 * 没有这个口子时,给一套皮肤换壁纸得导出 zip、塞图、改 JSON、再传回来 ——
	 * 而聊天里做出来的皮肤天生零资产,那条路等于没有壁纸可言。
	 *
	 * **入口闸按两者中大的那条(字体 20MB)开**,真正的分类限额在 `addAsset` 里按
	 * 类型各判各的。这道闸管的是「这次请求能往堆里塞多少」,不是「这个文件多大」;
	 * 按图片那条 5MB 开的话,合规的字体连 parseBody 都进不来,主人收到的会是 413。
	 */
	app.post("/:id/assets", uploadBodyLimit(MAX_FONT_BYTES, "文件"), async (c) => {
		const id = c.req.param("id");
		if (!(await skinStore.get(id))) return c.json({ ok: false, err: "皮肤不存在" }, 404);
		const body = await c.req.parseBody().catch(() => null);
		const file = body?.file;
		if (!(file instanceof File)) {
			return c.json({ ok: false, err: "缺少文件(multipart 字段 file)" }, 400);
		}
		/**
		 * 图**按 mime 定扩展名**(各家浏览器给得准),字体**按文件名后缀**。
		 *
		 * 不是图省事:同一个 .ttf,浏览器给的可能是 `font/ttf`、`application/x-font-ttf`、
		 * `application/octet-stream`,甚至空串 —— 照 mime 判会把一堆正常字体拒在门外
		 * (卡片字体图廊那边踩过并写进了 `font-mime.ts`)。两条路都不把上传的文件名
		 * 拼进磁盘路径:落盘名由 store 自己生成。
		 */
		const ext = MIME_TO_EXT[file.type] ?? fontExtOf(file.name);
		if (!ext) {
			return c.json(
				{ ok: false, err: "只收 PNG / JPEG / WebP 图片,或 woff2 / woff / ttf / otf 字体" },
				400,
			);
		}
		try {
			// 原始文件名只进原名清单(纯显示),**绝不进磁盘路径 / URL / CSS**。
			const name = await skinStore.addAsset(
				id,
				new Uint8Array(await file.arrayBuffer()),
				ext,
				file.name,
			);
			return c.json({ ok: true, name }, 201);
		} catch (e) {
			return c.json({ ok: false, err: e instanceof Error ? e.message : String(e) }, 400);
		}
	});

	// 编辑器保存:就地更新 manifest(资产不动)。校验与 zip 上传同权威:
	// parseSkinManifest + 「引用的图/字体必须在包里」同一把尺(referencedAssets)。
	app.put("/:id/manifest", async (c) => {
		const id = c.req.param("id");
		if (!(await skinStore.get(id))) return c.json({ ok: false, errors: ["皮肤不存在"] }, 404);
		const body = await c.req.json().catch(() => null);
		if (body === null) return c.json({ ok: false, errors: ["请求体不是合法 JSON"] }, 400);
		const parsed = parseSkinManifest(body);
		if (!parsed.ok) return c.json({ ok: false, errors: parsed.errors }, 400);

		const assets = new Set(await skinStore.listAssets(id));
		const missing = [...referencedAssets(parsed.skin)].filter((name) => !assets.has(name));
		if (missing.length > 0) {
			return c.json(
				{ ok: false, errors: missing.map((m) => `${m}: manifest 引用了它,但包里没有这个文件`) },
				400,
			);
		}
		await skinStore.updateManifest(id, parsed.skin);
		return c.json({ ok: true, warnings: parsed.warnings });
	});

	// 出厂快照:GET 读基准(「恢复默认值」的数据源,前端拉回编辑器 draft 预览,
	// 落盘仍走主人点保存);PUT 把当前 manifest 钉成新基准(「设为默认值」)。
	// 上传时快照自动 = 上传内容;存量皮肤(无快照)GET 404,先 PUT 补钉。
	app.get("/:id/default", async (c) => {
		const id = c.req.param("id");
		if (!(await skinStore.get(id))) return c.json({ ok: false, err: "皮肤不存在" }, 404);
		const manifest = await skinStore.getDefault(id);
		if (!manifest) return c.json({ ok: false, err: "该皮肤还没有钉过默认值" }, 404);
		const body: SkinDefaultResponse = { manifest };
		return c.json(body);
	});

	app.put("/:id/default", async (c) => {
		const id = c.req.param("id");
		if (!(await skinStore.get(id))) return c.json({ ok: false, err: "皮肤不存在" }, 404);
		await skinStore.setDefault(id);
		return c.json({ ok: true });
	});

	// 导出皮肤包:manifest + 全部资产打回标准 zip,和上传收的是同一种包(往返闭环)。
	app.get("/:id/export", async (c) => {
		const id = c.req.param("id");
		const manifest = await skinStore.get(id);
		if (!manifest) return c.json({ ok: false, err: "皮肤不存在" }, 404);
		const files: Record<string, Uint8Array> = {
			"skin.json": strToU8(JSON.stringify(manifest, null, "\t")),
		};
		// 原名清单随包走 —— 否则主人把皮肤发给别人,那边下拉里又只剩一串 hex。
		const names = await skinStore.assetNames(id);
		if (Object.keys(names).length > 0) {
			files[ASSET_NAMES_FILE] = strToU8(JSON.stringify(names, null, "\t"));
		}
		// 各张资产之间没有先后关系,一张最大 5MB、最多 12 张 —— 串行读等于把
		// 24 次系统调用排成一条队,而主人在等一个 zip。
		const assets = await Promise.all(
			(await skinStore.listAssets(id)).map(async (name) => {
				const path = await skinStore.assetPath(id, name);
				return path ? ([name, new Uint8Array(await readFile(path))] as const) : null;
			}),
		);
		for (const entry of assets) {
			if (entry) files[entry[0]] = entry[1];
		}
		return c.body(zipSync(files), 200, {
			"content-type": "application/zip",
			"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(manifest.name)}.zip`,
		});
	});

	app.delete("/:id", async (c) => {
		await skinStore.remove(c.req.param("id"));
		return c.json({ ok: true });
	});

	app.get("/:id/assets/:name", async (c) => {
		const path = await skinStore.assetPath(c.req.param("id"), `assets/${c.req.param("name")}`);
		if (!path) return c.json({ ok: false, err: "资产不存在" }, 404);
		const ext = path.split(".").pop()?.toLowerCase() ?? "";
		const data = await readFile(path);
		return c.body(new Uint8Array(data), 200, {
			// 图与字体两张表都查一遍 —— 字体给错 content-type 浏览器直接不认这份 @font-face。
			"content-type": EXT_TO_MIME[ext] ?? FONT_EXT_TO_MIME[ext] ?? "application/octet-stream",
			// 皮肤资产内容不可变(改皮肤 = 新 id),放心长缓存。
			"cache-control": "public, max-age=31536000, immutable",
		});
	});

	return app;
}
