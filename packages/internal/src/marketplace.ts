/** 仓库源只做地址发现，不改变索引的命名空间或第三方信任级别（ADR-0041）。 */
import { fail, ok, type Result } from "./result";
import { packageText } from "./texts/index";

export const MARKETPLACE_RELEASE_TAG = "bn-marketplace";
export const MARKETPLACE_INDEX_ASSET = "marketplace.json";

const REPOSITORY = /^([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})$/i;

/** GitHub 仓库简写 / 首页网址与完整 HTTPS 索引地址共用一个入口。 */
export function normalizeMarketplaceSourceUrl(input: string): Result<{ url: string }> {
	const value = input.trim();
	let repository = value;
	let url: URL | undefined;
	try {
		url = new URL(value);
	} catch {
		// 尚不是网址的输入继续按 owner/repo 校验。
	}
	if (url) {
		if (url.protocol !== "https:" || !/^https:\/\//i.test(value) || /\s/.test(value)) {
			return fail("invalid", packageText("internal.settings.sourceUrl"));
		}
		if (url.hostname.toLowerCase() !== "github.com") return ok({ url: value });
		const path = url.pathname.replace(/^\//, "").replace(/\/$/, "");
		const fixedIndex = `/releases/download/${MARKETPLACE_RELEASE_TAG}/${MARKETPLACE_INDEX_ASSET}`;
		if (path.endsWith(fixedIndex)) repository = path.slice(0, -fixedIndex.length);
		else if (path.split("/").length === 2) repository = path.replace(/\.git$/i, "");
		else return ok({ url: value });
		if (url.username || url.password || url.port || url.search || url.hash) {
			return fail("invalid", packageText("internal.settings.sourceUrl"));
		}
	}
	const match = REPOSITORY.exec(repository);
	if (!match || match[2] === "." || match[2] === "..") {
		return fail("invalid", packageText("internal.settings.sourceUrl"));
	}
	return ok({
		url: `https://github.com/${repository.toLowerCase()}/releases/download/${MARKETPLACE_RELEASE_TAG}/${MARKETPLACE_INDEX_ASSET}`,
	});
}
