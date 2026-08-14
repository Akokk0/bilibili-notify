/**
 * zip 皮肤包解析:不可信字节流 → { manifest, assets } 或拒绝。
 *
 * 两道闸防 zip bomb:filter 阶段按 zip 头声称的大小/数量预筛(骗过它的畸形头),
 * 解压后再按真实 byteLength 复核。包内文件走白名单(skin.json + assets/ 图片),
 * macOS 打包垃圾(__MACOSX/、.DS_Store)静默忽略 —— 用户自己压的包十有八九带。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { strFromU8, unzipSync } from "fflate";
import { parseSkinManifest, WALLPAPER_IMAGE_RE } from "./schema.js";

export const MAX_PACKAGE_FILES = 16;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export type OpenSkinPackageResult =
	| { ok: true; manifest: SkinManifest; assets: Map<string, Uint8Array>; warnings: string[] }
	| { ok: false; errors: string[] };

function isJunk(name: string): boolean {
	return (
		name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store"
	);
}

export function openSkinPackage(buf: Uint8Array): OpenSkinPackageResult {
	let entries: Record<string, Uint8Array>;
	let precheckError: string | null = null;
	let count = 0;
	let claimedTotal = 0;
	try {
		entries = unzipSync(buf, {
			filter: (f) => {
				if (isJunk(f.name)) return false;
				count += 1;
				claimedTotal += f.originalSize;
				if (count > MAX_PACKAGE_FILES) {
					precheckError = `包内文件太多(上限 ${MAX_PACKAGE_FILES} 个)`;
					return false;
				}
				if (claimedTotal > MAX_TOTAL_BYTES) {
					precheckError = "包解压后总大小超限";
					return false;
				}
				return true;
			},
		});
	} catch {
		return { ok: false, errors: ["不是合法的 zip 文件"] };
	}
	if (precheckError) return { ok: false, errors: [precheckError] };

	const errors: string[] = [];
	let manifestBytes: Uint8Array | null = null;
	const assets = new Map<string, Uint8Array>();
	for (const [name, data] of Object.entries(entries)) {
		if (name === "skin.json") {
			if (data.byteLength > MAX_MANIFEST_BYTES) {
				errors.push("skin.json 过大(上限 512KB)");
			} else {
				manifestBytes = data;
			}
		} else if (WALLPAPER_IMAGE_RE.test(name) && !name.includes("..")) {
			if (data.byteLength > MAX_ASSET_BYTES) {
				errors.push(`${name}: 图片过大(上限 5MB)`);
			} else {
				assets.set(name, data);
			}
		} else {
			errors.push(`${name}: 包里只允许 skin.json 和 assets/ 下的 webp/jpg/png`);
		}
	}
	if (!manifestBytes && errors.length === 0) errors.push("包里缺少 skin.json");
	if (errors.length > 0 || !manifestBytes) return { ok: false, errors };

	let json: unknown;
	try {
		json = JSON.parse(strFromU8(manifestBytes));
	} catch {
		return { ok: false, errors: ["skin.json 不是合法 JSON"] };
	}
	const parsed = parseSkinManifest(json);
	if (!parsed.ok) return parsed;

	const referenced = new Set<string>();
	for (const mode of [parsed.skin.modes.light, parsed.skin.modes.dark]) {
		const image = mode?.wallpaper?.image;
		if (!image) continue;
		referenced.add(image);
		if (!assets.has(image)) errors.push(`${image}: manifest 引用了它,但包里没有这个文件`);
	}
	if (errors.length > 0) return { ok: false, errors };

	const warnings = [...parsed.warnings];
	for (const name of assets.keys()) {
		if (!referenced.has(name)) warnings.push(`${name}: 包里带了但 manifest 没引用,不会被使用`);
	}
	return { ok: true, manifest: parsed.skin, assets, warnings };
}
