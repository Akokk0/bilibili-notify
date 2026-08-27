/**
 * zip 皮肤包解析:不可信字节流 → { manifest, assets } 或拒绝。
 *
 * 两道闸防 zip bomb:filter 阶段按 zip 头声称的大小/数量预筛(骗过它的畸形头),
 * 解压后再按真实 byteLength 复核。包内文件走白名单(skin.json + assets/ 图片),
 * macOS 打包垃圾(__MACOSX/、.DS_Store)静默忽略 —— 用户自己压的包十有八九带。
 */

import type { SkinManifest } from "@bilibili-notify/contract";
import { MAX_FONT_ASSET_BYTES } from "@bilibili-notify/internal/constants";
import { strFromU8, unzipSync } from "fflate";
import { parseAssetNames } from "../runtime/asset-labels.js";
import { ASSET_NAMES_FILE } from "./asset-names.js";
import { stripDecorationResidue } from "./css-sanitizer.js";
import {
	isSkinAssetName,
	parseSkinManifest,
	SKIN_FONT_FILE_RE,
	WALLPAPER_IMAGE_RE,
} from "./schema.js";

/**
 * 一套皮肤最多放几份资产(图 + 字体)。**编辑器那头(`SkinStore.addAsset`)与 zip
 * 这头共用这一个数** —— 两边各写各的时,手搓一个超量包能整份存进去,然后编辑器
 * 里再传一份就被拒,而资产列表早已越过它自己声称的上限:主人得先删到线下才动得了,
 * 而那条错误信息一个字都没提这件事。
 */
export const MAX_SKIN_ASSETS = 12;

/**
 * 包内文件数的粗筛(zip bomb 的第一道)。
 *
 * 恰好是「装满资产的那份导出」:{@link MAX_SKIN_ASSETS} 份资产 + `skin.json`
 * + 原名清单 `assets/index.json`。这两样是包里仅有的非资产文件(见下面那张白名单),
 * 所以 +2 不是留富余,是**正好装得下自己导出的满包**。
 */
export const MAX_PACKAGE_FILES = MAX_SKIN_ASSETS + 2;
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/**
 * 包内字体的单文件上限,与卡片字体图廊**共用同一个数** —— 同一款字在两处传得进
 * 传不进,不该看它是给卡片还是给皮肤的。
 *
 * 刻意比图片那条 5MB 线宽得多:一款完整中文 woff2 就有八九兆,拿 5MB 卡它等于这
 * 功能不存在。反过来图片那条**不跟着放宽** —— 壁纸没有大到 20MB 的理由。
 */
export const MAX_FONT_BYTES = MAX_FONT_ASSET_BYTES;
const MAX_MANIFEST_BYTES = 512 * 1024;
/** 解压后总量上限。够装满一款 20MB 字体 + 一包壁纸,再多就当 zip bomb 拦下。 */
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

export type OpenSkinPackageResult =
	| {
			ok: true;
			manifest: SkinManifest;
			assets: Map<string, Uint8Array>;
			/** 资产原名清单;只做显示,缺失 / 坏掉一律空表(见 asset-names.ts)。 */
			names: Record<string, string>;
			warnings: string[];
	  }
	| { ok: false; errors: string[] };

function isJunk(name: string): boolean {
	return (
		name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store"
	);
}

/** manifest 各处引用的图片集合(整页壁纸 + chat 壁纸)。zip 校验与编辑保存共用一把尺。 */
export function referencedImages(manifest: SkinManifest): Set<string> {
	const referenced = new Set<string>();
	for (const mode of [manifest.modes.light, manifest.modes.dark]) {
		if (!mode) continue;
		for (const image of [mode.wallpaper?.image, mode.chat?.wallpaper?.image]) {
			if (image) referenced.add(image);
		}
	}
	return referenced;
}

/** manifest 各处引用的字体文件集合(每套模式一款)。 */
export function referencedFonts(manifest: SkinManifest): Set<string> {
	const referenced = new Set<string>();
	for (const mode of [manifest.modes.light, manifest.modes.dark]) {
		if (mode?.fonts?.asset) referenced.add(mode.fonts.asset);
	}
	return referenced;
}

/**
 * 包里必须存在的全部资产(图 + 字体)。
 *
 * 与 {@link referencedImages} 分开而不是把它改宽:`chat-tool` 拿前者判「这套皮肤
 * 真做出壁纸了吗」,混进字体之后,一套只换了字的皮肤会被报成「壁纸做好了」。
 */
export function referencedAssets(manifest: SkinManifest): Set<string> {
	return new Set([...referencedImages(manifest), ...referencedFonts(manifest)]);
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
	let namesBytes: Uint8Array | null = null;
	const assets = new Map<string, Uint8Array>();
	for (const [name, data] of Object.entries(entries)) {
		if (name === ASSET_NAMES_FILE) {
			// 原名清单**不进 assets** —— 进了就会被当成一份资产落盘、列出、serve 出去。
			// 大小按 manifest 那条限:它顶天也就几十个文件名。
			if (data.byteLength <= MAX_MANIFEST_BYTES) namesBytes = data;
		} else if (name === "skin.json") {
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
		} else if (SKIN_FONT_FILE_RE.test(name) && !name.includes("..")) {
			if (data.byteLength > MAX_FONT_BYTES) {
				errors.push(
					`${name}: 字体过大(上限 ${Math.round(MAX_FONT_BYTES / 1024 / 1024)}MB)—— 同一套字转成 woff2 通常只占三分之一`,
				);
			} else {
				assets.set(name, data);
			}
		} else {
			errors.push(
				`${name}: 包里只允许 skin.json 和 assets/ 下的 webp/jpg/png 与 woff2/woff/ttf/otf`,
			);
		}
	}
	// 文件数那道是粗筛(它连 skin.json 一起数);资产数得单独问一句 —— 一个不带
	// 原名清单的包能在文件数之内塞进多一份资产,而落盘之后编辑器就再也加不进东西。
	if (assets.size > MAX_SKIN_ASSETS) {
		errors.push(`包里的资产太多(${assets.size} 份,上限 ${MAX_SKIN_ASSETS} 份),删掉用不上的再传`);
	}
	if (!manifestBytes && errors.length === 0) errors.push("包里缺少 skin.json");
	if (errors.length > 0 || !manifestBytes) return { ok: false, errors };

	let json: unknown;
	try {
		json = JSON.parse(strFromU8(manifestBytes));
	} catch {
		return { ok: false, errors: ["skin.json 不是合法 JSON"] };
	}
	// 旧版(≤v0.7.0)导出的包身上还烙着清洗层的旧笔迹 —— **解析前**先摘:否则
	// parseCssField 对每条装饰规则刷一遍「pointer-events 不在白名单」(正是读盘
	// 迁移要消灭的刷屏),而白名单内的 z-index:-1 会原样随包落盘再传染下去。
	stripRawManifestResidue(json);
	const parsed = parseSkinManifest(json);
	if (!parsed.ok) return parsed;

	const referenced = referencedAssets(parsed.skin);
	for (const name of referenced) {
		if (!assets.has(name)) errors.push(`${name}: manifest 引用了它,但包里没有这个文件`);
	}
	if (errors.length > 0) return { ok: false, errors };

	const warnings = [...parsed.warnings];
	for (const name of assets.keys()) {
		if (!referenced.has(name)) warnings.push(`${name}: 包里带了但 manifest 没引用,不会被使用`);
	}
	// 清单读不懂就当没有 —— 名字是锦上添花,不该让一整套皮肤装不进去。
	let names: Record<string, string> = {};
	if (namesBytes) {
		try {
			names = parseAssetNames(JSON.parse(strFromU8(namesBytes)), isSkinAssetName);
		} catch {
			names = {};
		}
	}
	return { ok: true, manifest: parsed.skin, assets, names, warnings };
}

/**
 * 对**未过 schema** 的原始 manifest JSON 就地摘烙印(css / modes.*.css 是字符串
 * 才动,别的形状留给 parseSkinManifest 正常报错)。与 store 读盘迁移是同一把
 * 清洁工,只是这头拿到的还不是 SkinManifest。
 */
function stripRawManifestResidue(json: unknown): void {
	if (!json || typeof json !== "object") return;
	const m = json as { css?: unknown; modes?: unknown };
	if (typeof m.css === "string") m.css = stripDecorationResidue(m.css);
	if (!m.modes || typeof m.modes !== "object") return;
	for (const theme of ["light", "dark"] as const) {
		const mode = (m.modes as Record<string, unknown>)[theme];
		if (!mode || typeof mode !== "object") continue;
		const holder = mode as { css?: unknown };
		if (typeof holder.css === "string") holder.css = stripDecorationResidue(holder.css);
	}
}
