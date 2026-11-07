import { BILIBILI_SOURCE_KEY } from "@bilibili-notify/contract";
import { t as serverText } from "./i18n.js";
/**
 * 0.x 的 B 站登录 `secrets/cookies.json` → 集成的密钥文件 `secrets/bilibili/secrets.enc`。
 *
 * 0.x 那个文件是 `{ cookiesJson: GcmBlob, refreshToken?: GcmBlob }`,两格各自用第 0 代的主密钥 GCM 加密;
 * 新代里 B 站的登录住在集成自己的密钥文件里:cookie 罐是整段字符串(里面是 cookie 数组的 JSON)进 `http.cookies`
 * 键,续期令牌进 `refreshToken` 键。写法用活的 `integration-store/files.ts`(文件格式只有一个真源)。
 *
 * **冻结**:0.x 那个文件的形状在这里自己声明,不 import `packages/storage` 的 `CookieStore` / `StoredCookies`
 * (它们随 3a-26 删掉);两个键名也写成字面量,不 import 活代码的常量 —— 以后谁改了键名,迁移的产出不许跟着悄悄变。
 *
 * 解不开、读不懂的不带过来(回 `dropped`,由调用方记成「需要重新扫码」),不挡迁移。第 0 代只读。
 */

import { readFile } from "node:fs/promises";
import type { Json } from "@bilibili-notify/internal";
import { gcmDecrypt, isGcmBlob, type KeyMaterialState } from "@bilibili-notify/storage";
import { integrationSecretsFile, writeIntegrationSecretsFile } from "../integration-store/files.js";
import { errorMessageOf } from "../util/error-message.js";

/** 0.x 的 `cookies.json`:两格都是 GCM 块(旧的 CBC 形状不认)。 */
interface ZeroStoredCookies {
	cookiesJson: unknown;
	refreshToken?: unknown;
}

export type BiliLoginMigrationResult =
	| { kind: "none" }
	| { kind: "written" }
	| { kind: "dropped"; reason: string };

export interface MigrateBiliLoginOptions {
	/** 第 0 代里的 `secrets/cookies.json`。只读。 */
	cookiesPath: string;
	/** 新代的根(`.partial`):密钥文件写在它底下 `secrets/bilibili/secrets.enc`。 */
	targetDir: string;
	/** 第 0 代的主密钥(`readZeroGenerationKey`)。 */
	key: KeyMaterialState;
}

/** 新密钥文件在新代里的相对路径(`/` 分隔),给汇报用。 */
export const BILI_LOGIN_TARGET = integrationSecretsFile(BILIBILI_SOURCE_KEY, [
	BILIBILI_SOURCE_KEY,
]).join("/");

export async function migrateBiliLogin(
	opts: MigrateBiliLoginOptions,
): Promise<BiliLoginMigrationResult> {
	let raw: string;
	try {
		raw = await readFile(opts.cookiesPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
		return {
			kind: "dropped",
			reason: serverText("service.migration.bili-login.text.1", { value0: errorMessageOf(err) }),
		};
	}
	if (opts.key.kind !== "ok")
		return { kind: "dropped", reason: serverText("service.migration.bili-login.text.2") };
	const key = opts.key.key;

	let stored: ZeroStoredCookies;
	try {
		stored = JSON.parse(raw) as ZeroStoredCookies;
	} catch {
		return { kind: "dropped", reason: serverText("service.migration.bili-login.text.3") };
	}
	if (
		typeof stored !== "object" ||
		stored === null ||
		!isGcmBlob(stored.cookiesJson) ||
		(stored.refreshToken !== undefined && !isGcmBlob(stored.refreshToken))
	) {
		return { kind: "dropped", reason: serverText("service.migration.bili-login.text.4") };
	}

	let cookiesJson: string;
	let refreshToken: string | undefined;
	try {
		cookiesJson = gcmDecrypt(key, stored.cookiesJson);
		refreshToken =
			stored.refreshToken === undefined ? undefined : gcmDecrypt(key, stored.refreshToken);
	} catch {
		return { kind: "dropped", reason: serverText("service.migration.bili-login.text.5") };
	}
	if (!isJsonArray(cookiesJson))
		return { kind: "dropped", reason: serverText("service.migration.bili-login.text.6") };

	const entries = new Map<string, Json>([["http.cookies", cookiesJson]]);
	if (refreshToken) entries.set("refreshToken", refreshToken);
	const written = await writeIntegrationSecretsFile(
		{
			dataRoot: opts.targetDir,
			key: BILIBILI_SOURCE_KEY,
			keyProvider: provide(key),
			reservedIntegrationKeys: [BILIBILI_SOURCE_KEY],
		},
		entries,
	);
	// 写不进自己刚建的新代是盘的问题,不是数据的问题:和别的步一样让迁移失败重来,不悄悄丢登录。
	if (!written.ok) throw new Error(written.message);
	return { kind: "written" };
}

function provide(key: Buffer) {
	return { getKey: async () => key, protected: false };
}

function isJsonArray(text: string): boolean {
	try {
		return Array.isArray(JSON.parse(text));
	} catch {
		return false;
	}
}
