import type {
	ExtensionBotsResponse,
	ExtensionBotView,
	ExtensionConfigField,
	ExtensionDescriptorDTO,
	ExtensionDTO,
	ExtensionInstallResponse,
	MarketplaceResponse,
	RestartAbility,
} from "@bilibili-notify/contract";
import { isExtensionEnabled } from "@bilibili-notify/internal";
import { Hono } from "hono";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";
import {
	installExtensionPackage,
	MAX_EXTENSION_PACKAGE_BYTES,
	openExtensionPackage,
} from "../extensions/install.js";
import type { ExtensionEntry } from "../extensions/loader.js";
import type { Marketplace } from "../extensions/marketplace.js";
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
	 * 某个拓展注册推送源时报的面板元信息(短名 / 标识色 / 目标形态)。没跑就是 `undefined`。
	 *
	 * 🔴 **这是那份元信息唯一的出处**:不下发的话面板只能自己手抄一份短名与颜色,而手抄
	 * 的副本迟早跟拓展报的漂开 —— 那种漂移门禁一片绿,只有真机上眼睛能看出来。
	 */
	descriptor: (id: string) => ExtensionDescriptorDTO | undefined;
	/** 它注册推送源时交的字段表(决策 33)—— 推送目标页照它画「新建连接」。没跑就是 `undefined`。 */
	configFields: (id: string) => readonly ExtensionConfigField[] | undefined;
	/** 现在能借来当连接的 bot(决策 45)。没跑 / 它没给就是 `undefined`(→ 404,与空名单分开)。 */
	bots: (id: string) => readonly ExtensionBotView[] | undefined;
	/**
	 * 把**还没落地的开关**落实掉(装载器的 `sync()`)。给了就在列清单之前 await 一下。
	 *
	 * 🔴 热装卸是异步的,而 `PATCH /api/globals` 在它落地之前就回 200 了 —— 面板紧接着
	 * 刷这一口,拿到的会是**上一秒**的状态。启用那一路尤其明显:第一次 `import()` 一个
	 * 文件是真 I/O。症状是「开关明明拨上去了,状态还写着已停用」,而且不会自己好。
	 */
	settle?: () => Promise<void>;
	/**
	 * 拓展市场(ADR-0013):列索引、按源装。逻辑在 `extensions/marketplace.ts`,这里只做 wire。
	 * 省略 → 两口都 404(没接市场的构建)。
	 */
	marketplace?: Marketplace;
	/**
	 * 面板上传装拓展要的三样。闸与拆包在 `extensions/install.ts`,这里只做 wire。
	 *
	 * 省略 → `POST /install` 回 404(装载器没接上来的构建里,装了也没人加载)。
	 */
	install?: {
		/** 装载根 —— `<dataDir>/extensions/`。 */
		root: string;
		/**
		 * 装完叫装载器再扫一遍盘。
		 *
		 * 🔴 少这一下,新装的拓展要等下一次开机才出现在这一页 —— 而那正是「装了个拓展,
		 * 面板叫我重启,可我没处按」的由来。
		 */
		rescan: () => Promise<void>;
		/** 真要重启时,这台机器上按下去回不回得来(ADR-0005 决策 22)。 */
		restartAbility: RestartAbility;
	};
}

/**
 * 拓展页要的两样东西:装了哪些拓展(以及开没开),和某个拓展自己交上来的那份面板数据。
 *
 * 🔴 **状态走 `/api/*` 而不是 `/ext/<id>/*`**(ADR-0012 决策 36):后者**刻意**在鉴权外
 * (对家手里只有 URL、没有会话),把面板数据挂那儿等于把会话列表与 bot 名单公开出去。
 *
 * 开关本身不在这儿改 —— 它住 `globals.extensions`,走 `PATCH /api/globals`,与别的全局
 * 设置同一条路。这里只读。
 */
export function createExtensionsRoute(opts: ExtensionsRouteOptions): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		await opts.settle?.();
		const globals = opts.store.getGlobals();
		const extensions: ExtensionDTO[] = opts.extensions().map((entry) => ({
			id: entry.id,
			// 清单读不出来时退回目录名 —— 卡片总得印点什么,而目录名正是那时唯一的身份。
			name: entry.manifest?.name ?? entry.id,
			description: entry.manifest?.description,
			version: entry.manifest?.version,
			provides: entry.manifest?.provides,
			// 跑起来了才有:它是 `activate` 里注册推送源时交的那一份。
			descriptor: opts.descriptor(entry.id),
			configFields: opts.configFields(entry.id),
			icon: entry.manifest?.icon,
			// 它在盘上的哪儿。软链进来的(开发版就是)再带上落点 —— 「跑的到底是哪一份」
			// 只有那一句答得了。
			dir: entry.dir,
			...(entry.linkedTo === undefined ? {} : { linkedTo: entry.linkedTo }),
			// 开关与状态是**两件事**:开着却没跑(连败停用 / 清单坏了)正是最该看见的一格。
			enabled: isExtensionEnabled(globals, entry.id),
			state: entry.state,
			detail: entry.detail,
		}));
		return c.json({ extensions });
	});

	/**
	 * 传一个 zip 上来装拓展。
	 *
	 * 三条各自的理由:
	 * - **闸在 `parseBody()` 之前**(同皮肤那条):整个 multipart 实体化进堆之后再拦,拦到的
	 *   不是那句「过大」而是一次 OOM —— 进程被杀、面板断线重连,该收到的提示永远不来。
	 * - **拆包那几句原样交出去**:它们是主人手里那个包**哪里不对**的唯一线索。
	 * - **装完当场重扫**,于是新拓展立刻出现在这一页;而**盖掉一份已经装着的**要如实说
	 *   「得重启一次」—— 那份代码已经 import 过,ESM 在这个进程里换不掉(决策 10)。
	 */
	app.post("/install", uploadBodyLimit(MAX_EXTENSION_PACKAGE_BYTES, "拓展包"), async (c) => {
		const install = opts.install;
		if (!install) return c.json({ errors: ["这个构建没接装载器,装不了"] }, 404);
		const body = await c.req.parseBody().catch(() => null);
		const file = body?.file;
		if (!(file instanceof File)) {
			return c.json({ errors: ["缺少拓展包文件(multipart 字段 file)"] }, 400);
		}
		const opened = openExtensionPackage(new Uint8Array(await file.arrayBuffer()));
		if (!opened.ok) return c.json({ errors: opened.errors }, 400);

		let replaced: boolean;
		try {
			({ replaced } = await installExtensionPackage({ root: install.root, pkg: opened.pkg }));
		} catch (err) {
			// 落盘那头拒绝的只有一种:目标是 devtools 链进来的工作树。那句话要原样给主人。
			return c.json({ errors: [(err as Error).message] }, 400);
		}
		// 新装的当场跑起来;覆盖的那份**不会**被换掉(装载器不碰已收进名单的),所以下面
		// 才要如实说重启。两种情形都扫一遍:代价只是一次读目录。
		await install.rescan();

		const answer: ExtensionInstallResponse = {
			id: opened.pkg.id,
			name: opened.pkg.manifest.name,
			version: opened.pkg.manifest.version,
			needsRestart: replaced,
			// 装这个动作不碰开关 —— 头一回装进来的就是关着的,照实报给面板。
			enabled: isExtensionEnabled(opts.store.getGlobals(), opened.pkg.id),
			restart: install.restartAbility,
		};
		return c.json(answer);
	});

	// 市场那两口要排在 `/:id/*` 前面 —— 路由按注册顺序匹配。
	app.get("/marketplace", async (c) => {
		const marketplace = opts.marketplace;
		if (!marketplace) return c.json({ ok: false, err: "not found" }, 404);
		const refresh = c.req.query("refresh") === "1";
		const body: MarketplaceResponse = await marketplace.list({ refresh });
		return c.json(body);
	});

	/** 装完的回答与上传装包**同一个形状**:面板复用同一段「装完那句话」与重启按钮。 */
	app.post("/marketplace/install", async (c) => {
		const marketplace = opts.marketplace;
		const install = opts.install;
		if (!marketplace || !install) return c.json({ ok: false, err: "not found" }, 404);
		const parsed = MarketplaceInstallRequestSchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return c.json({ errors: ["要给 source 与 id"] }, 400);
		const outcome = await marketplace.install(parsed.data.source, parsed.data.id);
		if (!outcome.ok) return c.json({ errors: [outcome.err] }, 400);
		const answer: ExtensionInstallResponse = {
			id: outcome.id,
			name: outcome.name,
			version: outcome.version,
			needsRestart: outcome.needsRestart,
			// 同上传装包那口:装不碰开关,照实报。
			enabled: isExtensionEnabled(opts.store.getGlobals(), outcome.id),
			restart: install.restartAbility,
		};
		return c.json(answer);
	});

	/**
	 * 现在能借来当连接的 bot —— 推送目标页「新建连接」挑的那一排。404 与空名单分开:
	 * 前者是「问不到」(没跑 / 这种推送源没有 bot 这回事),后者是「一个都没连着」。
	 */
	app.get("/:id/bots", (c) => {
		const bots = opts.bots(c.req.param("id"));
		if (bots === undefined) return c.json({ ok: false, err: "not found" }, 404);
		const body: ExtensionBotsResponse = { bots };
		return c.json(body);
	});

	/**
	 * 一个拓展交给面板的数据(`ctx.publishStatus`),形状**第一版不约束** —— 面板那一页
	 * 还没写,而抽象要两个例子(决策 36)。没跑 / 没交过就是 404,不是空对象:那两件事
	 * 面板要能分开说。
	 */
	app.get("/:id/status", (c) => {
		const status = opts.status(c.req.param("id"));
		if (status === undefined) return c.json({ ok: false, err: "not found" }, 404);
		return c.json(status);
	});

	return app;
}
