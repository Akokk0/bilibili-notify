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
