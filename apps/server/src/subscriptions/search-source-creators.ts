import { type CreatorCandidate, fail, type Logger, type Result } from "@bilibili-notify/internal";
import { t } from "../i18n/index.js";
import { LOOKUP_TIMEOUT_MS } from "../integrations/lookup-timeout.js";
import { callSource, type SourceGates } from "./call-source.js";
import type { SourceRegistry } from "./registry.js";

export interface SearchSourceCreatorsDeps {
	sources: Pick<SourceRegistry, "get" | "list">;
	logger: Pick<Logger, "error">;
	/** 最多等多久;默认 {@link LOOKUP_TIMEOUT_MS}(测试里给短的)。 */
	timeoutMs?: number;
	/** 按来源键的串行闸(宿主里一份,与查直播状态共用);不给就不排队。 */
	gates?: SourceGates;
}

/**
 * 宿主调某个来源的 `searchCreators`:
 * - 按键找来源,不在册回 `not_found`,话里列出在册来源的键与平台名;
 * - 超时、抛错的收口是公共的 {@link callSource}(与查直播状态共用):宿主不等了就叫停来源手里的 signal,回
 *   `timeout`;来源抛了按 `unavailable` 收,原话只进错误日志,回给人的话是固定的一句;
 * - 来源回的失败(风控、没登录……)原样回,不改码不改话。
 *
 * 起名:`search` 对着来源上的成员名;`lookup` 在命名规范里只用在函数名上、指「查一下」这个动作,这里不借。
 * 女仆的搜人工具与面板的搜人口(`GET /api/sources/:sourceKey/creators`)都经推送链路的 `searchCreators` 用它。
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
	const call = () =>
		callSource<Result<{ candidates: CreatorCandidate[] }>>({
			logger: deps.logger,
			sourceKey,
			member: "searchCreators",
			timeoutMs,
			call: (signal) => source.searchCreators(query, signal),
			onTimeout: () =>
				fail("timeout", t("searchCreators.timeout", { label, seconds: timeoutMs / 1000 })),
			onThrow: () => fail("unavailable", t("searchCreators.failed", { label })),
		});
	// 同一来源串行调用(`Source.searchCreators` 的约定):给了闸就排队,没给(单测)直接调。
	return deps.gates ? deps.gates.run(sourceKey, call) : call();
}
