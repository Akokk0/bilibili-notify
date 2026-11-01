import type {
	ExtensionDTO,
	ExtensionInstallResponse,
	ExtensionsResponse,
	MarketplaceResponse,
	ReportDiscrepancyView,
	RestartAbility,
} from "@bilibili-notify/contract";
import {
	ActionNameSchema,
	ExtensionIdSchema,
	fail,
	isExtensionEnabled,
	manifestProvides,
	ok,
	RESERVED_EXTENSION_IDS,
} from "@bilibili-notify/internal";
import { Hono } from "hono";
import { type ZodType, z } from "zod";
import type { ConfigStore } from "../config/store.js";
import { ExtensionConflictError } from "../extensions/conflict-error.js";
import type { ActionOutcome } from "../extensions/context.js";
import { readExtensionDocs } from "../extensions/docs.js";
import {
	docsPresence,
	installExtensionPackage,
	MAX_EXTENSION_PACKAGE_BYTES,
	openExtensionPackage,
	uninstallExtension,
} from "../extensions/install.js";
import { type ExtensionEntry, entryIdentity } from "../extensions/loader.js";
import type { LocaleIssue } from "../extensions/locales.js";
import type { Marketplace } from "../extensions/marketplace.js";
import type { ReportDiscrepancyTable } from "../extensions/report-discrepancies.js";
import { t } from "../i18n/index.js";
import type { IntegrationStore } from "../integration-store/store.js";
import { cannotRestart } from "../runtime/restart-ability.js";
import { createExtensionSettingsRoute } from "./extension-settings.js";
import { respondFailure } from "./respond-failure.js";
import { uploadBodyLimit } from "./upload-limit.js";

const MarketplaceInstallRequestSchema = z.object({
	source: z.string().min(1),
	id: z.string().min(1),
});

export interface ExtensionsRouteOptions {
	store: ConfigStore;
	/**
	 * 开机那一趟扫出来 + 加载出来的结果。**现取**,理由同上。
	 *
	 * 没有写死的清单了 —— 拓展是**装进来的**,盘上有什么就是什么(ADR-0012)。
	 */
	extensions: () => readonly ExtensionEntry[];
	/** 某个拓展交上来的面板数据。没跑 / 没交过就是 `undefined`。**现取,不缓存。** */
	status: (id: string) => unknown;
	/**
	 * 跑某个拓展的一个动作(ADR-0019 决策 22)。拓展没在跑就是 `undefined`(→ `not_found`)。没接这
	 * 一格的话那一口永远 `not_found`。
	 */
	runAction?: (id: string, name: string) => Promise<ActionOutcome | undefined>;
	/**
	 * **只重载这个拓展**(装载器的 `swap()`,ADR-0012 决策 47):它没标着「新版等着换上」时
	 * 抛 {@link ExtensionConflictError},那句话原样交给面板(→ `conflict`)。别的抛错是 bug,交给全局
	 * 出错处理。没接这一格的话那一口永远 `not_found`。
	 */
	swap?: (id: string) => Promise<void>;
	/**
	 * 订阅源拓展的「上报出入」记录(ADR-0019 决策 60)。列表那一行照它带上 `reportDiscrepancies`,卸载时清掉
	 * 它那一段。不给就是没接上:哪一行都不带这一格。
	 */
	reportDiscrepancies?: Pick<ReportDiscrepancyTable, "list" | "clear">;
	/**
	 * 某个拓展经 `ctx.settings(schema)` 交过的 zod —— 写它的设置时再过一道(ADR-0019 决策 35)。
	 * 没在跑是 `undefined`。不给这一格 = 只有清单那一道。
	 */
	settingsSchemas?: (id: string) => readonly ZodType[] | undefined;
	/** 某个拓展的设置经 `/:id/settings` 写进去了 —— 宿主转成一帧推给面板。 */
	settingsChanged?: (id: string) => void;
	/**
	 * 把**还没落地的开关**落实掉(装载器的 `sync()`)。给了就在列清单之前 await 一下。
	 *
	 * 🔴 热装卸是异步的,而 `PATCH /api/settings` 在它落地之前就回 200 了 —— 面板紧接着
	 * 刷这一口,拿到的会是**上一秒**的状态。启用那一路尤其明显:第一次 `import()` 一个
	 * 文件是真 I/O。症状是「开关明明拨上去了,状态还写着已停用」,而且不会自己好。
	 */
	settle?: () => Promise<void>;
	/**
	 * 拓展市场(ADR-0013):列索引、按源装。逻辑在 `extensions/marketplace.ts`,这里只做 wire。
	 * 省略 → 两口都是 `unsupported`(没接市场的构建)。
	 */
	marketplace?: Marketplace;
	/**
	 * 面板上传装拓展要的三样。闸与拆包在 `extensions/install.ts`,这里只做 wire。
	 *
	 * 省略 → `POST /install` 回 `unsupported`(装载器没接上来的构建里,装了也没人加载)。
	 */
	install?: {
		/** 装载根 —— `<数据根>/extensions/`。 */
		root: string;
		/** 卸载时连它存的 state / secrets 一起清(两个目录)。 */
		integrationStore: Pick<IntegrationStore, "remove">;
		/**
		 * **在装载器那条队里改盘**(装载器的 `changeDisk()`):`write` 落盘 / 抹盘,紧跟着再扫一遍。
		 *
		 * 🔴 两件事都不能少:队外写的话,并发的开关 / 重扫 / 只重载会看见写了一半的目录
		 * (ADR-0019 决策 45);写完不扫的话,新装的拓展要等下一次开机才出现在这一页 —— 而那正是
		 * 「装了个拓展,面板叫我重启,可我没处按」的由来。
		 */
		changeDisk: <T>(write: () => Promise<T>) => Promise<T>;
		/** 真要重启时,这台机器上按下去回不回得来(ADR-0005 决策 22)。每次现问:拉不起来时那句话按此刻的语言取。 */
		restartAbility: () => RestartAbility;
	};
}

/**
 * 盖掉 / 装完之后,装载器那一行是不是「新版等着换上」(ADR-0012 决策 47)。
 *
 * 🔴 **照重扫之后装载器那一行说,不照「盖掉了一份」说**:关着、从没跑过的那份盘上换了就是
 * 换了,原样再传一遍的也没什么可换 —— 那两种照旧说「要重启」,主人会白白重启一次。换不换得上
 * 只有按指纹认代码的装载器答得了,而它把答案挂在那一行的 `staged` 上 —— 关着、但这个进程跑过
 * 它别的代码的那份也挂。上传装包与市场装两口共用这一句,免得两边各判各的。
 */
function stagedAfterInstall(entries: readonly ExtensionEntry[], id: string): boolean {
	return entries.find((entry) => entry.id === id)?.staged !== undefined;
}

/** 列表那一行的「上报出入」(决策 60):没有就不带这一格;拓展 id 不下发(它就挂在那一行上)。 */
function reportDiscrepanciesOf(
	id: string,
	log: Pick<ReportDiscrepancyTable, "list"> | undefined,
): { reportDiscrepancies?: ReportDiscrepancyView[] } {
	const discrepancies = log?.list(id) ?? [];
	if (discrepancies.length === 0) return {};
	return {
		reportDiscrepancies: discrepancies.map(({ extensionId: _id, ...discrepancy }) => ({
			...discrepancy,
			subscriptionIds: [...discrepancy.subscriptionIds],
			reasons: [...discrepancy.reasons],
		})),
	};
}

/**
 * 一条译文问题的话,按**此刻**的当前语言取(ADR-0037 决策 1:出字那一刻读)。码有八种,各一句 ——
 * 键必须是字面量(取字调用的守卫钉着),所以逐码写开,不拼键名。
 */
function localeIssueText(issue: LocaleIssue): string {
	// 取字的值必须是对象字面量、参数名与译文的占位符一一对上(守卫钉着),所以用简写逐句传。
	const { locale } = issue;
	const path = issue.path.join(".");
	switch (issue.code) {
		case "invalid-json":
			return t("extension.localeIssue.invalidJson", { locale });
		case "too-large":
			return t("extension.localeIssue.tooLarge", { locale });
		case "invalid-key":
			return t("extension.localeIssue.invalidKey", { locale, path });
		case "invalid-text":
			return t("extension.localeIssue.invalidText", { locale, path });
		case "malformed-placeholder":
			return t("extension.localeIssue.malformedPlaceholder", { locale, path });
		case "unknown-entry":
			return t("extension.localeIssue.unknownEntry", { locale, path });
		case "untranslatable-entry":
			return t("extension.localeIssue.untranslatableEntry", { locale, path });
		case "too-long":
			return t("extension.localeIssue.tooLong", { locale, path });
	}
}

/**
 * 拓展页要的两样东西:装了哪些拓展(以及开没开),和某个拓展自己交上来的那份面板数据。
 *
 * 🔴 **状态走 `/api/*` 而不是 `/ext/<id>/*`**(ADR-0012 决策 36):后者**刻意**在鉴权外
 * (对家手里只有 URL、没有会话),把面板数据挂那儿等于把会话列表与 bot 名单公开出去。
 *
 * 开关本身不在这儿改 —— 它住 `globals.extensions`,走 `PATCH /api/settings`,与别的全局
 * 设置同一条路。拓展自己的设置有自己的读写口(`/:id/settings`,见 `extension-settings.ts`)。
 */
export function createExtensionsRoute(opts: ExtensionsRouteOptions): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		await opts.settle?.();
		const globals = opts.store.getGlobals();
		const extensions: ExtensionDTO[] = opts.extensions().map((entry) => {
			// 版本不合的只有身份那几格(那一档的格式可能不认识),名字与版本照样印得出来。
			const identity = entryIdentity(entry);
			return {
				id: entry.id,
				// 清单读不出来时退回目录名 —— 卡片总得印点什么,而目录名正是那时唯一的身份。
				name: identity?.name ?? entry.id,
				description: identity?.description,
				version: identity?.version,
				provides: entry.manifest && manifestProvides(entry.manifest),
				apiVersion: entry.manifest?.apiVersion,
				// 推送源那一口照清单给、没在跑的也有(ADR-0019 决策 41):拓展停了,它借来的连接在推送目标页
				// 照样画得出短名与标识色。要拓展在场的(能挑的 bot、视图)不在这儿,照旧跟着「在跑」。
				// 订阅源那一口的外观在来源表(`/api/sources`)里,同样照清单给。
				// 清单里声明的设置项 —— 来自清单、不来自代码,所以没在跑的也有。
				...(entry.manifest?.settings ? { settings: entry.manifest.settings } : {}),
				icon: identity?.icon,
				// 它在盘上的哪儿。软链进来的(开发版就是)再带上落点 —— 「跑的到底是哪一份」
				// 只有那一句答得了。
				dir: entry.dir,
				...(entry.linkedTo === undefined ? {} : { linkedTo: entry.linkedTo }),
				// 开关与状态是**两件事**:开着却没跑(连败停用 / 清单坏了)正是最该看见的一格。
				enabled: isExtensionEnabled(globals, entry.id),
				state: entry.state,
				detail: entry.detail,
				// 盘上有一份这个进程干净地换不上的新代码 —— 详情页据此并排给「重启 BN」与「只重载」。
				...(entry.staged === undefined ? {} : { staged: entry.staged }),
				// 上报出入(决策 60):有才带,详情页凭它判「有问题才出现」那个框。
				...reportDiscrepanciesOf(entry.id, opts.reportDiscrepancies),
				// 译文问题(决策 14):句子此刻按当前语言取好,面板原样印;没有问题就没有这一格。
				...(entry.localeIssues === undefined
					? {}
					: { localeIssues: entry.localeIssues.map(localeIssueText) }),
			};
		});
		const body: ExtensionsResponse = {
			extensions,
			// 没接装载器的构建一个拓展都列不出来,这一格其实没人读;答「拉不起来」是**不会坑人**的那一边 ——
			// 反过来答「能」,哪天有人读了,按下去就是把 BN 关了而没人拉(ADR-0005 决策 22)。
			restart: opts.install?.restartAbility() ?? cannotRestart("unsupervised"),
			// 手放拓展的去处:装载器读的那一个根。面板猜不出在用的是哪一代。
			...(opts.install ? { root: opts.install.root } : {}),
		};
		return c.json(body);
	});

	/**
	 * 传一个 zip 上来装拓展。
	 *
	 * 三条各自的理由:
	 * - **闸在 `parseBody()` 之前**(同皮肤那条):整个 multipart 实体化进堆之后再拦,拦到的
	 *   不是那句「过大」而是一次 OOM —— 进程被杀、面板断线重连,该收到的提示永远不来。
	 * - **拆包那几句原样交出去**(一句是 `message`,不止一句则 `message` 概括、`issues` 逐条):它们是
	 *   主人手里那个包**哪里不对**的唯一线索。
	 * - **装完当场重扫**,于是新拓展立刻出现在这一页;而**盖掉一份跑过的**要如实说「新版等着
	 *   换上」—— 那份代码已经 import 过,ESM 在这个进程里干净地换不掉(决策 10 / 47)。
	 */
	// 上传超限那句里的「拓展包」在建路由那一刻取字:`uploadBodyLimit` 只收字符串,改成出字时才取随 4-53c(同卡片路由的
	// 「图片」「字体文件」)。
	app.post(
		"/install",
		uploadBodyLimit(MAX_EXTENSION_PACKAGE_BYTES, t("extensions.route.packageNoun")),
		async (c) => {
			const install = opts.install;
			if (!install)
				return respondFailure(c, fail("unsupported", t("extensions.route.noLoaderInstall")));
			const body = await c.req.parseBody().catch(() => null);
			const file = body?.file;
			if (!(file instanceof File)) {
				return respondFailure(c, fail("invalid", t("extensions.route.missingPackageFile")));
			}
			const opened = openExtensionPackage(new Uint8Array(await file.arrayBuffer()));
			if (!opened.ok) return respondFailure(c, opened);

			// 落盘与随后那一遍重扫在装载器的队里是一件事。新装的当场跑起来;盖掉一份跑着的,旧代码
			// 照跑、那一行标上「等着换上」(装载器不偷偷换跑着的代码,决策 47)。
			try {
				await install.changeDisk(() =>
					installExtensionPackage({ root: install.root, pkg: opened.pkg }),
				);
			} catch (err) {
				// 落盘那头**可预期**的拒绝只有一种:目标是 devtools 链进来的工作树。那句话要原样给主人。
				// 别的抛错(磁盘写失败)是 bug 或环境的事,往外抛给全局出错处理。
				if (err instanceof ExtensionConflictError) return respondFailure(c, err.toFailure());
				throw err;
			}

			const answer: ExtensionInstallResponse = {
				id: opened.pkg.id,
				name: opened.pkg.manifest.name,
				version: opened.pkg.manifest.version,
				staged: stagedAfterInstall(opts.extensions(), opened.pkg.id),
				docs: docsPresence(opened.pkg.docs),
				// 语言表之外的译文文件没写进盘,告知一声;没有就不带这一格。
				...(opened.pkg.skippedLocales.length > 0
					? { skippedLocales: opened.pkg.skippedLocales }
					: {}),
				// 装这个动作不碰开关 —— 头一回装进来的就是关着的,照实报给面板。
				enabled: isExtensionEnabled(opts.store.getGlobals(), opened.pkg.id),
				restart: install.restartAbility(),
			};
			return c.json(answer);
		},
	);

	/**
	 * 卸掉一个拓展:抹掉盘上那份(连同重扫)+ **清掉配置里那一格**。不必重启。
	 *
	 * 🔴 **配置必须跟着清**。装载器注释写着:盘上没了而它那一格还留着的话,下一次
	 * `sync()` 会把它从 ESM 模块缓存里装回来。而且桥的接入里躺着长期 token,那是凭据,
	 * 删了拓展还留着说不过去 —— 代价是重装之后接入要重建,koishi 那侧也得重填一遍。
	 *
	 * 🔴 **还有连接指着它就不删**。推送目标是用户亲手配的:连带删掉太狠,留着悬空则让
	 * 推送静默失败。拦住并说清还有几条,由用户自己去推送目标页处置。
	 *
	 * 顺序是「先抹盘(连同重扫,在装载器的队里是一件事)、再清配置」:抹盘是唯一会被拒的一步
	 * (软链),放在最前面才能保证「被拒 = 什么都没动」。之后那一瞬「格子没了但配置还在」不碰得着
	 * —— 清配置触发的那次 `sync()` 已经找不到它的格子了。
	 */
	app.delete("/:id", async (c) => {
		const install = opts.install;
		if (!install)
			return respondFailure(c, fail("unsupported", t("extensions.route.noLoaderUninstall")));

		// 目录名正好是保留名字的那一种:它过不了 id 校验、装载不了,面板上是一张「读不了」的卡,也得删得掉。
		// **只抹拓展目录下那一个文件夹**。保留名字同时是内置集成与核心自己的键:往下那几步按 id 找到的是本体的东西
		// (内置适配器的连接、B 站存着的登录凭据),一步都不走 —— 一个从没跑起来过的拓展本来也没有那些。
		const reserved = RESERVED_EXTENSION_IDS.find((name) => name === c.req.param("id"));
		if (reserved !== undefined) {
			const removed = await install.changeDisk(() =>
				uninstallExtension({ root: install.root, id: reserved }),
			);
			if (!removed.ok) return respondFailure(c, removed);
			return c.json(ok());
		}

		const parsed = ExtensionIdSchema.safeParse(c.req.param("id"));
		if (!parsed.success) return respondFailure(c, fail("invalid", t("extensions.route.badId")));
		const id = parsed.data;

		const inUse = opts.store
			.getConnections()
			// 拓展 id 进不了保留 id(内置三个适配器的键),这一条不会误伤内置连接。
			.filter((conn) => conn.adapterKey === id);
		if (inUse.length > 0) {
			return respondFailure(
				c,
				fail("conflict", t("extensions.route.connectionsInUse", { count: inUse.length })),
			);
		}

		// 抹盘在前:它是**唯一会被拒**的一步(软链)。反过来先清配置的话,被拒的那条路上
		// 配置已经没了而拓展还在盘上跑着 —— 界面与实际当场对不上。
		const removed = await install.changeDisk(() => uninstallExtension({ root: install.root, id }));
		if (!removed.ok) return respondFailure(c, removed);
		// 它那一段上报出入跟着清(决策 60):装回来的是一个新的它,旧账不该挂在新页上。抹盘时它已经
		// 收摊,不会再有新的一条补进来。
		opts.reportDiscrepancies?.clear(id);

		// 开关那一格与它的设置文件一起删(设置不住 globals 了,见 `ConfigStore.removeExtension`)。
		await opts.store.removeExtension(id);

		// 它存的状态与密钥也清掉:抹盘那一步之前拓展已经收摊(把手已关),所以「还开着就拒」不会误伤。
		// 清不掉不回滚前面几步 —— 拓展确实卸了;装回来再卸一次会重试。
		const cleared = await install.integrationStore.remove(id);
		if (!cleared.ok) {
			return respondFailure(
				c,
				fail(cleared.code, t("extensions.route.stateNotCleared", { reason: cleared.message })),
			);
		}
		return c.json(ok());
	});

	// 市场那两口要排在 `/:id/*` 前面 —— 路由按注册顺序匹配。
	app.get("/marketplace", async (c) => {
		const marketplace = opts.marketplace;
		if (!marketplace)
			return respondFailure(c, fail("unsupported", t("extensions.route.noMarketplace")));
		const refresh = c.req.query("refresh") === "1";
		const body: MarketplaceResponse = await marketplace.list({ refresh });
		return c.json(body);
	});

	/** 装完的回答与上传装包**同一个形状**:面板复用同一段「装完那句话」与重启按钮。 */
	app.post("/marketplace/install", async (c) => {
		const marketplace = opts.marketplace;
		const install = opts.install;
		if (!marketplace || !install) {
			return respondFailure(c, fail("unsupported", t("extensions.route.noMarketplaceInstall")));
		}
		const parsed = MarketplaceInstallRequestSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success)
			return respondFailure(c, fail("invalid", t("extensions.route.marketplaceInstallBody")));
		const outcome = await marketplace.install(parsed.data.source, parsed.data.id);
		if (!outcome.ok) return respondFailure(c, outcome);
		const answer: ExtensionInstallResponse = {
			id: outcome.id,
			name: outcome.name,
			version: outcome.version,
			// 市场装完已经重扫过了 —— 与上传装包同一把尺子。
			staged: stagedAfterInstall(opts.extensions(), outcome.id),
			docs: outcome.docs,
			...(outcome.skippedLocales === undefined ? {} : { skippedLocales: outcome.skippedLocales }),
			// 同上传装包那口:装不碰开关,照实报。
			enabled: isExtensionEnabled(opts.store.getGlobals(), outcome.id),
			restart: install.restartAbility(),
		};
		return c.json(answer);
	});

	/**
	 * 拓展自己带的 README / CHANGELOG。
	 *
	 * 🔴 **读磁盘,不读活着的实例** —— 与隔壁 `/:id/status` 正相反。关着的、加载失败的
	 * 拓展照样交得出说明,而那正是人最想读它的时候。所以这条不碰 `opts.extensions()`。
	 */
	app.get("/:id/docs", async (c) => {
		const install = opts.install;
		if (!install) {
			return respondFailure(c, fail("unsupported", t("extensions.route.noLoaderDocs")));
		}
		const parsed = ExtensionIdSchema.safeParse(c.req.param("id"));
		if (!parsed.success) return respondFailure(c, fail("invalid", t("extensions.route.badId")));
		const docs = await readExtensionDocs({ root: install.root, id: parsed.data });
		// 没装 → not_found;装了但两份都没写 → 200 加两个空格子,面板据此整块不画。
		if (!docs)
			return respondFailure(
				c,
				fail("not_found", t("extensions.route.notInstalled", { id: parsed.data })),
			);
		return c.json(docs);
	});

	/**
	 * 面板上的「调拓展」按钮。🔴 **只在 `/api/*` 底下**,吃面板会话鉴权 —— 绝不挂到
	 * `/ext/<id>`(那里刻意在鉴权外,ADR-0012 决策 36 / 38):否则任何够得着 BN 的人都能替主人
	 * 按这些钮(比如发起一次扫码登录,用自己的手机扫)。每种失败各有码与原话:话在
	 * `extensions/context.ts` 的 `runAction` 里造(那儿才知道动作名与实际等了多久),这里原样交出去。
	 */
	app.post("/:id/actions/:name", async (c) => {
		const id = ExtensionIdSchema.safeParse(c.req.param("id"));
		const name = ActionNameSchema.safeParse(c.req.param("name"));
		if (!id.success || !name.success) {
			return respondFailure(c, fail("invalid", t("extensions.route.badActionRef")));
		}
		const outcome: ActionOutcome | undefined = await opts.runAction?.(id.data, name.data);
		if (!outcome)
			return respondFailure(
				c,
				fail("not_found", t("extensions.route.notRunning", { id: id.data })),
			);
		// 同一个动作的上一发还没回来是 `conflict`(决策 42:不排队、不并发),面板据此说「还在跑」,
		// 不当成失败。
		if (!outcome.ok) return respondFailure(c, outcome);
		return c.json(ok());
	});

	/**
	 * **只重载这个拓展**(ADR-0012 决策 47):收摊 → 按指纹换一个 URL 重新 `import` → 重新
	 * `activate`。别的推送与直播监听都不断;代价是旧模块留在内存里,等下次重启 BN 才还回来。
	 *
	 * 🔴 **只在它标着「新版等着换上」时给按** —— 那道闸在装载器里(没有新代码时白漏一份模块),
	 * 这里只把它那句为什么原样交出去(409),不自编一句「重载失败」。换上去之后 `activate` 炸了
	 * 不算这一口失败:那一行成了「加载失败」,原因在列表里。
	 */
	app.post("/:id/swap", async (c) => {
		const parsed = ExtensionIdSchema.safeParse(c.req.param("id"));
		if (!parsed.success) return respondFailure(c, fail("invalid", t("extensions.route.badId")));
		const id = parsed.data;
		if (!opts.swap || !opts.extensions().some((entry) => entry.id === id)) {
			return respondFailure(c, fail("not_found", t("extensions.route.notInstalled", { id })));
		}
		try {
			await opts.swap(id);
		} catch (err) {
			// 装载器拒绝(没有等着换上的新代码 / 开关关着)是可预期的,那句话原样给主人;别的抛错是
			// 换代码时的 bug,往外抛给全局出错处理 —— 不能把它也伪装成一个 409。
			if (err instanceof ExtensionConflictError) return respondFailure(c, err.toFailure());
			throw err;
		}
		return c.json(ok());
	});

	// 设置自己的读写口(ADR-0019 决策 35)。wire 在 `extension-settings.ts`,逻辑在
	// `extensions/settings-io.ts`。
	app.route(
		"/",
		createExtensionSettingsRoute({
			store: opts.store,
			extensions: opts.extensions,
			settingsSchemas: opts.settingsSchemas,
			settingsChanged: opts.settingsChanged,
		}),
	);

	/**
	 * 一个拓展交给面板的视图(`ctx.publishView`),**现取**。没跑 /
	 * 没交过就是 404,不是空对象:那两件事面板要能分开说。
	 *
	 * 交的先过宿主那一道(`extensions/view-check.ts`,ADR-0019 决策 40):**按块 / 按项降级** ——
	 * 坏块换成一条点名「哪儿、为什么」的提示,坏项那张卡写「状态未知」,摘要坏了不下发;交回
	 * Promise 的也是一条提示。都照样 200(`ExtensionPanelView`),同一句只记一行日志。
	 */
	app.get("/:id/status", (c) => {
		const status = opts.status(c.req.param("id"));
		if (status === undefined) {
			return respondFailure(
				c,
				fail("not_found", t("extensions.route.noStatus", { id: c.req.param("id") })),
			);
		}
		return c.json(status);
	});

	return app;
}
