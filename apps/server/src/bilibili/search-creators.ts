import {
	type CreatorCandidate,
	type Failure,
	fail,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { stripHtmlTags } from "../util/strip-html-tags.js";
import type { Api } from "./api/index.js";

/** 一次最多回几个候选(契约上限)。 */
const MAX_CANDIDATES = 10;

/**
 * 空间主页链接里的 UID:`space.bilibili.com/<uid>`(可带协议、后缀路径、查询串)与手机版
 * `m.bilibili.com/space/<uid>`。域名必须是 bilibili.com 的这两个主机,前面不许接别的路径或域名片段 ——
 * 认错域名等于让任意站点指挥我们去查人。别的文字回 `undefined`。
 */
const SPACE_LINK_RE =
	/(?<![A-Za-z0-9./-])(?:https?:\/\/)?(?:space\.bilibili\.com\/|m\.bilibili\.com\/space\/)(\d+)/i;

export function spaceUidOf(text: string): string | undefined {
	return SPACE_LINK_RE.exec(text)?.[1];
}

/** 搜人只用到的两个接口(测试里给假的)。 */
type SearchApi = Pick<Api, "fetchUserCard" | "searchByType">;

/**
 * B 站来源的 `searchCreators`(ADR-0021 决策 7):纯数字按 UID 精确查、空间主页链接先抽 UID 再精确查、
 * 其余按名字搜。查无此人是成功的空数组;失败用请求层给的标准码、原话与上游码,这里不另查表、不记日志。
 * 候选不带头像、不带视频数。
 */
export async function searchBiliCreators(
	api: SearchApi,
	query: string,
): Promise<Result<{ candidates: CreatorCandidate[] }>> {
	const text = query.trim();
	if (text === "") return fail("invalid", t("bilibili.search.blankQuery"));

	const refuse = (failure: Failure) => {
		return fail(
			failure.code,
			failure.message
				? t("bilibili.search.failedWithReason", { reason: failure.message })
				: t("bilibili.search.failed"),
			{ upstreamCode: failure.upstreamCode },
		);
	};

	const uid = /^\d+$/.test(text) ? text : spaceUidOf(text);
	if (uid !== undefined) {
		const res = await api.fetchUserCard(uid);
		if (!res.ok) {
			// -404:B 站说没有这个用户 —— 查了、没有,是成功的空数组。
			if (res.code === "not_found") return ok({ candidates: [] });
			return refuse(res);
		}
		const card = res.data?.card;
		if (!card) return ok({ candidates: [] });
		return ok({
			candidates: [
				{
					externalId: String(card.mid),
					name: card.name,
					...(typeof card.fans === "number" ? { followers: card.fans } : {}),
					...(card.sign ? { bio: card.sign } : {}),
				},
			],
		});
	}

	const res = await api.searchByType("bili_user", text);
	if (!res.ok) return refuse(res);
	const data = res.data as { result?: unknown } | null | undefined;
	const raw = (Array.isArray(data?.result) ? data.result : []) as Array<Record<string, unknown>>;
	const candidates = raw.slice(0, MAX_CANDIDATES).map(
		(r): CreatorCandidate => ({
			externalId: String(r.mid),
			name: stripHtmlTags(String(r.uname ?? "")),
			...(typeof r.fans === "number" ? { followers: r.fans } : {}),
			...(typeof r.usign === "string" && r.usign !== "" ? { bio: r.usign } : {}),
		}),
	);
	return ok({ candidates });
}
