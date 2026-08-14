/**
 * 皮肤库 API。上传是 multipart zip(闸在 parseBody 之前,见 upload-limit.ts);
 * 校验/白名单/路径穿越防御在 skins/package.ts 与 skins/store.ts,这里只做 wire。
 */

import { readFile } from "node:fs/promises";
import type { ActiveSkinResponse, SkinsListResponse } from "@bilibili-notify/contract";
import { Hono } from "hono";
import { openSkinPackage } from "../skins/package.js";
import type { SkinStore } from "../skins/store.js";
import { uploadBodyLimit } from "./upload-limit.js";

const MAX_SKIN_ZIP_BYTES = 10 * 1024 * 1024;

const ASSET_MIME: Record<string, string> = {
	png: "image/png",
	webp: "image/webp",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
};

export function createSkinsRoute(deps: { skinStore: SkinStore }): Hono {
	const { skinStore } = deps;
	const app = new Hono();

	// createApp 是同步装配,init(读盘重建索引)推迟到首个请求;幂等,测试里先 init 过也无害。
	let ready: Promise<void> | undefined;
	app.use("*", async (_c, next) => {
		ready ??= skinStore.init();
		await ready;
		await next();
	});

	app.get("/", async (c) => {
		const body: SkinsListResponse = {
			list: await skinStore.list(),
			activeId: skinStore.getActive(),
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
		const { id } = await skinStore.save({ manifest: opened.manifest, assets: opened.assets });
		return c.json({ ok: true, id, warnings: opened.warnings }, 201);
	});

	app.get("/active", async (c) => {
		const id = skinStore.getActive();
		const manifest = id ? await skinStore.get(id) : null;
		const body: ActiveSkinResponse = {
			active: id && manifest ? { id, manifest } : null,
		};
		return c.json(body);
	});

	app.put("/active", async (c) => {
		const body = await c.req.json().catch(() => null);
		const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
		if (id !== null && typeof id !== "string") {
			return c.json({ ok: false, err: "id 必须是皮肤 id 或 null" }, 400);
		}
		if (id !== null && !(await skinStore.get(id))) {
			return c.json({ ok: false, err: "皮肤不存在" }, 404);
		}
		await skinStore.setActive(id);
		return c.json({ ok: true });
	});

	app.get("/:id/manifest", async (c) => {
		const manifest = await skinStore.get(c.req.param("id"));
		if (!manifest) return c.json({ ok: false, err: "皮肤不存在" }, 404);
		return c.json({ manifest });
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
			"content-type": ASSET_MIME[ext] ?? "application/octet-stream",
			// 皮肤资产内容不可变(改皮肤 = 新 id),放心长缓存。
			"cache-control": "public, max-age=31536000, immutable",
		});
	});

	return app;
}
