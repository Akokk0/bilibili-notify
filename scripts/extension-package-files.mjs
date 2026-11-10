// 拓展ZIP的唯一打包实现；官方脚本与仓外开发工具共同使用。
import { digestOf, EXTENSION_ZIP_EPOCH, reproducibleZip } from "./reproducible-zip.mjs";

export const EXTENSION_PACKAGE_FILES = ["extension.json", "index.mjs"];
/**
 * 给人看的那两份,**两份都可选**。名字与装载那头的白名单是同一套 —— 那边多认一个名字,
 * 这边就得多打一个,否则官方拓展发出去了市场上却没有说明。
 */
export const EXTENSION_PACKAGE_DOC_FILES = ["README.md", "CHANGELOG.md"];
/**
 * 官方包里认的译文。语言码与核心的 `LOCALES` 是同一张表 —— 打包这头是 .mjs,进不来
 * TypeScript 源码,只能另写一份;`pack-extension.test.mjs` 拿两头对着钉。
 */
export const EXTENSION_PACKAGE_LOCALES = ["zh-CN", "zh-TW", "en", "ja"];
/**
 * 一份文档的上限,**与装载那头(`apps/server/src/extensions/discover.ts`)是同一个数**。
 *
 * 🔴 这道闸必须在**打包**这头,光靠拆包那头拦不住要命的那条路:release 是不可变的,
 * 一旦带着超大文档发出去、sha256 进了签名索引,此后每个用户点安装都得到「包拆不开」,
 * 只能升版号重发。两头各写一份数会漂,所以 `pack-extension.test.mjs` 拿它们对着钉。
 */
export const EXTENSION_DOC_MAX_BYTES = 512 * 1024;
/** 一份译文的上限,同样与装载那头是同一个数。 */
export const EXTENSION_LOCALE_FILE_MAX_BYTES = 256 * 1024;
/** `locales/` 合计的上限,同样与装载那头是同一个数。 */
export const EXTENSION_LOCALES_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
/** 解压后的整包上限,与装载那头的 `MAX_EXTENSION_PACKAGE_BYTES` 是同一个数。 */
export const EXTENSION_PACKAGE_MAX_BYTES = 10 * 1024 * 1024;

const EXTENSION_LOCALE_FILE_NAME = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.json$/;

/** @param {Record<string, Uint8Array>} files */
export function packExtension(files) {
	const entries = {};
	for (const name of EXTENSION_PACKAGE_FILES) {
		const bytes = files[name];
		if (!bytes) throw new Error(`拓展包缺 ${name}`);
		entries[name] = bytes;
	}
	// 可选的按**固定顺序**追加:条目顺序会进 zip 的字节,而 sha256 是索引里钉着的。
	for (const name of EXTENSION_PACKAGE_DOC_FILES) {
		const bytes = files[name];
		if (!bytes) continue;
		if (bytes.byteLength > EXTENSION_DOC_MAX_BYTES) {
			throw new Error(
				`${name} 太大了(${bytes.byteLength} 字节,上限 ${EXTENSION_DOC_MAX_BYTES})—— 装载那头会拒,发出去就是个谁都装不上的包`,
			);
		}
		entries[name] = bytes;
	}
	// 译文只打语言表里的那几种,并按表的顺序追加:不在表里的连包都不进,但整个目录的大小
	// 与每份的 JSON 仍要当场核 —— 一个写错的 dist 不该等到用户点安装才露馅。
	let localesBytes = 0;
	const bundleLocales = [];
	for (const [name, bytes] of Object.entries(files)) {
		if (!name.startsWith("locales/")) continue;
		const file = name.slice("locales/".length);
		if (!EXTENSION_LOCALE_FILE_NAME.test(file)) continue;
		localesBytes += bytes.byteLength;
		const code = file.slice(0, -".json".length);
		if (!EXTENSION_PACKAGE_LOCALES.includes(code)) continue;
		if (bytes.byteLength > EXTENSION_LOCALE_FILE_MAX_BYTES) {
			throw new Error(
				`${name} 太大了(${bytes.byteLength} 字节,上限 ${EXTENSION_LOCALE_FILE_MAX_BYTES})—— 装载那头会拒,发出去就是个谁都装不上的包`,
			);
		}
		try {
			JSON.parse(Buffer.from(bytes).toString("utf8"));
		} catch (err) {
			throw new Error(`${name} 不是合法的 JSON:${err.message}`);
		}
		bundleLocales.push([name, bytes]);
	}
	if (localesBytes > EXTENSION_LOCALES_TOTAL_MAX_BYTES) {
		throw new Error(
			`locales/ 太大了(${localesBytes} 字节,上限 ${EXTENSION_LOCALES_TOTAL_MAX_BYTES})—— 装载那头会拒,发出去就是个谁都装不上的包`,
		);
	}
	for (const code of EXTENSION_PACKAGE_LOCALES) {
		const found = bundleLocales.find(([name]) => name === `locales/${code}.json`);
		if (found) entries[found[0]] = found[1];
	}
	const total = Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0);
	if (total > EXTENSION_PACKAGE_MAX_BYTES) {
		throw new Error(
			`包解压后总量过大(${total} 字节,上限 ${EXTENSION_PACKAGE_MAX_BYTES})—— 装载那头会拒,发出去就是个谁都装不上的包`,
		);
	}
	// 固定时间戳:同样的产物打出同样的字节,sha256 才复现得了。
	const zip = reproducibleZip(entries, EXTENSION_ZIP_EPOCH);
	return { zip, ...digestOf(zip) };
}
