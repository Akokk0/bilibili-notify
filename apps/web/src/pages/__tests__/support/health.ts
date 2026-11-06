import type {
	IntegrationHealthView,
	RunningHealthDetailsResponse,
} from "@bilibili-notify/contract";

export function runningHealth(
	over: Partial<RunningHealthDetailsResponse> = {},
): RunningHealthDetailsResponse {
	return {
		phase: "running",
		core: {
			problemCount: 0,
			items: [
				{ key: "storage", version: "0.7.0", status: "running", light: "green" },
				{ key: "subscription", version: "0.7.1", status: "running", light: "green", count: 1 },
				{ key: "push", version: "0.7.2", status: "running", light: "green", count: 3 },
				{ key: "image", version: "0.7.3", status: "not-ready", light: "gray" },
				{ key: "ai", version: "0.7.4", status: "running", light: "green" },
			],
		},
		integrations: [],
		identityDuplicates: [],
		problemCount: 0,
		moduleVersions: {
			storage: "0.7.0",
			subscription: "0.7.1",
			push: "0.7.2",
			image: "0.7.3",
			ai: "0.7.4",
		},
		modules: { dynamic: true, live: false, image: false, ai: true },
		configScopes: {
			globals: { exists: true, lastUpdatedAt: null },
			subscriptions: { exists: true, lastUpdatedAt: null, count: 1 },
			targets: { exists: true, lastUpdatedAt: null, count: 3 },
		},
		...over,
	};
}
export function integrationHealth(
	over: Partial<IntegrationHealthView> = {},
): IntegrationHealthView {
	return {
		key: "acme.source",
		kind: "extension",
		descriptor: { label: "测试来源", shortLabel: "测", icon: "library", color: "#00aeec" },
		status: "running",
		light: "green",
		problemCount: 0,
		connectionCount: 0,
		sourceKey: "acme.source",
		provides: ["subscription"],
		...over,
	};
}
