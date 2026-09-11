import { createHash } from "node:crypto";
import type {
	MarketplaceEntryDTO,
	MarketplaceEntryState,
	MarketplaceResponse,
	MarketplaceSourceDTO,
} from "@bilibili-notify/contract";
import {
	checkMarketplaceIndex,
	EXTENSION_API_VERSION,
	isMarketplaceRevoked,
	type Logger,
	type MarketplaceEntry,
	type MarketplaceIndex,
	MarketplaceIndexSchema,
	type MarketplaceSource,
} from "@bilibili-notify/internal";
import { readJsonFile, writeJsonAtomic } from "../update/durable-json.js";
import { fetchSignedJson } from "../update/fetch-signed-manifest.js";
import { fetchThroughMirrors, mirrorChain } from "../update/fetch-through-mirrors.js";
import { compareVersions } from "../update/version-order.js";
import {
	installExtensionPackage,
	MAX_EXTENSION_PACKAGE_BYTES,
	openExtensionPackage,
} from "./install.js";

/**
 * 拓展市场(ADR-0013)。
 *
 * 一个内置的**官方源**(签名索引、走加速镜像、不能删)+ 主人自己加的**第三方源**(裸 JSON、
 * 不签、不走镜像)。每个源一份 `marketplace.json`,列它能装的拓展 —— 每个 id 只列最新那一版。
 * 装 = 下载 → 对索引里的 sha256(防的是下载途中被换包,不是防作者)→ 走面板上传装包那
 * **同一段**落地逻辑 → 记下「从哪个源装的哪一版」→ 让装载器重扫。
 *
 * 信任分两档:官方源多一道签名与新鲜度;第三方源谁控制了那个地址谁就能换内容 —— 这正是
 * 添加第三方源时要提示的风险,这里只保证「装到盘上的确实是索引说的那个包」。
 */

export const MARKETPLACE_OFFICIAL_SOURCE_ID = "official";
/** 住在装载根里的来源记录。它是系统状态不是用户配置,所以不进 globals。 */
export const MARKETPLACE_PROVENANCE_FILE = ".marketplace.json";

const DEFAULT_MAX_INDEX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_CACHE_MS = 5 * 60_000;

export interface MarketplaceOfficialSource {
	/** 官方索引的固定地址(`extension-marketplace` 那个滚动 release 上的 `marketplace.json`)。 */
	url: string;
	/** 内置信任列表 —— 与自主升级同一对公钥。 */
	trustedKeys: readonly string[];
}

export interface MarketplaceDeps {
	/** 装载根 —— `<dataDir>/extensions/`。 */
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
	/** 装完叫装载器再扫一遍盘。 */
	rescan: () => Promise<void>;
	logger: Logger;
	hostApiVersion?: number;
	timeoutMs?: number;
	downloadTimeoutMs?: number;
	maxIndexBytes?: number;
	/** 索引缓存多久;`list({ refresh: true })` 无视它。 */
	cacheMs?: number;
	now?: () => number;
}

export type MarketplaceInstallOutcome =
	| { ok: true; id: string; name: string; version: string; needsRestart: boolean }
	| { ok: false; err: string };

export interface Marketplace {
	list(opts?: { refresh?: boolean }): Promise<MarketplaceResponse>;
	install(sourceId: string, id: string): Promise<MarketplaceInstallOutcome>;
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
	view: MarketplaceSourceDTO;
	index?: MarketplaceIndex;
}

function readProvenance(root: string): Provenance {
	const raw = readJsonFile(root, MARKETPLACE_PROVENANCE_FILE) as Partial<Provenance> | undefined;
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

/** 字节数说成人话(一位小数的 MB)。 */
function mib(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

/** 索引拿不到 / 验不过时给主人看的那句 —— 四种原因四句话,别混成「连接出错」。 */
const OFFICIAL_FAILURE_TEXT = {
	unreachable: "拿不到官方索引:加速镜像与直连都没拿到",
	untrusted: "官方索引的签名验不过 —— 内容被改过,或不是我们签的",
	malformed: "官方索引读不出来(格式不对)",
	stale: "拿到的官方索引比上次见过的旧,不收 —— 加速站可能在回放旧的",
} as const;

export function createMarketplace(deps: MarketplaceDeps): Marketplace {
	const now = deps.now ?? (() => Date.now());
	const hostApiVersion = deps.hostApiVersion ?? EXTENSION_API_VERSION;
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
			schema: MarketplaceIndexSchema,
			issuedAtOf: (index) => index.issuedAt,
		});
		const base = { id: MARKETPLACE_OFFICIAL_SOURCE_ID, official: true };
		if (!fetched.ok) {
			return {
				view: { ...base, name: "官方源", ok: false, err: OFFICIAL_FAILURE_TEXT[fetched.reason] },
			};
		}
		const checked = checkMarketplaceIndex(fetched.value, { official: true });
		if (!checked.ok) {
			return {
				view: {
					...base,
					name: fetched.value.name,
					ok: false,
					err: `官方索引不合规矩:${checked.err}`,
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
				writeJsonAtomic(deps.root, MARKETPLACE_PROVENANCE_FILE, {
					...current,
					officialIssuedAt: issuedAt,
				});
			}
		}
		return { view: { ...base, name: fetched.value.name, ok: true }, index: fetched.value };
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
	type ThirdPartyFetch = { ok: true; index: MarketplaceIndex } | { ok: false; err: string };

	async function fetchThirdParty(source: MarketplaceSource): Promise<ThirdPartyFetch> {
		const fetched = await fetchThroughMirrors<MarketplaceIndex, string>({
			url: source.url,
			mirrors: [""],
			timeoutMs,
			maxBytes: maxIndexBytes,
			accept: (bytes) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
				} catch {
					return { ok: false, reason: "这个地址给的不是 JSON" };
				}
				const shaped = MarketplaceIndexSchema.safeParse(parsed);
				if (!shaped.success)
					return { ok: false, reason: "这份索引的形状不对(不是一份 marketplace.json)" };
				const checked = checkMarketplaceIndex(shaped.data, { official: false });
				if (!checked.ok) return { ok: false, reason: checked.err };
				return { ok: true, value: shaped.data };
			},
		});
		if (!fetched.ok) {
			return {
				ok: false,
				err: fetched.reason === "all-mirrors-failed" ? "拿不到这个源的索引" : fetched.reason,
			};
		}
		return { ok: true, index: fetched.value };
	}

	/**
	 * 命名空间仲裁 —— 拉到的那份配不配得上它声明的命名空间。**按配置顺序**一个个过,
	 * 先配的源占着的,后配的抢不走(理由见 {@link Provenance.namespaces})。
	 */
	function admitThirdParty(
		source: MarketplaceSource,
		fetched: ThirdPartyFetch,
		taken: Map<string, NamespaceHolder>,
	): LoadedSource {
		const base = { id: source.id, name: placeholderName(source), official: false, url: source.url };
		// 拉不到 / 不合规矩时索引里那个名字还没有,拿域名顶着 —— 别让错误行上写一个 uuid。
		if (!fetched.ok) return { view: { ...base, ok: false, err: fetched.err } };
		// 名字以索引自己报的为准 —— 用户加源时只填了地址。
		const named = { ...base, name: fetched.index.name };
		const ns = fetched.index.namespace as string;
		const holder = taken.get(ns);
		if (holder !== undefined && holder.sourceId !== source.id) {
			return {
				view: {
					...named,
					namespace: ns,
					ok: false,
					err: `命名空间「${ns}」已经被源「${holder.name}」用了`,
				},
			};
		}
		taken.set(ns, { sourceId: source.id, name: named.name });
		return { view: { ...named, namespace: ns, ok: true }, index: fetched.index };
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
		writeJsonAtomic(deps.root, MARKETPLACE_PROVENANCE_FILE, { ...current, namespaces: next });
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
	): { state: MarketplaceEntryState; installed?: MarketplaceEntryDTO["installed"] } {
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
			if (isMarketplaceRevoked(index, entry.id, record.version))
				return { state: "revoked", installed };
			// 「有新版」那颗钮画出来就得按得动:索引里那个新版自己装不了的两种情形
			// (它被撤回了、它要更高一格的宿主契约),install() 会当场拒 —— 别画出来
			// 让主人点一次再吃一句错。压回 installed:装着那版好好的。
			const newer = compareVersions(entry.version, record.version) > 0;
			const installable =
				!isMarketplaceRevoked(index, entry.id, entry.version) &&
				entry.apiVersion === hostApiVersion;
			return { state: newer && installable ? "updatable" : "installed", installed };
		}
		if (isMarketplaceRevoked(index, entry.id, entry.version)) return { state: "revoked" };
		if (entry.apiVersion !== hostApiVersion) return { state: "incompatible" };
		return { state: "installable" };
	}

	function toView(loaded: LoadedSource[]): MarketplaceResponse {
		const provenance = readProvenance(deps.root);
		// 装载器那份名单问一次就够:每条条目各问一遍等于把整张表扫成 O(条目 × 装着的)。
		const installedOnDisk = new Map(deps.installed().map((one) => [one.id, one]));
		const prerelease = deps.prerelease();
		const extensions: MarketplaceEntryDTO[] = [];
		for (const source of loaded) {
			if (!source.index) continue;
			for (const entry of source.index.extensions) {
				if (entry.prerelease && !prerelease) continue;
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
					prerelease: entry.prerelease === true,
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
			fetchedAt: cache?.at ?? now(),
		};
	}

	async function install(sourceId: string, id: string): Promise<MarketplaceInstallOutcome> {
		const loaded = await loadAll(false);
		const source = loaded.find((candidate) => candidate.view.id === sourceId);
		if (!source) return { ok: false, err: `没有这个源:${sourceId}` };
		if (!source.index)
			return {
				ok: false,
				err: `源「${source.view.name}」现在不可用:${source.view.err ?? "索引没拿到"}`,
			};
		const entry = source.index.extensions.find((candidate) => candidate.id === id);
		if (!entry) return { ok: false, err: `源「${source.view.name}」里没有 ${id}` };
		if (entry.apiVersion !== hostApiVersion) {
			return {
				ok: false,
				err: `${entry.name} 要宿主契约 v${entry.apiVersion},这一版 BN 是 v${hostApiVersion} —— 先升级 BN`,
			};
		}
		if (isMarketplaceRevoked(source.index, entry.id, entry.version)) {
			return { ok: false, err: `${entry.name} ${entry.version} 已被这个源撤回` };
		}
		// 索引自己写了包有多大,那就是这一次的上限 —— 拿 10MB 硬顶当上限等于允许对面
		// 灌到 10MB 才停,而我们本来就知道该收多少。超过本机上限的得说清是上限:
		// 报「下不下来」会把主人支去查网络。
		if (entry.package.size > MAX_EXTENSION_PACKAGE_BYTES) {
			return {
				ok: false,
				err: `索引写的 ${entry.name} 包有 ${mib(entry.package.size)} MB,超过本机上限 ${mib(MAX_EXTENSION_PACKAGE_BYTES)} MB`,
			};
		}

		const downloaded = await fetchThroughMirrors<Uint8Array, "checksum">({
			url: entry.package.url,
			// 只有官方源的包在 GitHub 上,加速前缀才拼得出东西。
			mirrors: source.view.official ? mirrorChain(deps.mirrors()) : [""],
			timeoutMs: downloadTimeoutMs,
			maxBytes: Math.min(entry.package.size, MAX_EXTENSION_PACKAGE_BYTES),
			accept: (bytes) =>
				bytes.byteLength === entry.package.size && sha256Hex(bytes) === entry.package.sha256
					? { ok: true, value: bytes }
					: { ok: false, reason: "checksum" },
		});
		if (!downloaded.ok) {
			return {
				ok: false,
				err:
					downloaded.reason === "checksum"
						? `下载到的包校验和与索引写的对不上 —— 中途被换过,或源那头发错了包`
						: `下不下来 ${entry.name} 的包(${entry.package.url})`,
			};
		}

		const opened = openExtensionPackage(downloaded.value);
		if (!opened.ok) return { ok: false, err: `包拆不开:${opened.errors.join(";")}` };
		if (opened.pkg.id !== entry.id || opened.pkg.manifest.version !== entry.version) {
			return {
				ok: false,
				err: `包里的清单是 ${opened.pkg.id}@${opened.pkg.manifest.version},索引说的是 ${entry.id}@${entry.version} —— 源那头发错了包`,
			};
		}
		let replaced: boolean;
		try {
			({ replaced } = await installExtensionPackage({ root: deps.root, pkg: opened.pkg }));
		} catch (err) {
			return { ok: false, err: (err as Error).message };
		}
		const provenance = readProvenance(deps.root);
		provenance.installed[entry.id] = {
			source: source.view.id,
			version: entry.version,
			installedAt: now(),
		};
		writeJsonAtomic(deps.root, MARKETPLACE_PROVENANCE_FILE, provenance);
		deps.logger.info(
			`marketplace: installed ${entry.id}@${entry.version} from ${source.view.name}`,
		);
		await deps.rescan();
		return {
			ok: true,
			id: entry.id,
			name: opened.pkg.manifest.name,
			version: entry.version,
			needsRestart: replaced,
		};
	}

	return {
		async list(opts = {}) {
			return toView(await loadAll(opts.refresh === true));
		},
		install,
	};
}
