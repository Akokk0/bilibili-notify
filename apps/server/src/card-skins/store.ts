/**
 * 卡片皮肤库(ADR-0014 决策 2 / 5)。盘上形状 `<dir>/<id>/{card-skin.json, assets/*}`,
 * 与 dashboard 皮肤库(`skins/store.ts`)同规:盘上那一层(整包落盘、清单原子写、删除先改名、
 * 同一皮肤的写串行)共用皮肤包目录(`skins/skin-store.ts`),`init()` 全量读盘重建索引,
 * 资产路径永远经白名单正则再拼接,杜绝路径穿越。
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

import type { CardSkinSummary } from "@bilibili-notify/contract";
import {
	CARD_SKIN_LIMITS,
	type CardSkinKind,
	type CardSkinManifest,
	DEFAULT_CARD_SKIN,
	DEFAULT_CARD_SKIN_ID,
	type Failure,
	type FailureCode,
	parseCardSkin,
} from "@bilibili-notify/internal";
import { strToU8, zipSync } from "fflate";
import { FONT_EXT_TO_MIME } from "../runtime/font-mime.js";
import { EXT_TO_MIME } from "../runtime/image-mime.js";
import {
	createSkinStore,
	type ManifestResult,
	type SkinPackageStore,
} from "../skins/skin-store.js";
import { failureOfChecks } from "../util/failure-text.js";
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
 * 皮肤库拒收一件事的原因,只有这三种(标准码表的子集,规矩见 docs/agents/conventions/failure-results.md):
 * `invalid` 内容不合规矩(装包门、名字、体积),`not_found` 要动的皮肤不存在,
 * `conflict` 与当前状态冲突(内置只读、清单还引用着、撞名、份数满了)。
 */
export type CardSkinPackageFailureCode = Extract<FailureCode, "invalid" | "not_found" | "conflict">;

/**
 * 装包 / 保存 / 传资产被拒。**逐条错误单独带着**(不是拼成一句话):路由要把它们原样列给主人,
 * 而「哪一块的哪一段不合格」正是作者唯一能据以动手的信息。
 *
 * **自带码**,路由靠 {@link CardSkinPackageError.toFailure} 回给面板,不再嗅文案 —— 从前「还被用着」
 * 是 409、「名字不合法」是 400,分档全凭 `errors` 里有没有那四个字,改一个字就静默变成 400。
 */
export class CardSkinPackageError extends Error {
	readonly errors: string[];
	readonly code: CardSkinPackageFailureCode;
	constructor(errors: string[], code: CardSkinPackageFailureCode = "invalid") {
		super(errors.join("；"));
		this.name = "CardSkinPackageError";
		this.errors = errors;
		this.code = code;
	}

	/**
	 * 回给面板的失败:一句话就是 `message`;一串检查意见 `message` 概括、`issues` 逐条。
	 * `subject` 是概括那句里「谁没通过检查」(装 zip 包传「这个皮肤包」,其余缺省)。
	 */
	toFailure(subject = "这套皮肤"): Failure {
		return failureOfChecks(this.code, subject, this.errors);
	}
}

const ASSET_DIR = "assets";
/** `assets/` 前缀的长度 —— 包内名字 → 盘上文件名只差这一截。 */
const ASSET_PREFIX_LEN = `${ASSET_DIR}/`.length;

export class CardSkinStore {
	/** 盘上那一层:id → 清单的内存索引、整包落盘、按 id 串行的写道。内置那份**不在**里面。 */
	private readonly pkg: SkinPackageStore<CardSkinManifest>;
	private initWarnings: string[] = [];
	/** {@link ensureReady} 的一次性凭据 —— init 只该真的跑一遍。 */
	private ready?: Promise<void>;

	constructor(opts: { dir: string }) {
		this.pkg = createSkinStore<CardSkinManifest>({
			dir: opts.dir,
			manifestFile: CARD_SKIN_MANIFEST_FILE,
			parse: parseStoredManifest,
			serialize,
			assets: {
				formats: { ...EXT_TO_MIME, ...FONT_EXT_TO_MIME },
				maxBytes: CARD_SKIN_LIMITS.maxAssetBytes,
				naming: {
					kind: "given",
					isValidName: (name) => isCardSkinAssetName(`${ASSET_DIR}/${name}`),
				},
			},
			onSkip: (entry, message) => this.initWarnings.push(`${entry}: ${message}`),
		});
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
	 *
	 * ⚠️ **它自己把 {@link ensureReady} 那把锁也点上。** 从前 `init()` 只读盘、不碰
	 * `ready`,于是开机裸调它的调用方读完盘那把锁还空着,**首个请求会在请求路径上把整个
	 * 皮肤目录再读一遍**。代价不是那点 I/O:那时的重读开头一句 `index.clear()`,之后一串
	 * await 才填满,而出图那头 `get(id)` 是**同步**读同一个实例的索引 —— 这个窗口里撞上一次
	 * 推送就静默回落默认皮肤并记一笔 fallback(2026-09-19 审查)。现在皮肤包目录重扫时是
	 * 搭好新索引再整个换上,窗口本身没有了,但多读一遍仍是白费。锁点在这儿而不是只改那个
	 * 调用方,是因为下一个调用方不会知道要改。
	 */
	async init(): Promise<void> {
		this.initWarnings = [];
		const run = this.pkg.init();
		this.ready = run;
		await run;
	}

	/** `init()` 跳过了哪些目录、为什么。路由 / 启动日志拿它告诉主人,别让皮肤悄悄消失。 */
	warnings(): string[] {
		return [...this.initWarnings];
	}

	/** 内置那份在首位,其余按最近改动排。 */
	list(): CardSkinSummary[] {
		const rest: CardSkinSummary[] = [];
		for (const id of this.pkg.ids()) {
			const manifest = this.pkg.get(id);
			const updatedAt = this.pkg.updatedAt(id);
			if (manifest && updatedAt !== null) rest.push(summary(id, manifest, false, updatedAt));
		}
		rest.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
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
		const manifest = this.pkg.get(id);
		return manifest ? structuredClone(manifest) : null;
	}

	has(id: string): boolean {
		return id === DEFAULT_CARD_SKIN_ID || this.pkg.has(id);
	}

	/** 装一个 zip 包:摊开 → 验+洗 → 落盘。任何一步不过一律抛 {@link CardSkinPackageError}。 */
	async install(zip: Uint8Array): Promise<{ id: string; warnings: string[] }> {
		const opened = parseCardSkinPackage(zip);
		if (!opened.ok) throw new CardSkinPackageError(opened.errors);
		const checked = checkCardSkinPackage(opened.manifestRaw, new Set(opened.assets.keys()));
		if (!checked.ok) throw new CardSkinPackageError(checked.errors);
		// 落盘的是**洗过的**那份 —— 出图那头不该再洗一遍,也不该有机会读到原文。
		const id = await this.writePackage(checked.manifest, opened.assets);
		return { id, warnings: checked.warnings };
	}

	/**
	 * 从一份清单新建一套(没有资产)。卡片工坊「新做一套」走这条(ADR-0015 决策 13 的 🔗),
	 * 与装包同一道验 + 洗。
	 */
	async create(manifestRaw: unknown): Promise<{ id: string; warnings: string[] }> {
		const checked = checkCardSkinPackage(manifestRaw, new Set());
		if (!checked.ok) throw new CardSkinPackageError(checked.errors);
		const id = await this.writePackage(checked.manifest, new Map());
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
		// 与 `exportZip` 同一个理由:各张资产之间没有先后关系,串行读等于把几十次系统
		// 调用排成一条队,而主人在等这份副本。
		const read = await Promise.all(
			(await this.listAssets(id)).map(
				async (name) => [name, await this.readAsset(id, name)] as const,
			),
		);
		const assets = new Map<string, Uint8Array>();
		for (const [name, bytes] of read) {
			if (bytes) assets.set(name, bytes);
		}
		const checked = checkCardSkinPackage(manifest, new Set(assets.keys()));
		if (!checked.ok) throw new CardSkinPackageError(checked.errors);
		return { id: await this.writePackage(checked.manifest, assets) };
	}

	/** 删一套。内置那份删不掉;不认识的 id 抛错(调用方得分得清「没这套」与「删好了」)。 */
	async remove(id: string): Promise<void> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new Error("内置的默认皮肤删不掉 —— 想改它请先「复制一份」");
		}
		// 不认识的 id 一律不动手:路由把 `:id` 原样交进来,而这里干的是整目录删除
		// (dashboard 那头 2026-08-19 实测过 `%2e%2e%2f` 能穿出皮肤目录)。这道守卫在皮肤包目录里
		// (`remove` 只认索引里的 id),落盘的删法也在那儿:先改名再删,删到一半留下的残骸
		// 开机扫描认得出不是皮肤,由开机清扫收。
		if (!(await this.pkg.remove(id))) throw new Error(`皮肤不存在: ${id}`);
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
		if (!this.pkg.has(id)) return [];
		const assets = await this.pkg.assetsOf(id).list();
		return assets.map((a) => `${ASSET_DIR}/${a.id}`);
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
	 *
	 * **查同名、数份数、写盘整个排在这套皮肤的写道里**:资产存储按给定的名字存、同名直接
	 * 覆盖,所以「查同名」与「写盘」之间要是留着空隙,同名的两个请求会一起穿过闸门、后到的
	 * 悄悄顶掉先到的;份数也一样,几个请求一起数到「还差一份」就一起越过上限。
	 */
	async addAsset(id: string, filename: string, bytes: Uint8Array): Promise<{ name: string }> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new CardSkinPackageError(
				["内置的默认皮肤加不了资产 —— 想改它请先「复制一份」"],
				"conflict",
			);
		}
		if (!this.pkg.has(id)) throw new CardSkinPackageError(["卡片皮肤不存在"], "not_found");

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
		return await this.pkg.run(id, async () => {
			// 排队的这段时间里,前面的写可能已经把这套皮肤删了。
			if (!this.pkg.has(id)) throw new CardSkinPackageError(["卡片皮肤不存在"], "not_found");
			const existing = await this.listAssets(id);
			if (existing.includes(name)) {
				throw new CardSkinPackageError(
					[`已经有一份叫「${base}」的了 —— 先删掉那份再传`],
					"conflict",
				);
			}
			if (existing.length >= CARD_SKIN_LIMITS.maxAssets) {
				throw new CardSkinPackageError(
					[
						`这套皮肤已经 ${existing.length} 份资产,上限 ${CARD_SKIN_LIMITS.maxAssets} 份 —— 删掉用不上的再传`,
					],
					"conflict",
				);
			}
			const put = await this.pkg
				.assetsOf(id)
				.put({ bytes, ext: base.slice(base.lastIndexOf(".") + 1), name: base });
			if (!put.ok) throw new CardSkinPackageError([put.message]);
			return { name };
		});
	}

	/**
	 * 删一份资产。**清单还引用着就不许删** —— 删了这套皮肤连自己都存不下去(下次保存装包门
	 * 判「指了…,但包里没有这份资产」),而主人看到的只是一句莫名其妙的报错。
	 */
	async removeAsset(id: string, name: string): Promise<void> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new CardSkinPackageError(["内置的默认皮肤没有落盘的资产"], "conflict");
		}
		if (!this.pkg.has(id)) throw new CardSkinPackageError(["卡片皮肤不存在"], "not_found");
		if (!isCardSkinAssetName(name)) throw new CardSkinPackageError(["资产名不合法"]);

		// 「清单还引用着吗」与删文件排在同一条写道里:中间不许有编辑器保存钻进来把引用加回去。
		await this.pkg.run(id, async () => {
			if (!this.pkg.has(id)) throw new CardSkinPackageError(["卡片皮肤不存在"], "not_found");
			const users = assetUsers(this.get(id), name);
			if (users.length > 0) {
				throw new CardSkinPackageError(
					[`「${name}」还被用着(${users.join("、")})—— 先在编辑器里换掉再删`],
					"conflict",
				);
			}
			// 文件本来就不在也算删好了,不抛。
			await this.pkg.assetsOf(id).remove(name.slice(ASSET_PREFIX_LEN));
		});
	}

	/** 读一份资产;名字不合白名单、皮肤不存在、文件不在 → null(三条都不抛)。 */
	async readAsset(id: string, name: string): Promise<Uint8Array | null> {
		if (!this.pkg.has(id)) return null;
		if (!isCardSkinAssetName(name)) return null;
		const read = await this.pkg.assetsOf(id).read(name.slice(ASSET_PREFIX_LEN));
		return read ? new Uint8Array(read.bytes) : null;
	}

	/**
	 * 编辑器保存:走**与装包同一道**验+洗,只是资产清单来自盘上。
	 *
	 * 内置那份存不了(它没有落盘的身子);清洗产物照旧写回,所以盘上永远是洗过的。
	 * 「读盘上有哪些资产」与写清单排在同一条写道里:资产清单是校验的依据,校验完到落盘
	 * 之间不许有加 / 删资产的请求钻进来,否则清单可能引用一份刚被删掉的资产。
	 */
	async save(id: string, manifestRaw: unknown): Promise<{ warnings: string[] }> {
		if (id === DEFAULT_CARD_SKIN_ID) {
			throw new Error("内置的默认皮肤改不了 —— 想改它请先「复制一份」");
		}
		return await this.pkg.run(id, async (saveManifest) => {
			if (!this.pkg.has(id)) throw new Error(`皮肤不存在: ${id}`);
			const checked = checkCardSkinPackage(manifestRaw, new Set(await this.listAssets(id)));
			if (!checked.ok) throw new CardSkinPackageError(checked.errors);
			await saveManifest(checked.manifest);
			return { warnings: checked.warnings };
		});
	}

	/** 整套皮肤落盘(暂存目录里搭好再整目录换上 —— 断电不会留下半套),回新 id。 */
	private async writePackage(
		manifest: CardSkinManifest,
		assets: ReadonlyMap<string, Uint8Array>,
	): Promise<string> {
		const files = new Map<string, Uint8Array>();
		for (const [name, data] of assets) {
			// 白名单再过一遍:名字要拼进磁盘路径,而这一步离「谁检查过它」已经隔了几层。
			if (isCardSkinAssetName(name)) files.set(name, data);
		}
		return await this.pkg.create(manifest, files);
	}
}

/**
 * 开机读盘时一份清单的取舍:只问形状,不重洗 —— 落盘那一刻洗过了。形状不对的多半是手改坏的,
 * 跳过并说清。盘上叫 `default` 的目录不加载:那是内置皮肤的保留 id。
 */
function parseStoredManifest(raw: unknown, id: string): ManifestResult<CardSkinManifest> {
	if (id === DEFAULT_CARD_SKIN_ID) {
		return {
			ok: false,
			code: "invalid",
			message: "这个 id 是内置皮肤的保留字,盘上这份目录不会被加载",
		};
	}
	const parsed = parseCardSkin(raw);
	if (!parsed.ok) {
		return {
			ok: false,
			code: "invalid",
			message: `清单不合格式(${parsed.errors[0] ?? "未知原因"}),跳过`,
		};
	}
	return { ok: true, manifest: parsed.manifest };
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
		kinds: Object.keys(m.cards) as CardSkinKind[],
	};
}

/** 盘上那份清单的字面:带缩进,主人 / 第三方是要手看手改它的。 */
function serialize(manifest: CardSkinManifest): string {
	return JSON.stringify(manifest, null, "\t");
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
