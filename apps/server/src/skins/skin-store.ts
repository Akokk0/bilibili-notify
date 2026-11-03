import { t as serverText } from "../i18n/index.js";
/**
 * 皮肤包目录:`<dir>/<id>/{<清单文件>, assets/*, …}`,一皮肤一子目录。
 *
 * 面板皮肤库(`skins/store.ts`)与卡片皮肤库(`card-skins/store.ts`)收成这一份 —— 两家盘上是同一个
 * 形状、干的是同一件事:开机扫子目录建内存索引、整包搭好再换上、只改清单、按 id 删、同一皮肤的
 * 写不许交错。差别只有清单文件叫什么、清单怎么读怎么写、包内资产认什么,全部做成选项;各家自己的
 * 规矩(面板的双槽指针与出厂快照、卡片的内置皮肤与清洗)留在门面里。
 *
 * **盘是唯一权威,内存索引只是读缓存。** `ids()` / `get()` / `has()` 是同步的 —— 卡片出图路径要同步
 * 读索引,所以这三个读永远不该 `await`。`ensureReady()` 之前索引是空的。
 *
 * **写只走持久化底层**(`@bilibili-notify/storage`):清单原子写、整包经暂存目录换上、删除先改名
 * 再删。开机扫描据 {@link isLeftoverName} 跳过它们留下的残骸,再加老版本的 `.tmp` / `.deleting`
 * 结尾(磁盘上可能还躺着)。
 *
 * **同一皮肤的写全排进同一条队**:队列在模块里、键 = 皮肤目录的绝对路径 —— 调用方按数据目录就地建
 * 店时,同一个目录上必然不止一个实例,各排各的队等于没排。要「读了再写」的复合操作(数份数 → 查同名 →
 * 存)必须整个放进 {@link SkinPackageStore.run},而不是各调各的:数份数与存之间的空隙里,别的写会钻进来。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createSerialQueue, type Failure, fail } from "@bilibili-notify/internal";
import {
	atomicWriteFile,
	isLeftoverName,
	removeDirectory,
	replaceDirectory,
} from "@bilibili-notify/storage";
import {
	type AssetStore,
	type AssetStoreOptions,
	createAssetStore,
} from "../assets/asset-store.js";

/** `parse` 的结果:成功给清单,拒收给一句人话(会原样交给 `onSkip`)。 */
export type ManifestResult<M> = { ok: true; manifest: M } | (Failure & { code: "invalid" });

export interface SkinPackageStoreOptions<M> {
	/** 皮肤根目录的绝对路径。不必事先存在,就绪时建。 */
	dir: string;
	/** 清单在皮肤目录里的文件名(`skin.json` / `card-skin.json`)。 */
	manifestFile: string;
	/**
	 * 盘上读出来的 JSON → 清单。`id` 是它所在的目录名,门面据此拒收保留 id。
	 * 拒收的目录不进索引、也不动它,原因经 `onSkip` 交出去。
	 */
	parse(raw: unknown, id: string): ManifestResult<M>;
	/** 清单 → 落盘的字节。两家今天都是 tab 缩进、末尾不换行,别换 —— 主人与第三方要手看手改。 */
	serialize(manifest: M): string;
	/** 包内资产(`<皮肤目录>/assets`)的规则:认得的格式、上限、取名、原名清单。目录由这一层定。 */
	assets: Omit<AssetStoreOptions, "dir">;
	/** 开机扫描跳过了一个目录:名字与原因。静默跳过的残骸(暂存、旧目录、老 `.tmp`)不会走到这里。 */
	onSkip?(entry: string, message: string): void;
}

export interface SkinPackageStore<M> {
	/** 读盘重建索引,**每次都重扫**,并顶替 {@link ensureReady} 的那把锁。 */
	init(): Promise<void>;
	/** 索引已经从盘上重建过就不再读,幂等;两处同时调只扫一遍。 */
	ensureReady(): Promise<void>;
	/** 索引里的全部 id,按读盘 / 新建的先后。同步。 */
	ids(): string[];
	has(id: string): boolean;
	/** 清单本身,**不是拷贝**;不认识的 id 回 `null`。 */
	get(id: string): M | null;
	/** 清单文件的 mtime(ms);不认识的 id 回 `null`。 */
	updatedAt(id: string): number | null;
	/** 皮肤目录下的路径(不给 `rel` 就是皮肤目录本身)。不认识的 id 抛错 —— 不替调用方拼出目录之外的路径。 */
	pathOf(id: string, rel?: string): string;
	/** 这套皮肤的包内资产存储(`<皮肤目录>/assets`)。不认识的 id 抛错,免得往皮肤目录外面写。 */
	assetsOf(id: string): AssetStore;
	/**
	 * 新建一套(新 id),整包在暂存目录里搭好再换上,回新 id。`files` 是清单之外的附带文件
	 * (相对皮肤目录的路径 → 内容;资产在 `assets/` 下),名字跑出皮肤目录抛 `TypeError`。
	 * 搭到一半失败:抛出去、不留暂存、索引不变。`assets/` 目录总会建出来,哪怕一份资产也没有。
	 */
	create(manifest: M, files?: ReadonlyMap<string, string | Uint8Array>): Promise<string>;
	/** 原子写清单并更新索引。不认识的 id 回 `false`。 */
	saveManifest(id: string, manifest: M): Promise<boolean>;
	/** 删一套:先改名再删,删到一半的残骸由开机清扫收。不认识的 id 回 `false`、一个字节都不动。 */
	remove(id: string): Promise<boolean>;
	/**
	 * 排进这套皮肤的写道。复合操作整个放进来;里面要存清单用参数递进来的 `saveManifest`(此时这套
	 * 皮肤的队已经轮到你:原子写清单并更新索引,皮肤已经不在就回 `false`、不重建目录),**不要**调本店
	 * 的 `saveManifest` / `remove` / `create`(它们各自排队,在这里调会等到自己前面去)。
	 */
	run<T>(
		id: string,
		task: (saveManifest: (manifest: M) => Promise<boolean>) => Promise<T>,
	): Promise<T>;
	/** 门面自己的根级文件(面板的 `active.json`)的写道:所有皮肤共用一个键,与各皮肤的队互不相干。 */
	runRoot<T>(task: () => Promise<T>): Promise<T>;
}

const ASSETS_DIR = "assets";

/** 老版本用 `.tmp`(暂存)与 `.deleting`(删除)结尾命名的残骸;现在的写法不再产生,但盘上可能还躺着。 */
const LEGACY_LEFTOVER = /\.(?:tmp|deleting)$/;

/**
 * 写道。**模块级、键 = 皮肤目录的绝对路径**(根级文件用皮肤根目录自己):同一份盘上状态的每次
 * 读改写都得排进同一条队,而队列不能住在 store 实例里。整个模块只有这一条队,关停时只 flush 它
 * ({@link flushSkinWrites}),**不关门** —— 同一个进程里下一个起的服务(测试里、重启不换进程的
 * 宿主里)还要往同一条队写,关了它们就写不进了。
 */
const skinQueue = createSerialQueue();

/** 等到所有皮肤门面已经交进来的写全部落盘(成功失败都算)。只 flush、不关门,理由见 {@link skinQueue}。 */
export function flushSkinWrites(): Promise<void> {
	return skinQueue.flush();
}

/** 皮肤 id:时间戳 36 进制 + 随机 hex(面板与卡片的 id schema 都认得这个形状)。 */
function newId(): string {
	return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** 清单的 mtime(ms);读不到就退回当下 —— 时间戳不值得让一次保存失败。 */
async function mtimeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return Date.now();
	}
}

/** 附带文件的名字得留在皮肤目录里:绝对路径与 `..` 一律不收(那是调用方的 bug,不是坏输入)。 */
function assertInsidePackage(rel: string): void {
	if (rel === "" || isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) {
		throw new TypeError(serverText("service.skins.skin-store.text.1", { value0: rel }));
	}
}

export function createSkinStore<M>(options: SkinPackageStoreOptions<M>): SkinPackageStore<M> {
	const { dir, manifestFile } = options;
	let index = new Map<string, { manifest: M; updatedAt: number }>();
	let ready: Promise<void> | undefined;

	const manifestPath = (id: string): string => join(dir, id, manifestFile);

	function requireKnown(id: string): void {
		if (!index.has(id))
			throw new Error(serverText("service.skins.skin-store.text.2", { value0: id }));
	}

	/**
	 * 读盘重建索引。**一份坏皮肤不许拖死启动**:读不出 / 不是 JSON / parse 不过的目录跳过并交给
	 * `onSkip`,既不进索引也不动它(交给人查,别静默删数据)。所以读清单**不用** storage 的
	 * `readJsonFile` —— 它会把坏文件隔离改名。
	 *
	 * 新索引搭好之后整个换上,而不是先 `clear()` 再一个个填:同步读者(出图)在重读的窗口里
	 * 不该看到半张空表。
	 */
	async function scan(): Promise<void> {
		await mkdir(dir, { recursive: true });
		const next = new Map<string, { manifest: M; updatedAt: number }>();
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const id = entry.name;
			if (!entry.isDirectory() || isLeftoverName(id) || LEGACY_LEFTOVER.test(id)) continue;
			const path = manifestPath(id);
			let raw: unknown;
			try {
				raw = JSON.parse(await readFile(path, "utf8"));
			} catch {
				options.onSkip?.(
					id,
					serverText("service.skins.skin-store.text.3", { value0: manifestFile }),
				);
				continue;
			}
			let parsed: ManifestResult<M>;
			try {
				parsed = options.parse(raw, id);
			} catch (err) {
				parsed = fail(
					"invalid",
					serverText("service.skins.skin-store.text.4", {
						value0: err instanceof Error ? err.message : String(err),
					}),
				);
			}
			if (!parsed.ok) {
				options.onSkip?.(id, parsed.message);
				continue;
			}
			next.set(id, { manifest: parsed.manifest, updatedAt: await mtimeOf(path) });
		}
		index = next;
	}

	function init(): Promise<void> {
		ready = scan();
		return ready;
	}

	function ensureReady(): Promise<void> {
		ready ??= scan();
		return ready;
	}

	/** 写清单本体。调用方已经排在这套皮肤的队里(`run` / `saveManifest`)。 */
	async function writeManifest(id: string, manifest: M): Promise<boolean> {
		// 排队的这段时间里,前面的写可能已经把它删了 —— 原子写会顺手把目录重建成一个空壳。
		if (!index.has(id)) return false;
		const path = manifestPath(id);
		await atomicWriteFile(path, options.serialize(manifest));
		index.set(id, { manifest, updatedAt: await mtimeOf(path) });
		return true;
	}

	/** 就绪之后再排进这套皮肤的队:写之前一定读过盘,新建的不会被随后到来的开机扫描顶掉。 */
	function run<T>(
		id: string,
		task: (saveManifest: (manifest: M) => Promise<boolean>) => Promise<T>,
	): Promise<T> {
		return skinQueue.run(resolve(dir, id), async () => {
			await ensureReady();
			return await task((manifest) => writeManifest(id, manifest));
		});
	}

	return {
		init,
		ensureReady,
		ids: () => [...index.keys()],
		has: (id) => index.has(id),
		get: (id) => index.get(id)?.manifest ?? null,
		updatedAt: (id) => index.get(id)?.updatedAt ?? null,

		pathOf(id, rel = "") {
			requireKnown(id);
			return join(dir, id, rel);
		},

		assetsOf(id) {
			requireKnown(id);
			return createAssetStore({ ...options.assets, dir: join(dir, id, ASSETS_DIR) });
		},

		async create(manifest, files = new Map()) {
			for (const rel of files.keys()) assertInsidePackage(rel);
			const id = newId();
			return await run(id, async () => {
				await replaceDirectory(join(dir, id), async (staging) => {
					await mkdir(join(staging, ASSETS_DIR), { recursive: true });
					await atomicWriteFile(join(staging, manifestFile), options.serialize(manifest));
					// 一份一份写,不并发:任何一份失败,暂存目录要能在没有别的写在飞的时候删干净。
					for (const [rel, data] of files) await atomicWriteFile(join(staging, rel), data);
				});
				index.set(id, { manifest, updatedAt: await mtimeOf(manifestPath(id)) });
				return id;
			});
		},

		saveManifest: (id, manifest) => run(id, (saveManifest) => saveManifest(manifest)),

		remove: (id) =>
			run(id, async () => {
				// 不认识的 id 一律不动手:门面把路由的 `:id` 原样交进来,而 `%2e%2e%2f` 这种写法 Hono
				// 会解码,`join(dir, "../..")` 就跑出了皮肤目录 —— 而这里删的是整个目录。
				if (!index.has(id)) return false;
				await removeDirectory(join(dir, id));
				index.delete(id);
				return true;
			}),

		run,

		runRoot: (task) =>
			skinQueue.run(resolve(dir), async () => {
				await ensureReady();
				return await task();
			}),
	};
}
