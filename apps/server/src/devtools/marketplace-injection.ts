import type { MarketplaceEntryDTO, MarketplaceResponse } from "@bilibili-notify/contract";
import { EXTENSION_API_RANGE } from "@bilibili-notify/internal";
import type { Marketplace } from "../extensions/marketplace.js";

/**
 * 拓展市场的注入装饰器 —— devtools 的「拓展有更新」。
 *
 * 包在真市场外面,交给 `/api/ext/marketplace*` 那两口的就是这一份;市场本体一行不动。
 * 注入着一个 id 时:
 *
 * - **列表**:那个 id 的一条改成 `updatable`,版本是**装着那份的下一个补丁号**
 *   ({@link bumpedVersion})—— 不是索引里写的那版:主人要看的是「比我装着的新一格」,
 *   而索引里那版可能比装着的还旧(开发版链进来的桥常常就是这样)。索引里压根没有这个 id
 *   (断网、或它不在任何索引里)就**现造一条官方的** —— 面板对官方源一键装,第三方要先过
 *   确认框,造成第三方的等于每按一次多弹一个框。
 * - **装**:那个 id 的一发**假装成功** —— 回一个与真装同形状的成功,不下载、不写盘、不重扫
 *   (盘上什么都没变,扫了也白扫);装成之后注入**自己撤掉**:现实里更新完那张卡就不再提示了。
 *   卡上印的版本号因此不会变 —— 盘上那份确实还是旧的,这是假更新唯一露馅的地方。
 * - 别的 id 原样过真市场。
 *
 * 「装着哪一版」**现取**(装载器那份名单):注入之后主人换了一版,下一次列表就按新的算。
 * 注入着的 id 没装(或装了又卸了)就不改列表 —— 没装的条目改成 `updatable` 只会让它从
 * 市场那一节消失(那一节滤掉可更新的,入口在已装卡片上),哪儿都看不到那颗钮。
 */
export interface InstalledExtension {
	id: string;
	/** 清单里的名字 —— 现造那条与假装成功的回话都印它。清单读不出来就没有。 */
	name?: string;
	version?: string;
}

export interface InjectableMarketplace {
	/** 交给路由的那份。 */
	marketplace: Marketplace;
	/**
	 * `downloadMs`:按「更新」之后先假装下载这么久再回成功 —— 面板那段换装一直「蓄」到装完,
	 * 一按就成的话蓄力根本看不见。
	 */
	inject(id: string, downloadMs?: number): void;
	clear(): void;
	/**
	 * 眼下注入着的那一个,以及它此刻的假新版(按装着那份现算)。`version` 缺 = 那个 id 现在
	 * 没装,注入挂着但不生效。没注入 → null。
	 */
	injected(): { id: string; version?: string } | null;
	/** 装载器名单里的那一个 —— 场景拿它挡「没装」。 */
	installed(id: string): InstalledExtension | undefined;
}

const PLAIN_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * 装着那一版的「下一版」。
 *
 * - `X.Y.Z` → `X.Y.(Z+1)`;
 * - 预发布(清单只收 semver,所以不是 `X.Y.Z` 就是 `X.Y.Z-<pre>`):最后一段是数就加一
 *   (`1.0.0-alpha.1` → `1.0.0-alpha.2`,下一个预发布就长这样),不是数就补一段 `.1`
 *   (`1.0.0-beta` → `1.0.0-beta.1`)—— 两种按 semver 都排在装着那版后面,仍是预发布;
 * - 版本号读不出来(清单坏了,卡上本来也不印版本)→ 当它是 `0.0.0`,给 `0.0.1`。
 */
export function bumpedVersion(version: string | undefined): string {
	if (version === undefined) return "0.0.1";
	const plain = PLAIN_SEMVER.exec(version);
	if (plain) return `${plain[1]}.${plain[2]}.${Number(plain[3]) + 1}`;
	const dash = version.indexOf("-");
	if (dash < 0) return `${version}.1`;
	const segments = version.slice(dash + 1).split(".");
	const last = segments[segments.length - 1] ?? "";
	if (/^\d+$/.test(last)) {
		segments[segments.length - 1] = String(Number(last) + 1);
		return `${version.slice(0, dash + 1)}${segments.join(".")}`;
	}
	return `${version}.1`;
}

/**
 * 同一个 id 可能好几个源都列着。改哪一条:
 * ① **装着那份的来源**那一条(真「有新版」只会出在它身上,别的源那条是 `installed-elsewhere`);
 * ② 没有(手放 / devtools 链进来的,全是 elsewhere)就挑官方那条;③ 再没有就第一条。
 */
function pickIndex(entries: readonly MarketplaceEntryDTO[], id: string): number {
	const fromHere = entries.findIndex(
		(one) =>
			one.id === id && one.installed?.source !== undefined && one.installed.source === one.source,
	);
	if (fromHere >= 0) return fromHere;
	const official = entries.findIndex((one) => one.id === id && one.official);
	if (official >= 0) return official;
	return entries.findIndex((one) => one.id === id);
}

export function injectableMarketplace(
	real: Marketplace,
	installed: () => readonly InstalledExtension[],
): InjectableMarketplace {
	let fake: string | null = null;
	let downloadMs = 0;

	const lookup = (id: string) => installed().find((one) => one.id === id);

	function decorate(view: MarketplaceResponse, id: string): MarketplaceResponse {
		const onDisk = lookup(id);
		if (!onDisk) return view;
		const version = bumpedVersion(onDisk.version);
		const prerelease = version.includes("-");
		const extensions = [...view.extensions];
		const at = pickIndex(extensions, id);
		const base = extensions[at];
		if (base) {
			extensions[at] = {
				...base,
				version,
				prerelease,
				state: "updatable",
				installed: { version: onDisk.version, source: base.source },
			};
		} else {
			extensions.push({
				source: "official",
				official: true,
				id,
				name: onDisk.name ?? id,
				description: "devtools 造的一条:索引里没有它,假装官方源里有新版",
				version,
				apiVersion: EXTENSION_API_RANGE.current,
				prerelease,
				notes: "devtools 造的假新版 —— 按「更新」会假装成功,盘上什么都不动。",
				size: 0,
				installed: { version: onDisk.version, source: "official" },
				state: "updatable",
			});
		}
		return { ...view, extensions };
	}

	const marketplace: Marketplace = {
		async list(opts) {
			const view = await real.list(opts);
			return fake === null ? view : decorate(view, fake);
		},
		async install(sourceId, id) {
			const onDisk = fake === id ? lookup(id) : undefined;
			// 没注入这个 id,或者它此刻没装(列表那边也就没改它)—— 原样交给真市场。
			if (!onDisk) return real.install(sourceId, id);
			fake = null;
			const wait = downloadMs;
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			return {
				ok: true,
				id,
				name: onDisk.name ?? id,
				version: bumpedVersion(onDisk.version),
				// 包是假的,哪来的说明。报「有」的话,「看看更新日志」会领人去读盘上那份旧的。
				docs: { readme: false, changelog: false },
			};
		},
	};

	return {
		marketplace,
		inject(id, ms = 0) {
			fake = id;
			downloadMs = ms;
		},
		clear() {
			fake = null;
		},
		injected() {
			if (fake === null) return null;
			const onDisk = lookup(fake);
			return onDisk ? { id: fake, version: bumpedVersion(onDisk.version) } : { id: fake };
		},
		installed: lookup,
	};
}
