import type {
	CoreHealthView,
	HealthLightStatus,
	IdentityDuplicateView,
	IntegrationHealthView,
	ModuleState,
	RunningHealthDetailsResponse,
	SourceRunStatus,
} from "@bilibili-notify/contract";
import type { Subscription } from "@bilibili-notify/internal";
import {
	type Connection,
	fail,
	type Logger,
	manifestProvides,
	ok,
	type Problem,
} from "@bilibili-notify/internal";
import { findIdentityDuplicates } from "@bilibili-notify/subscription";
import { type ExtensionEntry, entryIdentity } from "../extensions/loader.js";
import { logText, t } from "../i18n/index.js";
import type { PlatformAdapterRegistry } from "../push/registry.js";
import type { SourceRegistry, SourceView } from "../subscriptions/registry.js";
import type { SubscriptionStateStore } from "./subscription-state-store.js";

/** 核心格只报告已知的接入事实,问题不按文字猜分给某一格。 */
export function coreHealthViews(options: {
	versions: RunningHealthDetailsResponse["moduleVersions"];
	modules: ModuleState;
	pipelineReady: boolean;
	subscriptions: number;
	targets: number;
}): CoreHealthView[] {
	return (["storage", "subscription", "push", "image", "ai"] as const).map((key) => {
		const ready =
			key === "storage" ||
			(key === "image" || key === "ai" ? options.modules[key] : options.pipelineReady);
		return {
			key,
			version: options.versions[key],
			status: ready ? "running" : "not-ready",
			light: ready ? "green" : "gray",
			...(key === "subscription"
				? { count: options.subscriptions }
				: key === "push"
					? { count: options.targets }
					: {}),
		};
	});
}

const FAILED_STATUSES = new Set<SourceRunStatus>([
	"failed",
	"blocked",
	"incompatible",
	"unreadable",
	"settings-invalid",
]);

function lightOf(status: SourceRunStatus, count: number): HealthLightStatus {
	if (FAILED_STATUSES.has(status)) return "red";
	return status === "running" ? (count > 0 ? "orange" : "green") : "gray";
}

export function integrationHealthViews(options: {
	sources: SourceRegistry;
	adapters: PlatformAdapterRegistry;
	extensions: readonly ExtensionEntry[];
	connections: readonly Connection[];
	problems: readonly Problem[];
	logger: Pick<Logger, "error">;
}): IntegrationHealthView[] {
	const views: IntegrationHealthView[] = [];
	const extensionIds = new Set(options.extensions.map((entry) => entry.id));
	const healthOf = (view: SourceView | undefined): Pick<IntegrationHealthView, "health"> => {
		if (!view?.health) return {};
		try {
			return { health: ok({ summary: view.health().summary }) };
		} catch (err) {
			options.logger.error(logText("log.health.sourceThrew"), { error: err });
			return { health: fail("unavailable", t("health.sourceReadFailed")) };
		}
	};
	for (const run of options.sources.listRunViews()) {
		if (extensionIds.has(run.sourceKey)) continue;
		const problemCount = options.problems.filter(
			(problem) => problem.reporter === run.sourceKey,
		).length;
		const { label, shortLabel, color, icon } = run.descriptor;
		views.push({
			key: run.sourceKey,
			kind: "builtin-source",
			descriptor: {
				label,
				...(shortLabel ? { shortLabel } : {}),
				...(color ? { color } : {}),
				...(icon ? { icon } : {}),
			},
			provides: ["subscription"],
			sourceKey: run.sourceKey,
			status: run.status,
			light: lightOf(run.status, problemCount),
			problemCount,
			connectionCount: 0,
			...(run.failure ? { failure: run.failure } : {}),
			...healthOf(options.sources.get(run.sourceKey)),
		});
	}

	for (const adapter of options.adapters.list()) {
		if (extensionIds.has(adapter.adapterKey)) continue;
		const connectionCount = options.connections.filter(
			(connection) => connection.adapterKey === adapter.adapterKey,
		).length;
		if (connectionCount === 0) continue;
		const problemCount = options.problems.filter(
			(problem) => problem.reporter === adapter.adapterKey,
		).length;
		const { label, shortLabel, color, icon } = adapter.descriptor();
		views.push({
			key: adapter.adapterKey,
			kind: "builtin-adapter",
			descriptor: {
				label,
				...(shortLabel ? { shortLabel } : {}),
				...(color ? { color } : {}),
				...(icon ? { icon } : {}),
			},
			provides: ["push"],
			adapterKey: adapter.adapterKey,
			status: "running",
			light: lightOf("running", problemCount),
			problemCount,
			connectionCount,
		});
	}
	for (const entry of options.extensions) {
		const provides = entry.manifest && manifestProvides(entry.manifest);
		const connectionCount = options.connections.filter(
			(connection) => connection.adapterKey === entry.id,
		).length;
		if (provides?.length === 1 && provides[0] === "push" && connectionCount === 0) continue;
		const identity = entryIdentity(entry);
		const source = entry.manifest?.contributes.subscription;
		const push = entry.manifest?.contributes.push;
		const shortLabel = source?.shortLabel ?? push?.shortLabel;
		const color = source?.color ?? push?.color;
		const icon = identity?.icon ?? source?.icon ?? push?.icon;
		const problemCount = options.problems.filter((problem) => problem.reporter === entry.id).length;
		views.push({
			key: entry.id,
			kind: "extension",
			descriptor: {
				label: identity?.name ?? entry.id,
				...(shortLabel ? { shortLabel } : {}),
				...(color ? { color } : {}),
				...(icon ? { icon } : {}),
			},
			...(provides ? { provides } : {}),
			status: entry.state,
			light: lightOf(entry.state, problemCount),
			problemCount,
			connectionCount,
			...(provides?.includes("subscription") ? { sourceKey: entry.id } : {}),
			...(provides?.includes("push") ? { adapterKey: entry.id } : {}),
			...(entry.detail ? { failure: fail("unavailable", entry.detail) } : {}),
			...healthOf(options.sources.get(entry.id)),
		});
	}
	return views;
}

export function identityDuplicateViews(
	subscriptions: readonly Subscription[],
	profiles: Pick<SubscriptionStateStore, "get">,
): IdentityDuplicateView[] {
	return findIdentityDuplicates(subscriptions).map((group) => {
		const subscriptionIds = group.subscriptions.map((subscription) => subscription.id);
		const name = subscriptionIds
			.map((id) => profiles.get(id)?.cachedProfile?.name)
			.find((value) => value !== undefined);
		return { identity: group.identity, subscriptionIds, ...(name === undefined ? {} : { name }) };
	});
}
