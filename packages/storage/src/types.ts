import type { GcmBlob } from "./secret-box";

/**
 * On-disk encrypted cookie file shape. As of the GCM migration each field is a
 * {@link GcmBlob} (`{ v:2, iv, tag, data }`). Legacy AES-256-CBC files
 * (`{ iv, data }`, no `v`/`tag`) are NOT migrated — {@link CookieStore.load}
 * rejects them and returns `null` so the user re-authenticates.
 */
export interface StoredCookies {
	cookiesJson: GcmBlob;
	refreshToken?: GcmBlob;
}
