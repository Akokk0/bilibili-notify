import { type CreatorCandidate, fail, type Logger, type Result } from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { LOOKUP_TIMEOUT_MS } from "../integrations/lookup-timeout.js";
import { errorMessageOf } from "../util/error-message.js";
import type { SourceRegistry } from "./registry.js";

export interface SearchSourceCreatorsDeps {
	sources: Pick<SourceRegistry, "get" | "list">;
	logger: Pick<Logger, "error">;
	/** 最多等多久;默认 {@link LOOKUP_TIMEOUT_MS}(测试里给短的)。 */
	timeoutMs?: number;
}

/**
 * 宿主调某个来源的 `searchCreators` 的外壳(failure-results 第 2 条:抛错只留给 bug,宿主在边界接住):
 * - 按键找来源,不在册回 `not_found`,话里列出在册来源的键与平台名;
 * - 带超时的 `AbortSignal` 去调:宿主不等了就叫停来源手里的 signal,回 `timeout`;
 * - 来源抛了:按 `unavailable` 收,原话只进错误日志,回给人的话是固定的一句;
 * - 来源回的失败(风控、没登录……)原样回,不改码不改话。
 *
 * 起名:`search` 对着来源上的成员名;`lookup` 在命名规范里只用在函数名上、指「查一下」这个动作,而且拓展解析门
 * 的 `lookup` 是另一个口(路由那一支),这里不借。女仆的搜人工具用它,第 4 期面板的搜人路由直接复用。
 */
export async function searchSourceCreators(
	deps: SearchSourceCreatorsDeps,
	sourceKey: string,
	query: string,
): Promise<Result<{ candidates: CreatorCandidate[] }>> {
	const source = deps.sources.get(sourceKey);
	if (!source) {
		const listing = deps.sources
			.list()
			.map((view) => `${view.sourceKey}（${view.descriptor.label}）`)
			.join("、");
		return fail(
			"not_found",
			t("searchCreators.noSuchSource", {
				sourceKey,
				listing: listing === "" ? t("searchCreators.noSourcesListed") : listing,
			}),
		);
	}
	const { label } = source.descriptor;
	const timeoutMs = deps.timeoutMs ?? LOOKUP_TIMEOUT_MS;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Result<{ candidates: CreatorCandidate[] }>>((resolve) => {
		timer = setTimeout(() => {
			// 宿主不等了就叫它停:面板 / 女仆那头已经是一句「超时」,它接着问平台只是白白多挨一次风控。
			controller.abort(
				new DOMException(`搜人超过 ${timeoutMs / 1000} 秒没回,BN 不等了`, "TimeoutError"),
			);
			resolve(fail("timeout", t("searchCreators.timeout", { label, seconds: timeoutMs / 1000 })));
		}, timeoutMs);
	});
	const run = (async (): Promise<Result<{ candidates: CreatorCandidate[] }>> => {
		try {
			return await source.searchCreators(query, controller.signal);
		} catch (err) {
			deps.logger.error(`[source] ${sourceKey} searchCreators 抛了: ${errorMessageOf(err)}`);
			return fail("unavailable", t("searchCreators.failed", { label }));
		}
	})();
	try {
		return await Promise.race([run, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
