/**
 * 自包含 bundle 的启动入口 —— 镜像里跑的是 `node boot.mjs`,不是 `index.mjs`。
 *
 * 它只干一件事:**决定跑哪一份载荷,然后在同一个进程里把它加载起来。**
 *
 * 为什么单独一个入口,而不是把这段塞进 index.mjs 顶上:ESM 的 import 是提升的,
 * 塞进去意味着镜像那份服务端的整张模块图**已经加载完**才轮到我们决定,然后再加载
 * 一遍载荷那份 —— 内存直接翻倍。boot 这个入口只牵到 node 内建 + 选版那一小块。
 *
 * 为什么不 spawn 子进程:那要多养一个常驻 node 进程(小机器上几十 MB 是真的),
 * 还要转发信号、处理孤儿([[desktop-sidecar-orphan]] 那类问题)。同进程 `import()`
 * 之后,载荷里的 `import.meta.url` 指的就是它自己的目录 —— dashboard 资源和版本号
 * 因此自动跟着走(见 `config/web-dist.ts`、`routes/health.ts`)。
 *
 * **镜像里这段代码是冻住的**:用户不重拉镜像的话,它得能启动任何未来版本的载荷。
 * 所以「载荷导出 `startStandaloneServer`」是一条**向前兼容契约**,不是内部约定 ——
 * 改它就等于让老镜像上的用户更新完打不开。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "./runtime/entrypoint.js";
import { findNearestPackageJson } from "./runtime/nearest-package-json.js";
import { markBootSucceeded, selectVersionForBoot } from "./update/select-version-for-boot.js";
import { resolveVersionsRoot } from "./update/versions-root.js";

/** 载荷必须长成这样才起得来。少了这个导出就当它坏了 —— 见文件头那条契约。 */
interface PayloadModule {
	startStandaloneServer?: (options: { installProcessHandlers: boolean }) => Promise<unknown>;
}

export interface BootSelectedPayloadInput {
	/** 镜像 / 安装包自带的版本。 */
	imageVersion: string;
	/** 镜像自带那份载荷所在目录(容器里是 `/app`)。 */
	imagePath: string;
	/** 已装载荷的根,如 `/data/versions`。 */
	versionsRoot: string;
	maxBootFailures: number;
	/** 按路径加载一份载荷。注入是为了能测 —— 真实实现就是一次动态 `import()`。 */
	loadPayload: (entryPath: string) => Promise<unknown>;
	log: (msg: string) => void;
	/** 注入是为了能测 —— 真实运行就是 `process.env`。 */
	env?: NodeJS.ProcessEnv;
}

export interface BootResult {
	version: string;
	isImageVersion: boolean;
}

async function start(
	loadPayload: BootSelectedPayloadInput["loadPayload"],
	dir: string,
	image: { version: string; path: string },
	env: NodeJS.ProcessEnv,
) {
	// 载荷自己看不见镜像 —— 它只知道自己在哪。可「能退回到哪一版」得知道地板在哪,
	// 所以由这里传下去。经 env 而不是函数参数:那个导出是**冻在镜像里**的向前兼容
	// 契约,加参数就等于要求所有未来载荷都跟着改签名。
	env.BN_IMAGE_VERSION = image.version;
	env.BN_IMAGE_PATH = image.path;
	const mod = (await loadPayload(join(dir, "index.mjs"))) as PayloadModule;
	if (typeof mod.startStandaloneServer !== "function") {
		throw new Error(`载荷没有导出 startStandaloneServer:${dir}`);
	}
	await mod.startStandaloneServer({ installProcessHandlers: true });
}

export async function bootSelectedPayload({
	imageVersion,
	imagePath,
	versionsRoot,
	maxBootFailures,
	loadPayload,
	log,
	env = process.env,
}: BootSelectedPayloadInput): Promise<BootResult> {
	const selection = selectVersionForBoot({
		imageVersion,
		imagePath,
		versionsRoot,
		maxBootFailures,
	});

	if (!selection.isImageVersion) {
		try {
			await start(loadPayload, selection.path, { version: imageVersion, path: imagePath }, env);
			// 起来了才销账。反过来的话计数永远回到零,坏版本会被无限重试 ——
			// 自愈等于没有。
			markBootSucceeded({ versionsRoot, version: selection.version });
			return { version: selection.version, isImageVersion: false };
		} catch (err) {
			// **刻意不销账**:这一次的尝试要留在账上,累够次数才判死。
			// 日志里必须带上是哪一版、为什么 —— 否则用户只看到「更新完版本没变」。
			log(
				`[boot] 载荷 ${selection.version} 起不来,回落到镜像自带的 ${imageVersion}:` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// 镜像那份要是也起不来,就让它抛出去。静默退 0 的容器会被编排系统当成「正常
	// 结束」—— 不重启、不报警,用户只看到服务没了而日志里什么都没有。
	await start(loadPayload, imagePath, { version: imageVersion, path: imagePath }, env);
	markBootSucceeded({ versionsRoot, version: imageVersion });
	return { version: imageVersion, isImageVersion: true };
}

/**
 * 真实的加载器:一次动态 `import()`。
 *
 * 走 `pathToFileURL` 而不是直接喂路径 —— Windows 上 `C:\...` 不是合法的 import
 * 说明符。用变量而不是字面量,打包器才不会试图在构建期把它解析掉。
 */
async function importPayload(entryPath: string): Promise<unknown> {
	return import(pathToFileURL(entryPath).href);
}

/**
 * 镜像自带的版本号,从 boot.mjs 旁边那份 package.json 读。
 *
 * **刻意不复用 `routes/health.ts` 的 `resolveAppVersion`** —— 那个模块牵着 hono 和
 * 八份核心包的 package.json,import 进来就等于把 boot 这个入口的模块图撑大,而这个
 * 入口存在的全部意义就是「在加载服务端之前只牵最少的东西」。往上找的那一步与它共用
 * 一个只牵 node 内建的小模块(`runtime/nearest-package-json.ts`),别再各抄一份。
 */
function readImageVersion(here: string): string {
	// bundle 形态下 package.json 与 boot.mjs 同级(容器),外置 lib 形态下它在 `lib/`
	// 的上一层(桌面壳);再多一层是余量。
	const pkgPath = findNearestPackageJson(here, 2);
	try {
		const pkg = pkgPath
			? (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string })
			: undefined;
		if (pkg?.version) return pkg.version;
	} catch {
		// 读不动 / 不是 JSON:按下面的兜底走。
	}
	// 读不到就当自己是最老的:任何装着的载荷都会被选中。总比反过来(当自己最新、
	// 永远不升)强 —— 后者是静默失效,用户完全没线索。
	return "0.0.0";
}

if (isEntrypoint(import.meta.url)) {
	const here = dirname(fileURLToPath(import.meta.url));
	void bootSelectedPayload({
		imageVersion: readImageVersion(here),
		imagePath: here,
		// 桌面壳用 `--data-dir` 传用户数据目录,容器把它写在 yaml 里 —— 只看
		// BN_DATA_DIR 的话这两条路都会去错目录找版本,而且两边都不报错。
		versionsRoot: resolveVersionsRoot({
			argv: process.argv.slice(2),
			env: process.env,
			cwd: process.cwd(),
		}),
		maxBootFailures: 3,
		loadPayload: importPayload,
		log: (msg) => process.stderr.write(`${msg}\n`),
	}).catch((err) => {
		console.error("fatal startup error", err);
		process.exit(1);
	});
}
