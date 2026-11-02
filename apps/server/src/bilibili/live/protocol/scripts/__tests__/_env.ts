import { fixedTimezone } from "../../../../../__tests__/support/integration-io.js";
import { BUILTIN_INTEGRATION_KEYS } from "../../../../../compose.js";
/**
 * 三个真机脚本(probe-login / capture-frames / smoke-live)共用的启动样板:数据目录、
 * ServiceContext、只读打开服务端落盘的登录态。以前各抄一份,2026-08-27 那次写死路径的
 * 泄漏正是三份里有一份走了样 —— 收成一份,改一处三处都对。
 *
 * 只读铁律:**结构上做不到**写盘与续期。登录态从在用那一代的 `secrets/bilibili/secrets.enc` 只读地解开,
 * 放进**内存版**的存储把手里 —— 里面只有 `http.cookies`,**没有 `refreshToken`**,落盘也只是记一笔不碰盘。
 * 读盘的两处(主密钥、`secrets.enc` 与 `state.json` 里的浏览器身份)都不写盘、不隔离改名:文件坏了就当没有。
 * 没有令牌 `Api` 就不会触发 cookie 刷新舞步(RSA 轮换:旧 cookie 被 B 站作废而新 cookie 只在本进程内存里,
 * 脚本一退出登录态就死;2026-08-27 就这样弄丢过一次主人的扫码登录)。从前靠「记得别传 refreshToken」,现在传不进去。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json, Logger, ServiceContext } from "@bilibili-notify/internal";
import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/internal";
import { type KeyProvider, readKeyMaterial } from "@bilibili-notify/storage";
import { ignoredProblems } from "../../../../../__tests__/support/ignored-problems.js";
import { inertSettingsOf } from "../../../../../__tests__/support/inert-settings.js";
import { inertTransitImages } from "../../../../../__tests__/support/integration-io.js";
import { memoryStoreHandle } from "../../../../../__tests__/support/memory-key-value-store.js";
import {
	integrationStateFile,
	readIntegrationSecretsFile,
} from "../../../../../integration-store/files.js";
import { parseStoredEntries } from "../../../../../integration-store/key-value-store.js";
import { redactLogCall } from "../../../../../logs/redact.js";
import { createValueRedactor } from "../../../../../logs/value-redactor.js";
import { listGenerationEntries } from "../../../../../runtime/generations.js";
import { dataPath } from "../../../../../runtime/roots.js";
import { Api } from "../../../../api/index.js";
import { createBiliContext } from "../../../../context.js";

const repoRoot = fileURLToPath(new URL("../../../../../../../..", import.meta.url));
/** 服务端的数据目录(宿主根);跑别的实例用 BN_DATA_DIR 指过去。 */
export const dataDir = process.env.BN_DATA_DIR ?? join(repoRoot, "apps", "server", "data");

/**
 * 这几个脚本自己的打码登记册:读真登录态的脚本,日志也要过与服务端同一个遮法 —— 先按登记的值(罐子里的
 * cookie 经下面内存把手的 `redact` 登记进来)、再按固定形状。不然脚本一打 cookie 就是明文落在终端里。
 */
const scriptRedactor = createValueRedactor();

/** 与服务端日志出口同一个遮法(`redactLogCall`)的 console 日志器。 */
export const consoleLogger: Logger = (() => {
	// 打的时候才取 console 上的口(不在模块加载时拍快照),换了 console 的实现也跟着走。
	const write =
		(method: "log" | "warn" | "error") =>
		(msg: string, ...args: unknown[]): void => {
			const safe = redactLogCall(msg, args, scriptRedactor);
			console[method](safe.msg, ...safe.args);
		};
	return { info: write("log"), warn: write("warn"), error: write("error"), debug: () => {} };
})();

/** 真时钟的 ServiceContext。 */
export function makeServiceCtx(logger: Logger = consoleLogger): ServiceContext {
	return {
		logger,
		setInterval(fn, ms) {
			const h = setInterval(fn, ms);
			return { dispose: () => clearInterval(h) };
		},
		setTimeout(fn, ms) {
			const h = setTimeout(fn, ms);
			return { dispose: () => clearTimeout(h) };
		},
		onDispose() {},
		signal: new AbortController().signal,
		track: () => {},
	};
}

/** 在用的那一代 = 序号最大的完整一代。只读盘,不开新代。 */
async function activeGenerationDir(): Promise<string | undefined> {
	const entries = await listGenerationEntries(dataDir);
	return entries.reverse().find((entry) => !entry.partial && entry.file !== undefined)?.dir;
}

/** 只读地取存着的浏览器身份:读文本 + 纯解析(`parseStoredEntries`),文件坏了也不隔离、不改名;读不出就是没有。 */
async function readStoredIdentity(dataRoot: string): Promise<Json | undefined> {
	try {
		const text = await readFile(
			dataPath(dataRoot, ...integrationStateFile(BILIBILI_SOURCE_KEY, BUILTIN_INTEGRATION_KEYS)),
			"utf8",
		);
		return parseStoredEntries(JSON.parse(text))?.get("http.identity");
	} catch {
		return undefined;
	}
}

/**
 * 用服务端落盘的登录态起一个**只读**的 Api。没有登录态直接退出进程 —— 三个脚本
 * 没有登录态都没法往下走。
 */
export async function openReadonlyApi(serviceCtx: ServiceContext): Promise<Api> {
	const dataRoot = await activeGenerationDir();
	if (!dataRoot) {
		console.error(`${dataDir} 里没有数据代,先启动一次 BN`);
		process.exit(1);
	}
	// 只读地拿主密钥:缺了不造(`getKey()` 缺文件会当场写一把)。
	const material = await readKeyMaterial({
		passphrase: process.env.BN_COOKIE_KEY,
		keyPath: dataPath(dataRoot, "secrets", "master.key"),
		saltPath: dataPath(dataRoot, "secrets", "kdf.salt"),
	});
	if (material.kind !== "ok") {
		console.error(`${dataRoot} 里找不到主密钥,没法解开登录态`);
		process.exit(1);
	}
	const keyProvider: KeyProvider = {
		getKey: async () => material.key,
		protected: Boolean(process.env.BN_COOKIE_KEY?.trim()),
	};
	const read = { dataRoot, key: BILIBILI_SOURCE_KEY, logger: serviceCtx.logger };
	const secrets = await readIntegrationSecretsFile({
		reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		...read,
		keyProvider,
	});
	const cookies = secrets.kind === "ok" ? secrets.entries.get("http.cookies") : undefined;
	if (typeof cookies !== "string" || cookies === "[]") {
		console.error(`没有登录态:${dataRoot} 的 B 站 secrets 里没有 cookie,先在 dashboard 扫码登录`);
		process.exit(1);
	}
	// 浏览器身份也读存着的那一份(同一个 cookie 会话在不同 UA 间跳变是机器人特征);读不到就让宿主现生成。
	// 不能用 `readIntegrationStateFile`:文件坏了它会把线上文件隔离改名。这里只读文本、只解析,读不出就当没有。
	const identity = await readStoredIdentity(dataRoot);
	const { handle } = memoryStoreHandle(
		{
			// 只放罐子,不放令牌。
			secrets: { "http.cookies": cookies },
			state:
				identity === undefined
					? undefined
					: ({ "http.identity": identity } as Record<string, Json>),
		},
		// 罐子里的 cookie 值登记进脚本自己的登记册,`consoleLogger` 按它遮。
		(kind, values) => scriptRedactor.replace(BILIBILI_SOURCE_KEY, kind, values),
	);
	const context = await createBiliContext({
		timezoneReader: fixedTimezone("Asia/Shanghai"),
		transitImages: inertTransitImages,
		stores: { open: async () => handle },
		serviceCtx,
		problems: ignoredProblems,
		settingsOf: inertSettingsOf,
	});
	const api = new Api({ serviceCtx, ctx: context.ctx });
	await api.start();
	await api.resumeStoredLogin();
	return api;
}
