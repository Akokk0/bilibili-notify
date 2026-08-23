/**
 * 皮肤库存储:`<skinsDir>/<id>/skin.json + assets/*`,active 指针在
 * `<skinsDir>/active.json`。写入走 tmp → rename(目录级原子);init() 全量读盘
 * 重建,重启不丢。资产路径永远经白名单正则再拼接,杜绝路径穿越。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkinListEntry, SkinManifest } from "@bilibili-notify/contract";
import { ASSET_NAMES_FILE, parseAssetNames, sanitizeAssetLabel } from "./asset-names.js";
import { MAX_ASSET_BYTES, MAX_FONT_BYTES, MAX_SKIN_ASSETS } from "./package.js";
import { isSkinAssetName } from "./schema.js";

interface SavedSkin {
	manifest: SkinManifest;
	assets: Map<string, Uint8Array>;
	/** 资产原名清单(`assets/<生成名>` → 主人上传时叫什么);只做显示,见 asset-names.ts。 */
	names?: Record<string, string>;
}

/**
 * 一套皮肤最多放几份资产 —— 与 zip 那道闸**同一个数**,定义在 package.ts。
 *
 * 两边各写各的时它们悄悄错开过(16 的文件数闸放得进 14 份资产,而这边只准 12):
 * 手搓的超量包整份存了进去,主人却在编辑器里一份也加不了。这里只是转出去,
 * 免得调用方还得知道它住在哪。
 */
export { MAX_SKIN_ASSETS };

/** 包内图片的扩展名白名单,与 schema.ts 的 WALLPAPER_IMAGE_RE 同口径(无 SVG)。 */
const SKIN_ASSET_EXTS = new Set(["png", "jpg", "jpeg", "webp"]);

/** 包内字体的扩展名白名单,与 schema.ts 的 SKIN_FONT_FILE_RE 同口径。 */
const SKIN_FONT_EXTS = new Set(["woff2", "woff", "ttf", "otf"]);

/**
 * 报错文案用的模式名。跟**界面**的说法走(`apps/web` 的 skin-edit.ts 写的是
 * 「深色」),不跟 chat-tool.ts 走 —— 那份是说给模型听的,这一句会原样显示给主人,
 * 与同一页上的其它字对不上就成了两套黑话。
 */
const MODE_LABEL = { light: "浅色", dark: "深色" } as const;

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

	/** {@link ensureReady} 的一次性凭据 —— init 只该真的跑一遍。 */
	private ready?: Promise<void>;

	/**
	 * 确保索引已从盘上重建过,幂等。
	 *
	 * 这家店**一份两处用**(`/api/skins` 与聊天里的 create_skin),而 init 原先只挂在
	 * 前者的中间件上。主人一进 dashboard 就直奔聊天做皮肤的话,店里的 `active`
	 * 还是构造函数给的 `{light:null,dark:null}` —— 这时 `activate()` 落盘,会把重启
	 * 前启用着的另一个槽**悄悄清掉**。索引本身下次 init 能自愈,active.json 不能。
	 */
	async ensureReady(): Promise<void> {
		this.ready ??= this.init();
		await this.ready;
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
			if (!isSkinAssetName(name)) continue;
			await writeFile(join(tmpDir, "assets", name.slice("assets/".length)), data);
		}
		// 空清单不落文件 —— 没有原名可记的包(聊天里生成的、手工压的)不该多带一个空壳。
		if (pkg.names && Object.keys(pkg.names).length > 0) {
			await writeFile(join(tmpDir, ASSET_NAMES_FILE), JSON.stringify(pkg.names, null, "\t"));
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
	 * 往已有皮肤里加一份资产(壁纸图或自带字体),返回它在包里的名字(`assets/<名>`)。
	 *
	 * 名字**这边生成**,不用上传来的文件名:那是不可信输入(中文、空格、`../`),
	 * 而它要拼进磁盘路径。扩展名过白名单 —— SVG 能带脚本,而这些图会在 dashboard
	 * 里直接渲染,永远不收(同聊天附件那条规矩)。
	 *
	 * 图与字体走**两条各自的大小线**:一款完整中文 woff2 就有八九兆,拿图片那条
	 * 5MB 卡它等于自带字体这功能不存在;而壁纸没有大到 20MB 的理由,不跟着放宽。
	 * 名字前缀(`img-` / `font-`)只是让盘上一眼分得清,分流靠的是后缀。
	 */
	async addAsset(
		id: string,
		bytes: Uint8Array,
		ext: string,
		/** 主人上传时这个文件叫什么;只做显示,过 sanitizeAssetLabel 后记进原名清单。 */
		originalName?: string,
	): Promise<string> {
		if (!this.index.has(id)) throw new Error("皮肤不存在或已被删除");
		const clean = ext.toLowerCase().replace(/^\./, "");
		const isFont = SKIN_FONT_EXTS.has(clean);
		if (!isFont && !SKIN_ASSET_EXTS.has(clean)) {
			throw new Error(
				`不支持的文件类型:${ext}(图片仅 PNG / JPEG / WebP,字体仅 woff2 / woff / ttf / otf)`,
			);
		}
		const limit = isFont ? MAX_FONT_BYTES : MAX_ASSET_BYTES;
		if (bytes.byteLength > limit) {
			const mb = Math.round(limit / 1024 / 1024);
			throw new Error(
				isFont
					? `字体过大(上限 ${mb}MB)—— 同一套字转成 woff2 通常只占三分之一`
					: `图片过大(上限 ${mb}MB)`,
			);
		}
		const existing = await this.listAssets(id);
		if (existing.length >= MAX_SKIN_ASSETS) {
			throw new Error(`一套皮肤最多放 ${MAX_SKIN_ASSETS} 份资产,先删掉用不上的再传`);
		}
		const name = `assets/${isFont ? "font" : "img"}-${randomBytes(4).toString("hex")}.${clean}`;
		const dir = join(this.skinsDir, id, "assets");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, name.slice("assets/".length)), bytes);
		const label = sanitizeAssetLabel(originalName);
		if (label !== null) {
			// 先读后写:清单里已有的几条不能被这一次上传顶掉。
			await this.writeAssetNames(id, { ...(await this.readAssetNames(id)), [name]: label });
		}
		return name;
	}

	/**
	 * 资产原名清单(`assets/<生成名>` → 主人上传时叫什么)。**以目录为真相**:
	 * 盘上没有的记录一概不给,清单缺失 / 损坏一律当空 —— 名字没了不该让图廊瘫掉。
	 */
	async assetNames(id: string): Promise<Record<string, string>> {
		const names = await this.readAssetNames(id);
		if (Object.keys(names).length === 0) return names;
		const onDisk = new Set(await this.listAssets(id));
		const out: Record<string, string> = {};
		for (const [key, label] of Object.entries(names)) {
			if (onDisk.has(key)) out[key] = label;
		}
		return out;
	}

	/** 裸读清单文件(不与目录对账);缺失 / 损坏 / 皮肤不存在一律回空表。 */
	private async readAssetNames(id: string): Promise<Record<string, string>> {
		if (!this.index.has(id)) return {};
		try {
			const raw: unknown = JSON.parse(
				await readFile(join(this.skinsDir, id, ASSET_NAMES_FILE), "utf8"),
			);
			return parseAssetNames(raw, isSkinAssetName);
		} catch {
			return {};
		}
	}

	private async writeAssetNames(id: string, names: Record<string, string>): Promise<void> {
		const dir = join(this.skinsDir, id, "assets");
		await mkdir(dir, { recursive: true });
		await this.writeAtomic(
			join(this.skinsDir, id, ASSET_NAMES_FILE),
			JSON.stringify(names, null, "\t"),
		);
	}

	/**
	 * 包内资产清单(`assets/<名>` 形式,与 manifest 引用同构);皮肤不存在 → 空数组。
	 *
	 * **图与字体一起列**,不分两个方法:四处调用方(编辑器、AI 改皮肤、保存时的
	 * 引用完整性校验、导出 zip)要的都是「这套皮肤盘上有什么」这一份全集。分流是
	 * 用的时候按后缀做的事 —— 编辑器那两个下拉各自筛一遍。
	 */
	async listAssets(id: string): Promise<string[]> {
		if (!this.index.has(id)) return [];
		let names: string[];
		try {
			names = await readdir(join(this.skinsDir, id, "assets"));
		} catch {
			return [];
		}
		return names.map((n) => `assets/${n}`).filter(isSkinAssetName);
	}

	/**
	 * 就地更新 manifest(编辑器保存)。资产一字不动 —— 资产 URL 的 immutable 长缓存
	 * 契约不被破坏,变的只有 skin.json。调用方(路由层)负责先过 parseSkinManifest
	 * 与资产引用校验,这里只管原子落盘。
	 */
	async updateManifest(id: string, manifest: SkinManifest): Promise<void> {
		if (!this.index.has(id)) throw new Error(`皮肤不存在: ${id}`);
		await this.writeAtomic(
			join(this.skinsDir, id, "skin.json"),
			JSON.stringify(manifest, null, "\t"),
		);
		this.index.set(id, manifest);
	}

	/**
	 * 只删一套皮肤的**其中一色**(深浅双色皮肤的「只删浅色 / 只删深色」)。
	 *
	 * 三件事一起做,少一件就留下一个说不通的状态:
	 * 1. **skin.json 去掉那一色。**
	 * 2. **出厂快照跟着去掉。** 不然主人明明删了浅色,一点编辑器里的「恢复默认值」
	 *    它又回来了 —— 这件事界面上没地方交代,看起来就是个 bug(主人 2026-08-20
	 *    拍板:删了就是删了)。存量目录没有快照,跳过即可,不该因此整件事失败。
	 * 3. **正占着那个槽就把槽卸下来。** 否则 `active.light` 指着一套没有 light 的
	 *    皮肤 —— 而 {@link setActiveSlot} 明明拦着这种状态(「纯暗皮肤进不了亮槽」),
	 *    从这条路却能绕出来。另一个槽不受牵连。
	 *
	 * **最后一套模式删不得**:schema 要求「至少给一套」,真删空了盘上就躺着一套
	 * 永远装不上、也编辑不了的皮肤。那是「删除整套」该干的事,让调用方走那条路。
	 *
	 * **资产一张不动**:那一色用的图,另一色可能马上就要接着用;而资产 URL 的
	 * immutable 长缓存契约也不该为一次删色破例。
	 */
	async removeMode(id: string, theme: keyof ActiveSlots): Promise<void> {
		const manifest = this.index.get(id);
		// 不认识的 id 一律不动手 —— 与 remove 同一条纪律,这里同样要写盘。
		if (!manifest) throw new Error(`皮肤不存在: ${id}`);
		if (!manifest.modes[theme]) throw new Error(`这套皮肤没有${MODE_LABEL[theme]}模式`);
		const other = theme === "light" ? "dark" : "light";
		if (!manifest.modes[other]) {
			throw new Error(`这是最后一套模式,删了就等于删掉整套皮肤 —— 请改用「删除」`);
		}

		const next: SkinManifest = { ...manifest, modes: { [other]: manifest.modes[other] } };
		await this.updateManifest(id, next);

		const snapshot = await this.getDefault(id);
		if (snapshot?.modes[theme]) {
			const trimmed: SkinManifest = { ...snapshot, modes: {} };
			if (snapshot.modes[other]) trimmed.modes[other] = snapshot.modes[other];
			await this.writeAtomic(
				join(this.skinsDir, id, "default.json"),
				JSON.stringify(trimmed, null, "\t"),
			);
		}

		if (this.active[theme] === id) await this.writeActive({ ...this.active, [theme]: null });
	}

	/** 把当前 manifest 钉成出厂快照(「设为默认值」);皮肤不存在 → 抛错。 */
	async setDefault(id: string): Promise<void> {
		const manifest = this.index.get(id);
		if (!manifest) throw new Error(`皮肤不存在: ${id}`);
		await this.writeAtomic(
			join(this.skinsDir, id, "default.json"),
			JSON.stringify(manifest, null, "\t"),
		);
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

	/**
	 * 删一套皮肤。**不认识的 id 一律不动手** —— 这道守卫不是可有可无的:路由把
	 * `:id` 原样交进来,而 `%2e%2e%2f` 这种写法 URL 解析器不折叠、Hono 的 param
	 * 却会解码,`join(skinsDir, "../..")` 就跑出了皮肤目录,而这里干的是 `rm -rf`。
	 *
	 * 实测(2026-08-19 审计):`DELETE /%2e%2e%2fconversations` 回 200,
	 * `<dataDir>/conversations` 整个没了。店里每个方法都拿 index 认过 id,
	 * 唯独这个没有 —— 而它是破坏力最大的那个。
	 */
	async remove(id: string): Promise<void> {
		if (!this.index.has(id)) return;
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
		await this.writeAtomic(join(this.skinsDir, "active.json"), JSON.stringify(next));
		this.active = next;
	}

	/**
	 * 先写 `.tmp` 再 rename —— 目录级原子,断电/崩溃不会留下半截 JSON。
	 *
	 * 这家店的三份盘上状态(skin.json / default.json / active.json)都靠它,
	 * 所以只留一份实现:哪天要加 fsync 或失败清理,不必记得改三处。
	 */
	private async writeAtomic(path: string, data: string): Promise<void> {
		const tmp = `${path}.tmp`;
		await writeFile(tmp, data);
		await rename(tmp, path);
	}

	/** 资产的磁盘绝对路径;名字不合白名单或文件不存在 → null。 */
	async assetPath(id: string, name: string): Promise<string | null> {
		if (!this.index.has(id)) return null;
		if (!isSkinAssetName(name)) return null;
		const p = join(this.skinsDir, id, "assets", name.slice("assets/".length));
		try {
			await stat(p);
			return p;
		} catch {
			return null;
		}
	}
}
