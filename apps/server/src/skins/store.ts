/**
 * 皮肤库存储:`<skinsDir>/<id>/skin.json + assets/*`,active 指针在
 * `<skinsDir>/active.json`。写入走 tmp → rename(目录级原子);init() 全量读盘
 * 重建,重启不丢。资产路径永远经白名单正则再拼接,杜绝路径穿越。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkinListEntry, SkinManifest } from "@bilibili-notify/contract";
import { MAX_ASSET_BYTES } from "./package.js";
import { WALLPAPER_IMAGE_RE } from "./schema.js";

interface SavedSkin {
	manifest: SkinManifest;
	assets: Map<string, Uint8Array>;
}

/**
 * 一套皮肤最多放几张图。留在 zip 那道闸(MAX_PACKAGE_FILES)之内 —— 传到超过
 * 上限的包会连自己的导出都传不回来。
 */
export const MAX_SKIN_ASSETS = 12;

/** 包内图片的扩展名白名单,与 {@link WALLPAPER_IMAGE_RE} 同口径(无 SVG)。 */
const SKIN_ASSET_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

/** 深浅色各一个槽位:浅色模式渲染 light 槽的皮肤,暗色渲染 dark 槽;槽空=默认装。 */
export interface ActiveSlots {
	light: string | null;
	dark: string | null;
}

export class SkinStore {
	private readonly skinsDir: string;
	private active: ActiveSlots = { light: null, dark: null };
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
		this.active = { light: null, dark: null };
		try {
			const raw = JSON.parse(await readFile(join(this.skinsDir, "active.json"), "utf8"));
			for (const theme of ["light", "dark"] as const) {
				const id = raw[theme];
				if (typeof id === "string" && this.index.get(id)?.modes[theme]) this.active[theme] = id;
			}
			// 旧单指针格式 {id}:按该皮肤具备的模式落槽,一次读盘即完成迁移语义
			// (落盘格式在下次 set 时自然升级,这里不主动回写)。
			if (typeof raw.id === "string") {
				const m = this.index.get(raw.id);
				for (const theme of ["light", "dark"] as const) {
					if (m?.modes[theme]) this.active[theme] = raw.id;
				}
			}
		} catch {
			// 没有 active.json = 没启用皮肤。
		}
	}

	async save(pkg: SavedSkin): Promise<{ id: string }> {
		const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
		const tmpDir = join(this.skinsDir, `${id}.tmp`);
		await mkdir(join(tmpDir, "assets"), { recursive: true });
		await writeFile(join(tmpDir, "skin.json"), JSON.stringify(pkg.manifest, null, "\t"));
		// 出厂快照 = 上传时的 manifest;之后编辑只动 skin.json,快照是「恢复默认」的基准。
		await writeFile(join(tmpDir, "default.json"), JSON.stringify(pkg.manifest, null, "\t"));
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

	/**
	 * 往已有皮肤里加一张图,返回它在包里的名字(`assets/<名>`)。
	 *
	 * 名字**这边生成**,不用上传来的文件名:那是不可信输入(中文、空格、`../`),
	 * 而它要拼进磁盘路径。扩展名过白名单 —— SVG 能带脚本,而这些图会在 dashboard
	 * 里直接渲染,永远不收(同聊天附件那条规矩)。
	 */
	async addAsset(id: string, bytes: Uint8Array, ext: string): Promise<string> {
		if (!this.index.has(id)) throw new Error("皮肤不存在或已被删除");
		const clean = ext.toLowerCase().replace(/^\./, "");
		if (!SKIN_ASSET_EXTS.has(clean)) {
			throw new Error(`不支持的图片类型:${ext}(仅 PNG / JPEG / WebP)`);
		}
		if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error("图片过大(上限 5MB)");
		const existing = await this.listAssets(id);
		if (existing.length >= MAX_SKIN_ASSETS) {
			throw new Error(`一套皮肤最多放 ${MAX_SKIN_ASSETS} 张图,先删掉用不上的再传`);
		}
		const name = `assets/img-${randomBytes(4).toString("hex")}.${clean}`;
		const dir = join(this.skinsDir, id, "assets");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, name.slice("assets/".length)), bytes);
		return name;
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

	/** 把当前 manifest 钉成出厂快照(「设为默认值」);皮肤不存在 → 抛错。 */
	async setDefault(id: string): Promise<void> {
		const manifest = this.index.get(id);
		if (!manifest) throw new Error(`皮肤不存在: ${id}`);
		const tmp = join(this.skinsDir, id, "default.json.tmp");
		await writeFile(tmp, JSON.stringify(manifest, null, "\t"));
		await rename(tmp, join(this.skinsDir, id, "default.json"));
	}

	/** 出厂快照;皮肤不存在或(存量目录)从未钉过 → null。读频率低,不进内存索引。 */
	async getDefault(id: string): Promise<SkinManifest | null> {
		if (!this.index.has(id)) return null;
		try {
			const raw = await readFile(join(this.skinsDir, id, "default.json"), "utf8");
			return JSON.parse(raw) as SkinManifest;
		} catch {
			return null;
		}
	}

	async remove(id: string): Promise<void> {
		await rm(join(this.skinsDir, id), { recursive: true, force: true });
		this.index.delete(id);
		if (this.active.light === id || this.active.dark === id) {
			await this.writeActive({
				light: this.active.light === id ? null : this.active.light,
				dark: this.active.dark === id ? null : this.active.dark,
			});
		}
	}

	/** 设置单个主题槽;皮肤必须提供该模式(纯暗皮肤进不了亮槽,反之亦然)。 */
	async setActiveSlot(theme: keyof ActiveSlots, id: string | null): Promise<void> {
		if (id !== null) {
			const m = this.index.get(id);
			if (!m) throw new Error(`皮肤不存在: ${id}`);
			if (!m.modes[theme]) throw new Error(`皮肤没有 ${theme} 模式: ${id}`);
		}
		await this.writeActive({ ...this.active, [theme]: id });
	}

	/** 整套启用:按皮肤具备的模式落槽,不具备的槽保持原样;null 清空两槽。 */
	async activate(id: string | null): Promise<void> {
		if (id === null) {
			await this.writeActive({ light: null, dark: null });
			return;
		}
		const m = this.index.get(id);
		if (!m) throw new Error(`皮肤不存在: ${id}`);
		await this.writeActive({
			light: m.modes.light ? id : this.active.light,
			dark: m.modes.dark ? id : this.active.dark,
		});
	}

	getActive(): ActiveSlots {
		return { ...this.active };
	}

	private async writeActive(next: ActiveSlots): Promise<void> {
		const tmp = join(this.skinsDir, "active.json.tmp");
		await writeFile(tmp, JSON.stringify(next));
		await rename(tmp, join(this.skinsDir, "active.json"));
		this.active = next;
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
