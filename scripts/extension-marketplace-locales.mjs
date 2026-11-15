/** 发布端只提取索引的展示文字，不让译文覆盖版本、身份或下载元数据。 */
export function cleanMarketplaceLocales(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const locales = [];
	for (const [locale, fields] of Object.entries(raw)) {
		if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
		const text = {};
		for (const key of ["name", "description", "notes"]) {
			const value = fields[key];
			if (typeof value === "string" && value.trim().length > 0) text[key] = value;
		}
		if (Object.keys(text).length > 0) locales.push([locale, text]);
	}
	return locales.length > 0 ? Object.fromEntries(locales) : undefined;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	EXTENSION_LOCALE_FILE_MAX_BYTES,
	EXTENSION_PACKAGE_LOCALES,
} from "./extension-package-files.mjs";

/** 从实际入包的语言文件取字；marketplace.notes 是普通译文键，不扩展 $manifest。 */
export async function readMarketplaceLocales(dist) {
	const locales = {};
	for (const locale of EXTENSION_PACKAGE_LOCALES) {
		let bytes;
		try {
			bytes = await readFile(join(dist, "locales", `${locale}.json`));
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (bytes.length > EXTENSION_LOCALE_FILE_MAX_BYTES)
			throw new Error(`locales/${locale}.json exceeds the locale file limit.`);
		const file = JSON.parse(bytes.toString("utf8"));
		locales[locale] = {
			name: file?.$manifest?.name,
			description: file?.$manifest?.description,
			notes: file?.["marketplace.notes"],
		};
	}
	return cleanMarketplaceLocales(locales);
}
