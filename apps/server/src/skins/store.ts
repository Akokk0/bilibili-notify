/**
 * 皮肤库存储:`<skinsDir>/<id>/skin.json + assets/*`,active 指针在
 * `<skinsDir>/active.json`。写入走 tmp → rename(目录级原子);init() 全量读盘
 * 重建,重启不丢。资产路径永远经白名单正则再拼接,杜绝路径穿越。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkinListEntry, SkinManifest } from "@bilibili-notify/contract";
import { WALLPAPER_IMAGE_RE } from "./schema.js";

interface SavedSkin {
	manifest: SkinManifest;
	assets: Map<string, Uint8Array>;
}

export class SkinStore {
	private readonly skinsDir: string;
	private activeId: string | null = null;
	/** id → manifest 内存索引;盘是唯一权威,这里只是读缓存。 */
	private index = new Map<string, SkinManifest>();

	constructor(opts: { skinsDir: string }) {
		this.skinsDir = opts.skinsDir;
	}

	async init(): Promise<void> {
		await mkdir(this.skinsDir, { recursive: true });
		this.index.clear();
		for (const entry of await readdir(this.skinsDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.endsWith(".tmp")) continue;
			try {
				const raw = await readFile(join(this.skinsDir, entry.name, "skin.json"), "utf8");
				this.index.set(entry.name, JSON.parse(raw) as SkinManifest);
			} catch {
				// 残缺目录(写入中断等)不进索引,也不动它 —— 交给人查,别静默删数据。
			}
		}
		this.activeId = null;
		try {
			const raw = JSON.parse(await readFile(join(this.skinsDir, "active.json"), "utf8"));
			if (typeof raw.id === "string" && this.index.has(raw.id)) this.activeId = raw.id;
		} catch {
			// 没有 active.json = 没启用皮肤。
		}
	}

	async save(pkg: SavedSkin): Promise<{ id: string }> {
		const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
		const tmpDir = join(this.skinsDir, `${id}.tmp`);
		await mkdir(join(tmpDir, "assets"), { recursive: true });
		await writeFile(join(tmpDir, "skin.json"), JSON.stringify(pkg.manifest, null, "\t"));
		for (const [name, data] of pkg.assets) {
			if (!WALLPAPER_IMAGE_RE.test(name) || name.includes("..")) continue;
			await writeFile(join(tmpDir, "assets", name.slice("assets/".length)), data);
		}
		await rename(tmpDir, join(this.skinsDir, id));
		this.index.set(id, pkg.manifest);
		return { id };
	}

	async list(): Promise<SkinListEntry[]> {
		return [...this.index.entries()].map(([id, m]) => ({
			id,
			name: m.name,
			...(m.author !== undefined ? { author: m.author } : {}),
			...(m.description !== undefined ? { description: m.description } : {}),
			modes: (["light", "dark"] as const).filter((k) => m.modes[k]),
			hasWallpaper: Boolean(m.modes.light?.wallpaper?.image || m.modes.dark?.wallpaper?.image),
		}));
	}

	async get(id: string): Promise<SkinManifest | null> {
		return this.index.get(id) ?? null;
	}

	/** 包内资产清单(`assets/<名>` 形式,与 manifest 引用同构);皮肤不存在 → 空数组。 */
	async listAssets(id: string): Promise<string[]> {
		if (!this.index.has(id)) return [];
		let names: string[];
		try {
			names = await readdir(join(this.skinsDir, id, "assets"));
		} catch {
			return [];
		}
		return names.map((n) => `assets/${n}`).filter((n) => WALLPAPER_IMAGE_RE.test(n));
	}

	/**
	 * 就地更新 manifest(编辑器保存)。资产一字不动 —— 资产 URL 的 immutable 长缓存
	 * 契约不被破坏,变的只有 skin.json。调用方(路由层)负责先过 parseSkinManifest
	 * 与资产引用校验,这里只管原子落盘。
	 */
	async updateManifest(id: string, manifest: SkinManifest): Promise<void> {
		if (!this.index.has(id)) throw new Error(`皮肤不存在: ${id}`);
		const tmp = join(this.skinsDir, id, "skin.json.tmp");
		await writeFile(tmp, JSON.stringify(manifest, null, "\t"));
		await rename(tmp, join(this.skinsDir, id, "skin.json"));
		this.index.set(id, manifest);
	}

	async remove(id: string): Promise<void> {
		await rm(join(this.skinsDir, id), { recursive: true, force: true });
		this.index.delete(id);
		if (this.activeId === id) await this.setActive(null);
	}

	async setActive(id: string | null): Promise<void> {
		if (id !== null && !this.index.has(id)) {
			throw new Error(`皮肤不存在: ${id}`);
		}
		const tmp = join(this.skinsDir, "active.json.tmp");
		await writeFile(tmp, JSON.stringify({ id }));
		await rename(tmp, join(this.skinsDir, "active.json"));
		this.activeId = id;
	}

	getActive(): string | null {
		return this.activeId;
	}

	/** 资产的磁盘绝对路径;名字不合白名单或文件不存在 → null。 */
	async assetPath(id: string, name: string): Promise<string | null> {
		if (!this.index.has(id)) return null;
		if (!WALLPAPER_IMAGE_RE.test(name) || name.includes("..")) return null;
		const p = join(this.skinsDir, id, "assets", name.slice("assets/".length));
		try {
			await stat(p);
			return p;
		} catch {
			return null;
		}
	}
}
