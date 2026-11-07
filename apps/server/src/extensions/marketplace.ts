import { createHash } from "node:crypto";
import type {
	MarketplaceEntryState,
	MarketplaceEntryView,
	MarketplaceResponse,
	MarketplaceSourceView,
} from "@bilibili-notify/contract";
import {
	apiVersionAccepted,
	checkMarketplaceIndex,
	EXTENSION_API_RANGE,
	type ExtensionApiRange,
	fail,
	isMarketplaceRevoked,
	isPrereleaseEntry,
	type Logger,
	type MarketplaceEntry,
	type MarketplaceIndex,
	MarketplaceIndexSchema,
	type MarketplaceSource,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { logText, t as serverText } from "../i18n/index.js";
import { readBestEffortJson, writeBestEffortJson } from "../update/durable-json.js";
import { fetchSignedJson, signedFailureKind } from "../update/fetch-signed-manifest.js";
import { fetchThroughMirrors, mirrorChain } from "../update/fetch-through-mirrors.js";
import { compareVersions } from "../update/version-order.js";
import { ExtensionConflictError } from "./conflict-error.js";
import { apiVersionMismatch } from "./discover.js";
import {
	docsPresence,
	installExtensionPackage,
	MAX_EXTENSION_PACKAGE_BYTES,
	openExtensionPackage,
} from "./install.js";

/**
 * 拓展市场(ADR-0013)。
 *
 * 一个内置的**官方源**(签名索引、走加速镜像、不能删)+ 主人自己加的**第三方源**(裸 JSON、
 * 不签、不走镜像)。每个源一份 `marketplace.json`,列它能装的拓展 —— 每个 id 每档、每个契约版本
 * 最新那一版(一条正式 + 一条预发布),面板上仍然只出一张卡({@link pickPerId})。
 * 装 = 下载 → 对索引里的 sha256(防的是下载途中被换包,不是防作者)→ 走面板上传装包那
 * **同一段**落地逻辑 → 记下「从哪个源装的哪一版」→ 让装载器重扫。
 *
 * 信任分两档:官方源多一道签名与新鲜度;第三方源谁控制了那个地址谁就能换内容 —— 这正是
 * 添加第三方源时要提示的风险,这里只保证「装到盘上的确实是索引说的那个包」。
 */

const MARKETPLACE_OFFICIAL_SOURCE_ID = "official";
/** 住在装载根里的来源记录。它是系统状态不是用户配置,所以不进 globals。 */
export const MARKETPLACE_PROVENANCE_FILE = ".marketplace.json";

const DEFAULT_MAX_INDEX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_CACHE_MS = 5 * 60_000;

interface MarketplaceOfficialSource {
	/** 官方索引的固定地址(`extensions` 那个滚动 release 上的 `marketplace.json`)。 */
	url: string;
	/** 内置信任列表 —— 与自主升级同一对公钥。 */
	trustedKeys: readonly string[];
}

export interface MarketplaceDeps {
	reservedIntegrationKeys: readonly string[];
	/** 装载根 —— `<数据根>/extensions/`。 */
	root: string;
	/** 没有 = 这个构建没有官方源(fork 出去没有信任公钥的构建)。 */
	official?: MarketplaceOfficialSource;
	/** 主人自己加的第三方源,现读。 */
	sources: () => readonly MarketplaceSource[];
	/** 加速前缀,现读 —— 只用于官方源(第三方源的地址前面拼一个 GitHub 加速站只会拼出废话)。 */
	mirrors: () => readonly string[];
	/** BN 自己现在是不是预发布渠道:是才列预发布条目。 */
	prerelease: () => boolean;
	/** 盘上装着的拓展(装载器现取)。 */
	installed: () => readonly { id: string; version?: string }[];
	/**
	 * **在装载器那条队里改盘**(装载器的 `changeDisk()`):`write` 落盘,紧跟着再扫一遍。队外写的话,
	 * 并发的开关 / 重扫 / 只重载会看见写了一半的目录(ADR-0019 决策 45)。
	 */
	changeDisk: <T>(write: () => Promise<T>) => Promise<T>;
	logger: Logger;
	/** 宿主认的档位区间。只有测试会换。 */
	hostApiRange?: ExtensionApiRange;
	timeoutMs?: number;
	downloadTimeoutMs?: number;
	maxIndexBytes?: number;
	/** 索引缓存多久;`list({ refresh: true })` 无视它。 */
	cacheMs?: number;
	now?: () => number;
}

/**
 * 从市场装的结果。失败各有各的码(规矩见 docs/agents/conventions/failure-results.md):
 * `not_found` 没这个源 / 源里没这个拓展 / 这一版已被撤回,`unavailable` 源的索引没拿到或包下不下来,
 * `unsupported` 这台 BN 的档位装不了它,`invalid` 包超上限 / 校验和对不上 / 拆不开 / 清单与索引说的不是一个,
 * `conflict` 目标是 devtools 链进来的软链。`message` 是给主人看的中文原话。
 */
export type MarketplaceInstallResult = Result<{
	id: string;
	name: string;
	version: string;
	/** 包里带没带那两份说明 —— 拆包时就知道,一路带回给面板。 */
	docs: { readme: boolean; changelog: boolean };
	/** 包里跳过没写进盘的译文文件(见 `OpenedExtensionPackage.skippedLocales`);没有就没有这一格。 */
	skippedLocales?: string[];
}>;

export interface Marketplace {
	list(opts?: { refresh?: boolean }): Promise<MarketplaceResponse>;
	install(sourceId: string, id: string): Promise<MarketplaceInstallResult>;
}

interface ProvenanceRecord {
	source: string;
	version: string;
	installedAt: number;
}

interface Provenance {
	/** 官方索引见过的最大 `issuedAt` —— 比它旧的一律不收(加速站会回放旧的)。 */
	officialIssuedAt?: number;
	installed: Record<string, ProvenanceRecord>;
	/**
	 * 每个第三方源上次报的命名空间(源 id → 命名空间)。占位是**记在盘上**的:命名空间
	 * 撞了要拒后面那个,而「后面」得按配置顺序算,不能按「谁这一趟先拉到」算 —— 先配的
	 * 源某次超时,后配的源就抢到了它的命名空间,而它装着的拓展 id 全在那个命名空间下。
	 */
	namespaces: Record<string, string>;
}

/** 命名空间的占位:谁占着(源 id)、面板上写谁的名字。 */
interface NamespaceHolder {
	sourceId: string;
	name: string;
}

interface LoadedSource {
	view: MarketplaceSourceView;
	index?: MarketplaceIndex;
}

function readProvenance(root: string): Provenance {
	const raw = readBestEffortJson(root, MARKETPLACE_PROVENANCE_FILE) as
		| Partial<Provenance>
		| undefined;
	const installed: Record<string, ProvenanceRecord> = {};
	if (raw && typeof raw === "object" && raw.installed && typeof raw.installed === "object") {
		for (const [id, record] of Object.entries(raw.installed)) {
			if (
				record &&
				typeof record === "object" &&
				typeof record.source === "string" &&
				typeof record.version === "string"
			) {
				installed[id] = {
					source: record.source,
					version: record.version,
					installedAt: typeof record.installedAt === "number" ? record.installedAt : 0,
				};
			}
		}
	}
	const namespaces: Record<string, string> = {};
	if (raw && typeof raw === "object" && raw.namespaces && typeof raw.namespaces === "object") {
		for (const [sourceId, ns] of Object.entries(raw.namespaces)) {
			if (typeof ns === "string" && ns !== "") namespaces[sourceId] = ns;
		}
	}
	return {
		officialIssuedAt: typeof raw?.officialIssuedAt === "number" ? raw.officialIssuedAt : undefined,
		installed,
		namespaces,
	};
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 同一个 id 索引里每个契约版本最多两条(正式 + 预发布),**面板上只画一张卡** —— 挑哪一条看 BN 自己
 * 在哪个渠道:
 *
 * - 稳定渠道只认正式那条(没有正式档就一张卡都不出:那个拓展现在只发了预发布);
 * - 预发布渠道在两档里取**版本更高**的那条 —— 不是「有预发布就用预发布」。我们自己并索引
 *   时会把比正式版旧的预发布删掉,但第三方源的索引不归我们管,信它一定干净的话,尝鲜的人
 *   会被推荐一个比正式版还旧的版本。
 *
 * 挑出来的这一条是这张卡的全部依据:版本、状态、「有新版」、装的时候下哪个包。分两处挑会
 * 画出一张写着 A 而按下去装 B 的卡。
 *
 * 契约升档的过渡期里,同一个 id 同一档还可以按契约版本各留一条(旧 BN 只装得了旧契约那条、
 * 新 BN 只装得了新契约那条)。所以**先在这台 BN 装得了的(`fits`)里头**按上面的渠道规矩取
 * 版本最高的;一条都装不了才退回在全部候选里取最高,画一张「先升级 BN」的灰卡 —— 这与只有
 * 一个契约版本时的行为一样,卡上写的是索引里最新的那一版。
 */
function pickPerId(
	entries: readonly MarketplaceEntry[],
	prerelease: boolean,
	fits: (entry: MarketplaceEntry) => boolean,
): Map<string, MarketplaceEntry> {
	const higher = (a: MarketplaceEntry, b: MarketplaceEntry | undefined) =>
		!b || compareVersions(a.version, b.version) > 0;
	const best = new Map<string, MarketplaceEntry>();
	const bestFit = new Map<string, MarketplaceEntry>();
	for (const entry of entries) {
		if (isPrereleaseEntry(entry) && !prerelease) continue;
		if (higher(entry, best.get(entry.id))) best.set(entry.id, entry);
		if (fits(entry) && higher(entry, bestFit.get(entry.id))) bestFit.set(entry.id, entry);
	}
	// 装得了的覆盖全部里最高的;没有装得了的 id 就保留 best 里那条。
	return new Map([...best, ...bestFit]);
}

/** 字节数说成人话(一位小数的 MB)。 */
function mib(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

/** 索引拿不到 / 验不过时给主人看的那句 —— 四种原因四句话,别混成「连接出错」。 */
const OFFICIAL_FAILURE_TEXT = {
	get unreachable() {
		return serverText("service.extensions.marketplace.text.1");
	},
	get untrusted() {
		return serverText("service.extensions.marketplace.text.2");
	},
	get malformed() {
		return serverText("service.extensions.marketplace.text.3");
	},
	get stale() {
		return serverText("service.extensions.marketplace.text.4");
	},
} as const;

export function createMarketplace(deps: MarketplaceDeps): Marketplace {
	const indexSchema = MarketplaceIndexSchema.refine((index) =>
		index.extensions.every((entry) => !deps.reservedIntegrationKeys.includes(entry.id)),
	);
	const now = deps.now ?? (() => Date.now());
	const hostApiRange = deps.hostApiRange ?? EXTENSION_API_RANGE;
	/**
	 * 这一条宿主装不装得了(档位 + 契约小号)—— 列表的状态与真去装那一刻用**同一把尺子**,
	 * 也是读清单用的那一把。
	 */
	const fitsHost = (entry: MarketplaceEntry): boolean => apiVersionAccepted(entry, hostApiRange);
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const downloadTimeoutMs = deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
	const maxIndexBytes = deps.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
	const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;

	let cache: { at: number; loaded: LoadedSource[] } | undefined;

	async function loadOfficial(official: MarketplaceOfficialSource): Promise<LoadedSource> {
		const seenIssuedAt = readProvenance(deps.root).officialIssuedAt;
		const fetched = await fetchSignedJson({
			url: official.url,
			mirrors: mirrorChain(deps.mirrors()),
			trustedKeys: official.trustedKeys,
			timeoutMs,
			maxBytes: maxIndexBytes,
			minIssuedAt: seenIssuedAt,
			schema: indexSchema,
			issuedAtOf: (index) => index.issuedAt,
		});
		const base = { id: MARKETPLACE_OFFICIAL_SOURCE_ID, official: true };
		if (!fetched.ok) {
			return {
				view: {
					...base,
					get name() {
						return serverText("service.extensions.marketplace.text.5");
					},
					...fail(fetched.code, OFFICIAL_FAILURE_TEXT[signedFailureKind(fetched)]),
				},
			};
		}
		const checked = checkMarketplaceIndex(fetched.value, { official: true });
		if (!checked.ok) {
			return {
				view: {
					...base,
					name: fetched.value.name,
					...fail(
						"invalid",
						serverText("service.extensions.marketplace.text.6", { value0: checked.message }),
					),
				},
			};
		}
		const issuedAt = fetched.value.issuedAt;
		if (issuedAt !== undefined) {
			// 现读现写:拉索引是一趟网络往返,这中间别处(装一个拓展)可能已经往同一份来源
			// 记录上记过账了。拿 await 之前那份快照整份写回去等于把它抹掉 —— 读-改-写之间
			// 不许有 await。
			const current = readProvenance(deps.root);
			if ((current.officialIssuedAt ?? 0) < issuedAt) {
				writeBestEffortJson(deps.root, MARKETPLACE_PROVENANCE_FILE, {
					...current,
					officialIssuedAt: issuedAt,
				});
			}
		}
		return { view: ok({ ...base, name: fetched.value.name }), index: fetched.value };
	}

	/** 索引拿到之前叫什么:用户没起名(通常没有),就拿域名顶着。 */
	function placeholderName(source: MarketplaceSource): string {
		if (source.name) return source.name;
		try {
			return new URL(source.url).host;
		} catch {
			return source.url;
		}
	}

	/**
	 * 一个第三方源这一趟拉到了什么 —— **只有网络那一半**。
	 *
	 * 命名空间的占位判断刻意不在这儿:那件事得按**配置顺序**算,而这些请求是一起发出去的,
	 * 谁先回来归网络管。两件事混在一条函数里的话,并发一开,「谁占住了这个命名空间」就成了
	 * 抽签。
	 */
	type ThirdPartyFetchResult = Result<{ index: MarketplaceIndex }>;

	async function fetchThirdParty(source: MarketplaceSource): Promise<ThirdPartyFetchResult> {
		const fetched = await fetchThroughMirrors<MarketplaceIndex>({
			url: source.url,
			mirrors: [""],
			timeoutMs,
			maxBytes: maxIndexBytes,
			accept: (bytes) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
				} catch {
					return fail("invalid", serverText("service.extensions.marketplace.text.7"));
				}
				const shaped = indexSchema.safeParse(parsed);
				if (!shaped.success)
					return fail("invalid", serverText("service.extensions.marketplace.text.8"));
				const checked = checkMarketplaceIndex(shaped.data, { official: false });
				if (!checked.ok) return checked;
				return ok({ value: shaped.data });
			},
		});
		if (!fetched.ok)
			return fail(
				fetched.code,
				fetched.code === "invalid"
					? fetched.message
					: serverText("service.extensions.marketplace.text.9"),
			);
		return ok({ index: fetched.value });
	}

	/**
	 * 命名空间仲裁 —— 拉到的那份配不配得上它声明的命名空间。**按配置顺序**一个个过,
	 * 先配的源占着的,后配的抢不走(理由见 {@link Provenance.namespaces})。
	 */
	function admitThirdParty(
		source: MarketplaceSource,
		fetched: ThirdPartyFetchResult,
		taken: Map<string, NamespaceHolder>,
	): LoadedSource {
		const base = { id: source.id, name: placeholderName(source), official: false, url: source.url };
		// 拉不到 / 不合规矩时索引里那个名字还没有,拿域名顶着 —— 别让错误行上写一个 uuid。
		if (!fetched.ok) return { view: { ...base, ...fetched } };
		// 名字以索引自己报的为准 —— 用户加源时只填了地址。
		const named = { ...base, name: fetched.index.name };
		const ns = fetched.index.namespace as string;
		const holder = taken.get(ns);
		if (holder !== undefined && holder.sourceId !== source.id) {
			return {
				view: {
					...named,
					namespace: ns,
					...fail(
						"conflict",
						serverText("service.extensions.marketplace.text.10", {
							value0: ns,
							value1: holder.name,
						}),
					),
				},
			};
		}
		taken.set(ns, { sourceId: source.id, name: named.name });
		return { view: ok({ ...named, namespace: ns }), index: fetched.index };
	}

	/**
	 * 按**配置顺序**把上次记下的命名空间先占上 —— 拉索引之前就占好,这一趟谁拉失败都不
	 * 影响谁占着什么。之后拉到的以拉到的为准(源换了命名空间是它自己的事)。
	 */
	function seedTaken(sources: readonly MarketplaceSource[]): Map<string, NamespaceHolder> {
		const remembered = readProvenance(deps.root).namespaces;
		const taken = new Map<string, NamespaceHolder>();
		for (const source of sources) {
			const ns = remembered[source.id];
			if (ns === undefined || taken.has(ns)) continue;
			taken.set(ns, { sourceId: source.id, name: placeholderName(source) });
		}
		return taken;
	}

	/** 占位落盘。只留**还配着**的源 —— 源删掉了它占的命名空间就得还回去。 */
	function rememberNamespaces(
		sources: readonly MarketplaceSource[],
		taken: Map<string, NamespaceHolder>,
	): void {
		const next: Record<string, string> = {};
		for (const [ns, holder] of taken) {
			if (sources.some((source) => source.id === holder.sourceId)) next[holder.sourceId] = ns;
		}
		// 读-改-写之间没有 await:上面那一串拉取早就跑完了。
		const current = readProvenance(deps.root);
		if (JSON.stringify(current.namespaces) === JSON.stringify(next)) return;
		writeBestEffortJson(deps.root, MARKETPLACE_PROVENANCE_FILE, { ...current, namespaces: next });
	}

	async function loadAll(refresh: boolean): Promise<LoadedSource[]> {
		if (!refresh && cache && now() - cache.at < cacheMs) return cache.loaded;
		const sources = deps.sources();
		// 🔴 **拉是并发的,认领是串行的。** 逐个 await 的话,一个卡住的源(超时一次就是十秒)
		// 会把排在它后面的每一个源都推后,而源与源之间没有任何依赖。认领反过来:命名空间
		// 必须按**配置顺序**判,不能按「谁先回来」判 —— 那等于让网络快慢决定谁占得住,而
		// 占着的那个命名空间底下挂着主人已经装好的一堆拓展。
		const [official, fetched] = await Promise.all([
			deps.official ? loadOfficial(deps.official) : undefined,
			Promise.all(sources.map(async (source) => [source, await fetchThirdParty(source)] as const)),
		]);
		const taken = seedTaken(sources);
		const loaded: LoadedSource[] = [];
		if (official) loaded.push(official);
		for (const [source, one] of fetched) loaded.push(admitThirdParty(source, one, taken));
		rememberNamespaces(sources, taken);
		cache = { at: now(), loaded };
		return loaded;
	}

	function stateOf(
		entry: MarketplaceEntry,
		sourceId: string,
		index: MarketplaceIndex,
		provenance: Provenance,
		/** 盘上装着的,按 id 索引。一份,不是每条条目现算一遍。 */
		installedOnDisk: Map<string, { id: string; version?: string }>,
	): { state: MarketplaceEntryState; installed?: MarketplaceEntryView["installed"] } {
		const onDisk = installedOnDisk.get(entry.id);
		const record = provenance.installed[entry.id];
		if (onDisk) {
			// 来源记录说的是「哪一版从哪儿装的」;盘上那份要是被别的路盖掉了(手放 / 上传),
			// 版本对不上,来源记录就不作数 —— 更新只认原来源,而原来源已经不是它了。
			const fromHere =
				record?.source === sourceId &&
				(onDisk.version === undefined || onDisk.version === record.version);
			const installed = { version: onDisk.version, source: fromHere ? record.source : undefined };
			if (!fromHere) return { state: "installed-elsewhere", installed };
			// 「有新版」那颗钮画出来就得按得动:索引里那个新版自己装不了的两种情形
			// (它被撤回了、它要更高一格的宿主契约),install() 会当场拒 —— 别画出来
			// 让主人点一次再吃一句错。
			const newer = compareVersions(entry.version, record.version) > 0;
			const installable = !isMarketplaceRevoked(index, entry.id, entry.version) && fitsHost(entry);
			const updatable = newer && installable;
			// 🔴 **撤回先看有没有路可走**:装着那版被撤回、而索引里有能换过去的新版,恰恰是最该
			// 更新的时候 —— 先判撤回就返回 `revoked` 的话,几处更新入口一颗钮都不给。所以照
			// `updatable` 给,红字靠 `installed.revoked` 另说。换不过去才是 `revoked`。
			if (isMarketplaceRevoked(index, entry.id, record.version)) {
				return updatable
					? { state: "updatable", installed: { ...installed, revoked: true } }
					: { state: "revoked", installed };
			}
			// 压回 installed:装着那版好好的。
			return { state: updatable ? "updatable" : "installed", installed };
		}
		if (isMarketplaceRevoked(index, entry.id, entry.version)) return { state: "revoked" };
		if (!fitsHost(entry)) return { state: "incompatible" };
		return { state: "installable" };
	}

	function toView(loaded: LoadedSource[]): MarketplaceResponse {
		const provenance = readProvenance(deps.root);
		// 装载器那份名单问一次就够:每条条目各问一遍等于把整张表扫成 O(条目 × 装着的)。
		const installedOnDisk = new Map(deps.installed().map((one) => [one.id, one]));
		const prerelease = deps.prerelease();
		const extensions: MarketplaceEntryView[] = [];
		for (const source of loaded) {
			if (!source.index) continue;
			for (const entry of pickPerId(source.index.extensions, prerelease, fitsHost).values()) {
				const { state, installed } = stateOf(
					entry,
					source.view.id,
					source.index,
					provenance,
					installedOnDisk,
				);
				extensions.push({
					source: source.view.id,
					official: source.view.official,
					id: entry.id,
					name: entry.name,
					description: entry.description,
					version: entry.version,
					apiVersion: entry.apiVersion,
					apiRevision: entry.apiRevision,
					prerelease: isPrereleaseEntry(entry),
					notes: entry.notes,
					releaseUrl: entry.releaseUrl,
					size: entry.package.size,
					installed,
					state,
				});
			}
		}
		return {
			available: deps.official !== undefined,
			sources: loaded.map((source) => source.view),
			extensions,
			fetchedAt: new Date(cache?.at ?? now()).toISOString(),
		};
	}

	async function install(sourceId: string, id: string): Promise<MarketplaceInstallResult> {
		const loaded = await loadAll(false);
		const source = loaded.find((candidate) => candidate.view.id === sourceId);
		if (!source)
			return fail(
				"not_found",
				serverText("service.extensions.marketplace.text.11", { value0: sourceId }),
			);
		if (!source.index) {
			return fail(
				"unavailable",
				serverText("service.extensions.marketplace.text.13", {
					value0: source.view.name,
					value1: !source.view.ok
						? source.view.message
						: serverText("service.extensions.marketplace.text.12"),
				}),
			);
		}
		// 🔴 挑条目必须与 list() 用**同一把尺子**:索引里同一个 id 有两档,拿 find() 取第一条
		// 的话,面板上那张卡写着 A、按下去装的是 B —— 而两边都全绿。
		const entry = pickPerId(source.index.extensions, deps.prerelease(), fitsHost).get(id);
		if (!entry)
			return fail(
				"not_found",
				serverText("service.extensions.marketplace.text.14", {
					value0: source.view.name,
					value1: id,
				}),
			);
		if (!fitsHost(entry)) {
			return fail("unsupported", `${entry.name}:${apiVersionMismatch(entry, hostApiRange)}`);
		}
		if (isMarketplaceRevoked(source.index, entry.id, entry.version)) {
			return fail(
				"not_found",
				serverText("service.extensions.marketplace.text.15", {
					value0: entry.name,
					value1: entry.version,
				}),
			);
		}
		// 索引自己写了包有多大,那就是这一次的上限 —— 拿 10MB 硬顶当上限等于允许对面
		// 灌到 10MB 才停,而我们本来就知道该收多少。超过本机上限的得说清是上限:
		// 报「下不下来」会把主人支去查网络。
		if (entry.package.size > MAX_EXTENSION_PACKAGE_BYTES) {
			return fail(
				"invalid",
				serverText("service.extensions.marketplace.text.16", {
					value0: entry.name,
					value1: mib(entry.package.size),
					value2: mib(MAX_EXTENSION_PACKAGE_BYTES),
				}),
			);
		}

		const downloaded = await fetchThroughMirrors<Uint8Array>({
			url: entry.package.url,
			// 只有官方源的包在 GitHub 上,加速前缀才拼得出东西。
			mirrors: source.view.official ? mirrorChain(deps.mirrors()) : [""],
			timeoutMs: downloadTimeoutMs,
			maxBytes: Math.min(entry.package.size, MAX_EXTENSION_PACKAGE_BYTES),
			accept: (bytes) =>
				bytes.byteLength === entry.package.size && sha256Hex(bytes) === entry.package.sha256
					? ok({ value: bytes })
					: fail("invalid", serverText("service.extensions.marketplace.text.17")),
		});
		if (!downloaded.ok) {
			return downloaded.code === "invalid"
				? fail("invalid", serverText("service.extensions.marketplace.text.17"))
				: fail(
						"unavailable",
						serverText("service.extensions.marketplace.text.18", {
							value0: entry.name,
							value1: entry.package.url,
						}),
					);
		}

		const opened = openExtensionPackage(downloaded.value, deps.reservedIntegrationKeys);
		if (!opened.ok) {
			// 拆包那几句(哪一处不合规矩)原样带上:主人手里没有这个包,它们是源作者唯一的线索。
			return fail(
				opened.code,
				serverText("service.extensions.marketplace.text.19", { value0: opened.message }),
				{ issues: opened.issues },
			);
		}
		if (opened.pkg.id !== entry.id || opened.pkg.manifest.version !== entry.version) {
			return fail(
				"invalid",
				serverText("service.extensions.marketplace.text.20", {
					value0: opened.pkg.id,
					value1: opened.pkg.manifest.version,
					value2: entry.id,
					value3: entry.version,
				}),
			);
		}
		// 落盘 → 记来源,在装载器的队里是一件事,紧跟着那一遍重扫由队替我们做。
		try {
			await deps.changeDisk(async () => {
				await installExtensionPackage({ root: deps.root, pkg: opened.pkg });
				const provenance = readProvenance(deps.root);
				provenance.installed[entry.id] = {
					source: source.view.id,
					version: entry.version,
					installedAt: now(),
				};
				writeBestEffortJson(deps.root, MARKETPLACE_PROVENANCE_FILE, provenance);
			});
		} catch (err) {
			// 只接可预期的拒绝(目标是软链);磁盘写失败之类是 bug 或环境的事,往外抛给全局出错处理。
			if (err instanceof ExtensionConflictError) return err.toFailure();
			throw err;
		}
		deps.logger.info(logText("log.extension.marketInstalled"), {
			extensionId: entry.id,
			version: entry.version,
			sourceName: source.view.name,
		});
		return ok({
			id: entry.id,
			name: opened.pkg.manifest.name,
			version: entry.version,
			// 「新版等着换上」不在这儿判:换不换得上只有装载器答得了(决策 47),路由照重扫之后
			// 那一行说 —— 与上传装包同一把尺子。
			docs: docsPresence(opened.pkg.docs),
			...(opened.pkg.skippedLocales.length > 0
				? { skippedLocales: opened.pkg.skippedLocales }
				: {}),
		});
	}

	return {
		async list(opts = {}) {
			return toView(await loadAll(opts.refresh === true));
		},
		install,
	};
}
