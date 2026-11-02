import { BUILTIN_INTEGRATION_KEYS } from "../../../../compose.js";
/**
 * 登录系统测试共用的「真存储世界」:临时目录里的真集成存储宿主(真 FileKeyProvider),`seed` 往盘上预放登录、
 * `disk` 读解开后的 `secrets`;`stallRenewalAtConfirm` 把一轮续期停在确认 POST 上。
 * `auth-system-lifecycle.test.ts` 与 `__tests__/compose.test.ts`(整条关停次序)共用。
 */

import { join } from "node:path";
import type { CookieJar } from "@bilibili-notify/http";
import type { Json, Logger } from "@bilibili-notify/internal";
import { FileKeyProvider, type KeyProvider } from "@bilibili-notify/storage";
import { vi } from "vite-plus/test";
import { readIntegrationSecretsFile } from "../../../../integration-store/files.js";
import { createIntegrationStore } from "../../../../integration-store/store.js";
import { createValueRedactor } from "../../../../logs/value-redactor.js";
import { makeServiceContext } from "../../../api/__tests__/support/make-api.js";
import { ApiClient } from "../../../api/api-client.js";
import { Api } from "../../../api/index.js";

export const C0 = JSON.stringify([
	{ key: "SESSDATA", value: "sess0", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "bili_jct", value: "jct0", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "buvid3", value: "b3", domain: ".bilibili.com", path: "/", secure: true },
]);
export const C1 = JSON.stringify([
	{ key: "SESSDATA", value: "sess1", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "bili_jct", value: "jct1", domain: ".bilibili.com", path: "/", secure: true },
	{ key: "buvid3", value: "b3", domain: ".bilibili.com", path: "/", secure: true },
]);

export function authWorld(dataDir: string, logger?: Logger) {
	const host = makeServiceContext(logger);
	const fileKeys = new FileKeyProvider(join(dataDir, "secrets", "master.key"), host.logger);
	/**
	 * 数写盘次数:写 `secrets.enc` 每次都要取一次主密钥(读也取,所以只在读完之后的某一段里数),
	 * 一次取钥 = 一次写。内容看最后落在盘上的那份。
	 */
	let keyFetches = 0;
	const keyProvider: KeyProvider = {
		protected: fileKeys.protected,
		getKey: () => {
			keyFetches += 1;
			return fileKeys.getKey();
		},
	};
	const keyFetchCount = () => keyFetches;
	const store = createIntegrationStore({
		reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
		dataRoot: dataDir,
		keyProvider,
		logger: host.logger,
		redactor: createValueRedactor(),
	});
	/** 上一次关停之后盘上这个集成的 `secrets` 整袋。 */
	const disk = async (): Promise<Map<string, Json>> => {
		const read = await readIntegrationSecretsFile({
			reservedIntegrationKeys: BUILTIN_INTEGRATION_KEYS,
			dataRoot: dataDir,
			key: "bilibili",
			logger: host.logger,
			keyProvider,
		});
		if (read.kind !== "ok") throw new Error(read.message);
		return read.entries;
	};
	/** 开机之前先在盘上放好:罐子(整段字符串)与令牌。 */
	const seed = async (entries: { cookies?: string; token?: string }) => {
		const handle = await store.open("bilibili");
		if (entries.cookies !== undefined)
			await handle.hostSecrets.set("http.cookies", entries.cookies);
		if (entries.token !== undefined) await handle.secrets.set("refreshToken", entries.token);
		handle.close();
	};
	const jarOf = (api: Api) => (api as unknown as { jar: CookieJar }).jar;
	return { host, store, disk, seed, jarOf, keyFetchCount };
}

/**
 * 把一轮续期停在「确认 POST」上:探测要刷新、取页、刷新 POST 都过了(罐子里已是新 cookie),确认 POST 悬着,
 * 等测试放行。罐子要等 `createAuthSystem` 返回才有 —— 链万一先跑到刷新 POST,就等 `setJar`(不抛、不吞)。
 */
export function stallRenewalAtConfirm() {
	vi.spyOn(
		Api.prototype as unknown as { fetchCookieInfo: () => Promise<unknown> },
		"fetchCookieInfo",
	).mockResolvedValue({ code: 0, data: { refresh: true, timestamp: Date.now() } });
	vi.spyOn(ApiClient.prototype, "get").mockResolvedValue('<div id="1-name">rc</div>');
	let confirmReached!: () => void;
	const reached = new Promise<void>((resolve) => {
		confirmReached = resolve;
	});
	let releaseConfirm!: (reply: unknown) => void;
	const confirmReply = new Promise<unknown>((resolve) => {
		releaseConfirm = resolve;
	});
	let setJar!: (jar: CookieJar) => void;
	const jarReady = new Promise<CookieJar>((resolve) => {
		setJar = resolve;
	});
	let posts = 0;
	vi.spyOn(ApiClient.prototype, "postForm").mockImplementation(async () => {
		posts += 1;
		if (posts === 1) {
			// 刷新 POST:罐子收到新 cookie、回新令牌。
			const jar = await jarReady;
			jar.setFromSetCookie(
				"SESSDATA=sess1; Domain=.bilibili.com; Path=/; Secure",
				"https://www.bilibili.com",
			);
			jar.setFromSetCookie(
				"bili_jct=jct1; Domain=.bilibili.com; Path=/; Secure",
				"https://www.bilibili.com",
			);
			return { code: 0, message: "0", data: { refresh_token: "T1" } };
		}
		confirmReached();
		return confirmReply;
	});
	return { reached, releaseConfirm, setJar };
}
