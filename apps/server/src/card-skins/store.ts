/**
 * 卡片皮肤库(ADR-0014 决策 2 / 5)。盘上形状 `<dir>/<id>/{card-skin.json, assets/*}`,
 * 与 dashboard 皮肤库(`skins/store.ts`)同规:写入一律 tmp → rename(目录级原子),
 * `init()` 全量读盘重建索引,资产路径永远经白名单正则再拼接,杜绝路径穿越。
 *
 * 三处与 dashboard 刻意不同:
 *
 * - **内置那份是索引外的第八套**:`default` 不落盘(它是代码里的 `DEFAULT_CARD_SKIN`),
 *   `list()` 把它摆在首位、`get()` 认得它、`duplicate()` 复制得了它 —— 那正是「要改先
 *   复制一份」的入口(决策 5)。删 / 存它一律抛错。
 * - **`remove()` 不认识的 id 抛错**,不是静默返回:调用方(路由)得能把「没这套皮肤」
 *   与「删好了」分开回给主人。
 * - **这一层不管「谁在用这套皮肤」**:启用指针住在配置里(`globals` / per-UP),删一套
 *   正被用着的皮肤是路由要拦的事,不是店里的事。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CardSkinSummary } from "@bilibili-notify/contract";
import {
	CARD_SKIN_LIMITS,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	parseCardSkin,
} from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import {
	CARD_SKIN_MANIFEST_FILE,
	checkCardSkinPackage,
	isCardSkinAssetName,
	parseCardSkinPackage,
} from "./package.js";

/**
 * 面板列表要的那几样(`builtin` = 内置只读那份,改不了删不了只能复制)。
 *
 * **形状住契约里**(`apps/contract`)—— 列表直接就是 `GET /api/card-skins` 的 wire,
 * 两边各写一份的话,加个字段总会漏掉一边,而漏掉的那边是静默的(TS 结构类型不会红)。
 * 这里原样转出去,店里的调用方不必绕道 contract。
 */
export type { CardSkinSummary };

/**
 * 装包 / 保存被拒。**逐条错误单独带着**(不是拼成一句话):路由要把它们原样列给主人,
 * 而「哪一块的哪一段不合格」正是作者唯一能据以动手的信息。
 */
export class CardSkinPackageError extends Error {
	readonly errors: string[];
	constructor(errors: string[]) {
		super(errors.join("；"));
		this.name = "CardSkinPackageError";
		this.errors = errors;
	}
}

interface IndexEntry {
	manifest: CardSkinManifest;
	updatedAt: number;
}

const ASSET_DIR = "assets";
/** `assets/` 前缀的长度 —— 包内名字 → 盘上文件名只差这一截。 */
const ASSET_PREFIX_LEN = `${ASSET_DIR}/`.length;

export class CardSkinStore {
	private readonly dir: string;
	/** id → 盘上那份;盘是唯一权威,这里只是读缓存。内置那份**不在**里面。 */
	private index = new Map<string, IndexEntry>();
	private initWarnings: string[] = [];
	/** {@link ensureReady} 的一次性凭据 —— init 只该真的跑一遍。 */
	private ready?: Promise<void>;

	constructor(opts: { dir: string }) {
		this.dir = opts.dir;
	}

	/**
	 * 确保索引已从盘上重建过,幂等。
	 *
	 * `createApp` 是**同步**装配,读盘只能推迟到首个请求(与 dashboard 皮肤库同款)。
	 * 记在店上而不是路由上:将来出图那头也要问这家店要皮肤,那条路进不了 HTTP 中间件。
	 */
	async ensureReady(): Promise<void> {
		this.ready ??= this.init();
		await this.ready;
	}

	/**
	 * 读盘重建索引。**一份坏皮肤不许拖死启动** —— 读不动 / 形状不对的目录跳过并记一条
	 * warning,既不进索引也不动它(交给人查,别静默删数据)。
	 */
	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		this.index.clear();
		this.initWarnings = [];
		for (const entry of await readdir(this.dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			// 写到一半的临时目录与删到一半的残骸不是皮肤,静默跳过。
			if (entry.name.endsWith(".tmp") || entry.name.endsWith(".deleting")) continue;
			if (entry.name === DEFAULT_CARD_SKIN_ID) {
				this.initWarnings.push(
					`${DEFAULT_CARD_SKIN_ID}: 这个 id 是内置皮肤的保留字,盘上这份目录不会被加载`,
				);
				continue;
			}
			const loaded = await this.readFromDisk(entry.name);
			if ("error" in loaded) {
				this.initWarnings.push(`${entry.name}: ${loaded.error}`);
				continue;
			}
			this.index.set(entry.name, loaded.entry);
		}
	}

	/** `init()` 跳过了哪些目录、为什么。路由 / 启动日志拿它告诉主人,别让皮肤悄悄消失。 */
	warnings(): string[] {
		return [...this.initWarnings];
	}

	/** 内置那份在首位,其余按最近改动排。 */
	list(): CardSkinSummary[] {
		const rest = [...this.index.entries()]
			.map(([id, e]) => summary(id, e.manifest, false, e.updatedAt))
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
		return [summary(DEFAULT_CARD_SKIN_ID, DEFAULT_CARD_SKIN, true, 0), ...rest];
	}

	/**
	 * 一套皮肤的清单;不存在 → null。
	 *
	 * **每次给一份拷贝**:内置那份是模块级常量,调用方顺手改一笔就污染了整个进程
	 * (出图那头拿到的就是被改过的默认皮肤);存量那份跟着同一条纪律,免得两种来路
	 * 两种语义。
	 */
	get(id: string): CardSkinManifest | null {
		if (id === DEFAULT_CARD_SKIN_ID) return structuredClone(DEFAULT_CARD_SKIN);
		const entry = this.index.get(id);
		return entry ? structuredClone(entry.manifest) : null;
	}

	has(id: string): boolean {
		return id === DEFAULT_CARD_SKIN_ID || this.index.has(id);
	}

	/** 装一个 zip 包:摊开 → 验+洗 → 落盘。任何一步不过一律抛 {@link CardSkinPackageError}。 */
	async install(zip: Uint8Array): Promise<{ id: string; warnings: string[] }> {
		const opened = parseCardSkinPackage(zip);
		if (!opened.ok) throw new CardSkinPackageError(opened.errors);
		const checked = checkCardSkinPackage(opened.manifestRaw, new Set(opened.assets.keys()));
		if (!checked.ok) throw new CardSkinPackageError(checked.errors);
		const id = newId();
		// 落盘的是**洗过的**那份 —— 出图那头不该再洗一遍,也不该有机会读到原文。
		await this.writePackage(id, checked.manifest, opened.assets);
		return { id, warnings: checked.warnings };
	}

	/**
	 * 从一份清单新建一套(没有资产)。卡片工坊「新做一套」走这条(ADR-0015 决策 13 的 🔗),
	 * 与装包同一道验 + 洗。
	 */
	async create(manifestRaw: unknown): Promise<{ id: string; warnings: string[] }> {
		const checked = checkCardSkinPackage(manifestRaw, new Set());
		if (!checked.ok) throw new CardSkinPackageError(checked.errors);
		const id = newId();
		await this.writePackage(id, checked.manifest, new Map());
		return { id, warnings: checked.warnings };
	}

	/**
	 * 复制一份(含资产)。内置那份也复制得了 —— 这就是「要改先复制」的那个入口。
	 *
	 * 新名字缺省「<原名> 副本」,超 schema 的名字上限就截断:复制一份不该因为名字长了
	 * 而失败,而存进去一个 schema 不认的名字更糟 —— 要到下一次保存才炸。
	 *
	 * ⚠️ **空名字按「没给」算,不是按「给了个空的」算。** `??` 只对 `null`/`undefined`
	 * 让路,所以 `{"name":""}` 曾经一路穿到盘上:面板照常列出它、甚至设得成当前皮肤,
	 * 而**重启之后** `parseCardSkin` 按 `name.min(1)` 拒收、那个目录只留一条警告被跳过
	 * —— 皮肤静默消失,出图回落默认(2026-09-19 审查实测复现)。纯空白同理。
	 *
	 * 顺带补上这条路径**唯一缺的那道门**:install / create / save 三条都过
	 * `checkCardSkinPackage`,只有复制没过。源清单本来就是洗过的,这一趟是幂等的;
	 * 它挡的是「将来有人往这儿塞一个没洗过的清单」。
	 */
	async duplicate(id: string, name?: string): Promise<{ id: string }> {
		const source = this.get(id);
		if (!source) throw new Error(`皮肤不存在: ${id}`);
		const asked = name?.trim();
		const manifest: CardSkinManifest = {
			...source,
			name: (asked === undefined || asked === "" ? `${source.name} 副本` : asked).slice(
				0,
				CARD_SKIN_LIMITS.name.max,
			),
		};
		const assets = new Map<string, Uint8Array>();
		for (const assetName of await this.listAssets(id)) {
			const bytes = await this.readAsset(id, assetName);
			if (bytes) assets.set(assetName, bytes);
		}
		const checked = checkCardSkinPackage(manifest, new Set(assets.keys()));
		if (!checked.ok) throw new CardSkinPackageError(checked.errors);
		const newid = newId();
		await this.writePackage(newid, checked.manifest, assets);
		return { id: newid };
	}

	/** 删一套。内置那份删不掉;不认识的 id 抛错(调用方得分得清「没这套」与「删好了」)。 */
	async remove(id: string): Promise<void> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new Error("内置的默认皮肤删不掉 —— 想改它请先「复制一份」");
		}
		// 不认识的 id 一律不动手:路由把 `:id` 原样交进来,而这里干的是 rm -rf
		// (dashboard 那头 2026-08-19 实测过 `%2e%2e%2f` 能穿出皮肤目录)。
		if (!this.index.has(id)) throw new Error(`皮肤不存在: ${id}`);
		// 先 rename 再删:rm -rf 中途断电会留下半套皮肤,而下一次 init 照样把它读进索引;
		// 改名之后那半套叫 `<id>.deleting`,init 一眼认得出不是皮肤。
		const graveyard = join(this.dir, `${id}.deleting`);
		await rm(graveyard, { recursive: true, force: true });
		await rename(join(this.dir, id), graveyard);
		this.index.delete(id);
		await rm(graveyard, { recursive: true, force: true });
	}

	/** 打回一个标准包(manifest + 全部资产),和装包收的是同一种 zip(往返闭环)。 */
	async exportZip(id: string): Promise<Uint8Array> {
		const manifest = this.get(id);
		if (!manifest) throw new Error(`皮肤不存在: ${id}`);
		const files: Record<string, Uint8Array> = {
			[CARD_SKIN_MANIFEST_FILE]: strToU8(serialize(manifest)),
		};
		// 各张资产之间没有先后关系,一张最大 5MB、最多 12 张 —— 串行读等于把几十次
		// 系统调用排成一条队,而主人在等一个 zip。
		const assets = await Promise.all(
			(await this.listAssets(id)).map(
				async (name) => [name, await this.readAsset(id, name)] as const,
			),
		);
		for (const [name, bytes] of assets) {
			if (bytes) files[name] = bytes;
		}
		return zipSync(files);
	}

	/** 这套皮肤盘上有哪些资产(`assets/<名>` 形式,与清单里的引用同构)。 */
	async listAssets(id: string): Promise<string[]> {
		if (!this.index.has(id)) return [];
		let names: string[];
		try {
			names = await readdir(join(this.dir, id, ASSET_DIR));
		} catch {
			return [];
		}
		return names.map((n) => `${ASSET_DIR}/${n}`).filter(isCardSkinAssetName);
	}

	/**
	 * 往一套已存盘的皮肤里**加一份资产**。在这之前资产只能随 zip 装包进来 —— 于是编辑器里
	 * 「皮肤自带字体」永远指不到东西(清单里的 `asset:assets/<文件>` 必须是包内文件)。
	 *
	 * 闸与装包门**同一把尺**:名字白名单(它要拼进磁盘路径)、单份体积、份数上限。少一条
	 * 就成了「装包进不来的东西,换个门能进」。
	 *
	 * **同名不覆盖**:悄悄换掉的那份可能正被清单引用着(字体的 family 没变、字变了),
	 * 而主人没有任何提示。拒掉,让他先删。
	 */
	async addAsset(id: string, filename: string, bytes: Uint8Array): Promise<{ name: string }> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new CardSkinPackageError(["内置的默认皮肤加不了资产 —— 想改它请先「复制一份」"]);
		}
		if (!this.index.has(id)) throw new CardSkinPackageError(["卡片皮肤不存在"]);

		// **只小写,不剥路径**。白名单正则不收 `/` 也不收 `..`,带路径的名字到这儿会被明着
		// 拒掉 —— 而先剥成 basename 的话,`../../etc/passwd.ttf` 会变成一份叫 passwd.ttf 的
		// 资产悄悄躺进去:安全(落点没变),但多了一条静默的归一化路径,以后没人说得清哪条
		// 名字是怎么变成盘上那个的。小写是唯一的例外(正则只收小写,而这一步改不了落点)。
		const base = filename.toLowerCase();
		const name = `${ASSET_DIR}/${base}`;
		if (!isCardSkinAssetName(name)) {
			throw new CardSkinPackageError([
				`「${base}」不能作为皮肤资产 —— 只收 png / jpg / webp / gif 与 woff2 / woff / ttf / otf,名字只准小写字母、数字、\`.\` \`_\` \`-\``,
			]);
		}
		if (bytes.byteLength > CARD_SKIN_LIMITS.maxAssetBytes) {
			const mb = Math.round(CARD_SKIN_LIMITS.maxAssetBytes / 1024 / 1024);
			throw new CardSkinPackageError([`「${base}」太大了 —— 单份上限 ${mb}MB`]);
		}
		const existing = await this.listAssets(id);
		if (existing.includes(name)) {
			throw new CardSkinPackageError([`已经有一份叫「${base}」的了 —— 先删掉那份再传`]);
		}
		if (existing.length >= CARD_SKIN_LIMITS.maxAssets) {
			throw new CardSkinPackageError([
				`这套皮肤已经 ${existing.length} 份资产,上限 ${CARD_SKIN_LIMITS.maxAssets} 份 —— 删掉用不上的再传`,
			]);
		}

		const dir = join(this.dir, id, ASSET_DIR);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, base), bytes);
		return { name };
	}

	/**
	 * 删一份资产。**清单还引用着就不许删** —— 删了这套皮肤连自己都存不下去(下次保存装包门
	 * 判「指了…,但包里没有这份资产」),而主人看到的只是一句莫名其妙的报错。
	 */
	async removeAsset(id: string, name: string): Promise<void> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new CardSkinPackageError(["内置的默认皮肤没有落盘的资产"]);
		}
		if (!this.index.has(id)) throw new CardSkinPackageError(["卡片皮肤不存在"]);
		if (!isCardSkinAssetName(name)) throw new CardSkinPackageError(["资产名不合法"]);

		const users = assetUsers(this.get(id), name);
		if (users.length > 0) {
			throw new CardSkinPackageError([
				`「${name}」还被用着(${users.join("、")})—— 先在编辑器里换掉再删`,
			]);
		}
		await rm(join(this.dir, id, ASSET_DIR, name.slice(ASSET_PREFIX_LEN)), { force: true });
	}

	/** 读一份资产;名字不合白名单、皮肤不存在、文件不在 → null(三条都不抛)。 */
	async readAsset(id: string, name: string): Promise<Uint8Array | null> {
		if (!this.index.has(id)) return null;
		if (!isCardSkinAssetName(name)) return null;
		try {
			return new Uint8Array(
				await readFile(join(this.dir, id, ASSET_DIR, name.slice(ASSET_PREFIX_LEN))),
			);
		} catch {
			return null;
		}
	}

	/**
	 * 编辑器保存:走**与装包同一道**验+洗,只是资产清单来自盘上。
	 *
	 * 内置那份存不了(它没有落盘的身子);清洗产物照旧写回,所以盘上永远是洗过的。
	 */
	async save(id: string, manifestRaw: unknown): Promise<{ warnings: string[] }> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new Error("内置的默认皮肤改不了 —— 想改它请先「复制一份」");
		}
		const current = this.index.get(id);
		if (!current) throw new Error(`皮肤不存在: ${id}`);
		const checked = checkCardSkinPackage(manifestRaw, new Set(await this.listAssets(id)));
		if (!checked.ok) throw new CardSkinPackageError(checked.errors);
		const path = join(this.dir, id, CARD_SKIN_MANIFEST_FILE);
		await writeAtomic(path, serialize(checked.manifest));
		this.index.set(id, { manifest: checked.manifest, updatedAt: await mtime(path) });
		return { warnings: checked.warnings };
	}

	/** 整套皮肤落盘:先写 `<id>.tmp` 再整目录 rename —— 断电不会留下半套。 */
	private async writePackage(
		id: string,
		manifest: CardSkinManifest,
		assets: ReadonlyMap<string, Uint8Array>,
	): Promise<void> {
		const tmpDir = join(this.dir, `${id}.tmp`);
		await rm(tmpDir, { recursive: true, force: true });
		await mkdir(join(tmpDir, ASSET_DIR), { recursive: true });
		await writeFile(join(tmpDir, CARD_SKIN_MANIFEST_FILE), serialize(manifest));
		for (const [name, data] of assets) {
			// 白名单再过一遍:名字要拼进磁盘路径,而这一步离「谁检查过它」已经隔了几层。
			if (!isCardSkinAssetName(name)) continue;
			await writeFile(join(tmpDir, ASSET_DIR, name.slice(ASSET_PREFIX_LEN)), data);
		}
		await rename(tmpDir, join(this.dir, id));
		this.index.set(id, {
			manifest,
			updatedAt: await mtime(join(this.dir, id, CARD_SKIN_MANIFEST_FILE)),
		});
	}

	/** 读一个目录;读不动 / 形状不对 → 说清原因,由调用方决定怎么处置。 */
	private async readFromDisk(id: string): Promise<{ entry: IndexEntry } | { error: string }> {
		const path = join(this.dir, id, CARD_SKIN_MANIFEST_FILE);
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, "utf8"));
		} catch {
			return { error: `${CARD_SKIN_MANIFEST_FILE} 读不出来或不是合法 JSON,跳过` };
		}
		// 只问形状,不重洗:落盘那一刻洗过了。形状不对的多半是手改坏的,跳过并说清。
		const parsed = parseCardSkin(raw);
		if (!parsed.ok) return { error: `清单不合格式(${parsed.errors[0] ?? "未知原因"}),跳过` };
		return { entry: { manifest: parsed.manifest, updatedAt: await mtime(path) } };
	}
}

/** 皮肤 id:时间戳 36 进制 + 随机 hex,与 dashboard 皮肤同款(`CardSkinIdSchema` 认得)。 */
function newId(): string {
	return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function summary(
	id: string,
	m: CardSkinManifest,
	builtin: boolean,
	updatedAt: number,
): CardSkinSummary {
	return {
		id,
		name: m.name,
		...(m.author !== undefined ? { author: m.author } : {}),
		...(m.description !== undefined ? { description: m.description } : {}),
		builtin,
		updatedAt,
		...(m.knobs?.length ? { knobs: m.knobs } : {}),
	};
}

/** 盘上那份清单的字面:带缩进,主人 / 第三方是要手看手改它的。 */
function serialize(manifest: CardSkinManifest): string {
	return JSON.stringify(manifest, null, "\t");
}

/** 清单的 mtime(ms);读不到就退回当下 —— 时间戳不值得让一次保存失败。 */
async function mtime(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return Date.now();
	}
}

/** 先写 `.tmp` 再 rename —— 文件级原子,断电 / 崩溃不会留下半截 JSON。 */
async function writeAtomic(path: string, data: string): Promise<void> {
	const tmp = `${path}.tmp`;
	await writeFile(tmp, data);
	await rename(tmp, path);
}

/**
 * 清单里**谁在用**这份资产,回的是人话(「字体 Song」「直播卡的块 cover」)。
 *
 * 结构化地走一遍是为了说得出是谁;末尾还兜一句**整份 JSON 里搜一次** —— 清单以后多长
 * 一个能引用资产的字段时,这条兜底照样拦得住,而结构化那半会漏。漏一处的后果是删掉之后
 * 这套皮肤连自己都存不下去,所以宁可多一句「清单里还有地方引用着」。
 */
function assetUsers(manifest: CardSkinManifest | null, name: string): string[] {
	if (!manifest) return [];
	const ref = `asset:${name}`;
	const users: string[] = [];

	for (const f of manifest.fonts ?? []) {
		if (f.asset === ref) users.push(`字体 ${f.family}`);
	}
	const inVars = (vars: Record<string, string> | undefined): boolean =>
		Object.values(vars ?? {}).includes(ref);
	for (const [kind, card] of Object.entries(manifest.cards)) {
		if (!card) continue;
		if (inVars(card.assets)) users.push(`${kind} 卡的资产变量`);
		for (const block of card.blocks) {
			if (inVars(block.assets)) users.push(`${kind} 卡的块「${block.id}」`);
			else if (block.kind === "custom" && block.html.includes(ref)) {
				users.push(`${kind} 卡的块「${block.id}」的 HTML`);
			}
		}
	}
	// 兜底:上面一条都没认出来,但整份清单里确实有这个引用。
	if (users.length === 0 && JSON.stringify(manifest).includes(ref)) {
		users.push("清单里还有地方引用着");
	}
	return users;
}
