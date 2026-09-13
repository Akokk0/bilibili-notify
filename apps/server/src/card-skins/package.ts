/**
 * **卡片皮肤包**的装包门(ADR-0014 决策 2 / 5 / 19)—— 不可信 zip →
 * `{ card-skin.json, assets/* }`,再把清单洗干净。
 *
 * 两段分开(`parseCardSkinPackage` 摊包、`checkCardSkinPackage` 验+洗)不是为了好看:
 * **编辑器保存走的是同一道验+洗**,只是资产清单来自盘上而不是 zip 里。合成一个函数的话,
 * 保存那条路要么绕过清洗(皮肤能在编辑器里把 `<script>` 存进盘),要么得自己拼一个假 zip。
 *
 * 与 dashboard 皮肤包(`skins/package.ts`)同规同纪律:zip-bomb 两道闸(解压前按 zip 头
 * 预筛,解压后按真实字节复核)、`__MACOSX/` 与 `.DS_Store` 静默忽略、资产名走白名单正则
 * 所以路径穿越连正则都进不来。压缩炸弹那道是**共用**的(`../zip-junk.ts`),不抄第二遍。
 *
 * **存盘的是洗过的产物**:清洗结果写回 manifest 再交给调用方。不这么做的话,盘上躺着
 * 的是原文、每次出图现洗一遍 —— 既慢,又让「装的时候报过的警告」在盘上无迹可寻。
 */

import {
	CARD_SKIN_KINDS,
	CARD_SKIN_LIMITS,
	type CardSkinManifest,
	type CardSkinVariableDefaults,
	parseCardSkin,
} from "@bilibili-notify/internal";
import { strFromU8 } from "fflate";
import { openZipEntries } from "../zip-junk.js";
import { sanitizeCardBlockCss, sanitizeCardFrameCss } from "./css-sanitizer.js";
import { sanitizeCardBlockHtml } from "./html-sanitizer.js";

/** 清单在包内的名字。与 dashboard 的 `skin.json` 刻意不同名:两种包长得像,别互相认错。 */
export const CARD_SKIN_MANIFEST_FILE = "card-skin.json";

/**
 * 包内资产:**一级** `assets/` 目录 + 后缀白名单,名字只准小写字母 / 数字 / `.` `_` `-`。
 *
 * 与 dashboard 的 `isSkinAssetName` 同一把尺:这个名字要拼进磁盘路径、拼进出图 HTML 的
 * `src`,所以 `/` 与 `..` 连正则都进不来 —— 安全性由构造保证,不靠调用方记得检查。
 */
export const CARD_SKIN_IMAGE_RE = /^assets\/[a-z0-9._-]+\.(png|jpe?g|webp|gif)$/;
/** 包内字体。卡片皮肤能自带字(出图的 `--bn-card-font` 指得到它)。 */
export const CARD_SKIN_FONT_RE = /^assets\/[a-z0-9._-]+\.(woff2|woff|ttf|otf)$/;

/** 这个名字能不能作为包内资产落盘 / 回读 —— 写盘、列清单、回读三道闸共用它。 */
export function isCardSkinAssetName(name: string): boolean {
	if (name.includes("..")) return false;
	return CARD_SKIN_IMAGE_RE.test(name) || CARD_SKIN_FONT_RE.test(name);
}

/**
 * `card-skin.json` 的字节上限。**从 schema 自己的上限算出来**,不手拍一个数:拍小了,
 * 一份每块都写满 CSS 的合法皮肤会卡在「清单过大」上,而那句错误里没有半个字提示是这道
 * 闸与 schema 不同意。七种卡各一份外框 CSS + `maxBlocks` 个块(每块 CSS 与自定义 HTML
 * 都顶格),再留四分之一给 JSON 的引号、转义与网格字段。
 */
export const MAX_CARD_SKIN_MANIFEST_BYTES = Math.ceil(
	CARD_SKIN_KINDS.length *
		(CARD_SKIN_LIMITS.maxCssBytes +
			CARD_SKIN_LIMITS.maxBlocks * (CARD_SKIN_LIMITS.maxCssBytes + CARD_SKIN_LIMITS.maxHtmlBytes)) *
		1.25,
);

/**
 * 包内条目数的粗筛(zip bomb 的第一道)。
 *
 * 满包是 `maxAssets` 份资产 + `card-skin.json`(包里没有第三种文件),也就是 +1 就够。
 * **多留的那一格是给错误信息的**:文件数这道是粗筛,它只会说「包内文件太多」,而超量
 * 的包主人真正要听的是「资产最多 12 份,删掉用不上的再传」—— 不留这一格,下面那句
 * 说得清的错误永远轮不到开口。
 */
export const MAX_CARD_SKIN_PACKAGE_FILES = CARD_SKIN_LIMITS.maxAssets + 2;

/** 解压后总量上限:满配资产 + 满配清单,再多就当 zip bomb 拦下。 */
export const MAX_CARD_SKIN_TOTAL_BYTES =
	CARD_SKIN_LIMITS.maxAssets * CARD_SKIN_LIMITS.maxAssetBytes + MAX_CARD_SKIN_MANIFEST_BYTES;

export type ParseCardSkinPackageResult =
	| { ok: true; manifestRaw: unknown; assets: Map<string, Uint8Array> }
	| { ok: false; errors: string[] };

/**
 * 摊开一个卡片皮肤包。**只管文件层面**(白名单、上限、JSON 合不合法),清单的形状与
 * 清洗归 {@link checkCardSkinPackage} —— 那一道保存时还要再走一遍。
 */
export function parseCardSkinPackage(zip: Uint8Array): ParseCardSkinPackageResult {
	const opened = openZipEntries(zip, {
		maxFiles: MAX_CARD_SKIN_PACKAGE_FILES,
		maxTotalBytes: MAX_CARD_SKIN_TOTAL_BYTES,
	});
	if (!opened.ok) return { ok: false, errors: [opened.error] };

	const errors: string[] = [];
	let manifestBytes: Uint8Array | null = null;
	const assets = new Map<string, Uint8Array>();
	for (const [name, data] of Object.entries(opened.entries)) {
		if (name === CARD_SKIN_MANIFEST_FILE) {
			if (data.byteLength > MAX_CARD_SKIN_MANIFEST_BYTES) {
				errors.push(
					`${CARD_SKIN_MANIFEST_FILE} 过大(上限 ${Math.round(MAX_CARD_SKIN_MANIFEST_BYTES / 1024 / 1024)}MB)`,
				);
			} else {
				manifestBytes = data;
			}
		} else if (isCardSkinAssetName(name)) {
			// 解压后按**真实**字节复核 —— 上面那道信的是 zip 头,而头会撒谎。
			if (data.byteLength > CARD_SKIN_LIMITS.maxAssetBytes) {
				errors.push(
					`${name}: 资产过大(上限 ${Math.round(CARD_SKIN_LIMITS.maxAssetBytes / 1024 / 1024)}MB)`,
				);
			} else {
				assets.set(name, data);
			}
		} else {
			errors.push(
				`${name}: 包里只允许 ${CARD_SKIN_MANIFEST_FILE} 和 assets/ 下的图片(png / jpg / webp / gif)` +
					`与字体(woff2 / woff / ttf / otf),名字只准小写字母、数字、. _ -`,
			);
		}
	}
	// 文件数那道是粗筛(它连清单一起数);资产数得单独问一句 —— 不然一个不带清单的包
	// 能在文件数之内多塞一份资产,落盘之后编辑器就再也加不进东西。
	if (assets.size > CARD_SKIN_LIMITS.maxAssets) {
		errors.push(
			`包里的资产太多(${assets.size} 份,上限 ${CARD_SKIN_LIMITS.maxAssets} 份),删掉用不上的再传`,
		);
	}
	if (!manifestBytes && errors.length === 0) errors.push(`包里缺少 ${CARD_SKIN_MANIFEST_FILE}`);
	if (errors.length > 0 || !manifestBytes) return { ok: false, errors };

	try {
		return { ok: true, manifestRaw: JSON.parse(strFromU8(manifestBytes)), assets };
	} catch {
		return { ok: false, errors: [`${CARD_SKIN_MANIFEST_FILE} 不是合法 JSON`] };
	}
}

export type CheckCardSkinPackageResult =
	| { ok: true; manifest: CardSkinManifest; warnings: string[] }
	| { ok: false; errors: string[] };

/**
 * 清单的形状 + 清洗,**装包与编辑器保存共用这一道**(ADR-0014 决策 19)。
 *
 * 顺序是有讲究的:先 `parseCardSkin` 把形状钉住(块 id、内置块名、网格、`showIf`),
 * 再逐段清洗 —— 反过来的话,清洗器拿到的 `kind` / `builtin` 可能根本不是块名,它只能
 * 按 `self` 洗,而作者收到的是一堆「挂点不在白名单」,真正的毛病在块名上。
 *
 * 清洗是**宽容模式**:非法选择器 / 属性 / 标签逐项丢弃并出 warning,只有超上限、占位符
 * 指向不存在的字段、洗完什么都不剩这三种才 `ok:false`(那三条由清洗器自己判)。洗空的
 * CSS 当「没写」处理(不留空串字段),但**不拒包** —— 拒了的话,一份只是把某个属性写在
 * 白名单外的皮肤会整份装不进来,而那个块的其它东西本来都是好的。
 */
export function checkCardSkinPackage(
	manifestRaw: unknown,
	assetNames: ReadonlySet<string>,
): CheckCardSkinPackageResult {
	const parsed = parseCardSkin(manifestRaw);
	if (!parsed.ok) return parsed;
	// zod 交回来的已经是一份新对象(不是调用方那份 raw),所以就地洗、就地写回。
	const manifest = parsed.manifest;
	const errors: string[] = [];
	const warnings: string[] = [];

	for (const kind of CARD_SKIN_KINDS) {
		const card = manifest.cards[kind];
		if (!card) continue;
		if (card.css !== undefined) {
			const at = `cards.${kind}.css`;
			const res = sanitizeCardFrameCss(card.css);
			if (!res.ok) {
				errors.push(...res.errors.map((e) => `${at}: ${e}`));
			} else {
				warnings.push(...res.warnings.map((w) => `${at}: ${w}`));
				if (res.css === "") delete card.css;
				else card.css = res.css;
			}
		}
		card.blocks.forEach((block, i) => {
			const at = `cards.${kind}.blocks[${i}]「${block.id}」`;
			if (block.css !== undefined) {
				const res = sanitizeCardBlockCss(block.css, {
					kind,
					...(block.kind === "builtin" ? { builtin: block.builtin } : {}),
				});
				if (!res.ok) {
					errors.push(...res.errors.map((e) => `${at}.css: ${e}`));
				} else {
					warnings.push(...res.warnings.map((w) => `${at}.css: ${w}`));
					if (res.css === "") delete block.css;
					else block.css = res.css;
				}
			}
			if (block.kind !== "custom") return;
			const res = sanitizeCardBlockHtml(block.html, { kind, assets: assetNames });
			if (!res.ok) {
				errors.push(...res.errors.map((e) => `${at}.html: ${e}`));
			} else {
				warnings.push(...res.warnings.map((w) => `${at}.html: ${w}`));
				block.html = res.html;
			}
		});
	}

	checkBackgroundImage(manifest.variables, "variables", assetNames, errors);
	for (const kind of CARD_SKIN_KINDS) {
		checkBackgroundImage(
			manifest.variablesByKind?.[kind],
			`variablesByKind.${kind}`,
			assetNames,
			errors,
		);
	}

	return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest, warnings };
}

/**
 * 背景图必须是包里真有的**图片**。
 *
 * 收下一个盘上没有的名字,症状是本仓库反复复发的那类「选得动、存得住、就是不生效」:
 * 编辑器里明明写着背景图,出的图却是光板 —— 而出图那一步不会、也不该为此报错。
 * 指到字体上同理(那更像是复制粘贴串行),一并拦在门口。
 */
function checkBackgroundImage(
	vars: CardSkinVariableDefaults | undefined,
	at: string,
	assetNames: ReadonlySet<string>,
	errors: string[],
): void {
	const name = vars?.backgroundImage;
	if (name === undefined) return;
	if (!assetNames.has(name)) {
		errors.push(`${at}.backgroundImage: 指了「${name}」,但包里没有这份资产`);
		return;
	}
	if (!CARD_SKIN_IMAGE_RE.test(name)) {
		errors.push(`${at}.backgroundImage:「${name}」不是图片`);
	}
}
