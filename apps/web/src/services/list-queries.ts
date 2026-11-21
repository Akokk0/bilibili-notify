import type { ConnectionView, SubscriptionView } from "@bilibili-notify/contract";
import { queryOptions } from "@tanstack/react-query";
import type { PushTarget } from "../types/domain";
import { api } from "./api";

export const CONNECTIONS_QUERY = queryOptions({
	queryKey: ["connections"] as const,
	queryFn: () => api.get<ConnectionView[]>("/api/connections"),
});

export const SUBSCRIPTIONS_QUERY = queryOptions({
	queryKey: ["subscriptions"] as const,
	queryFn: () => api.get<SubscriptionView[]>("/api/subscriptions"),
});

export const TARGETS_QUERY = queryOptions({
	queryKey: ["targets"] as const,
	queryFn: () => api.get<PushTarget[]>("/api/targets"),
});
