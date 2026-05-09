import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../services/api";
import { useAuthStore } from "../store/auth";
import type { LoginSnapshot } from "../types/auth";

/**
 * Initial hydrate. We only hit /api/auth/status on first mount — afterwards
 * `useAuthChannel` keeps the store fresh via WS. If the socket reconnects,
 * the server publishes the latest snapshot on subscribe, so no extra REST
 * round-trip is needed here.
 */
export function useAuthHydrate(): void {
	const { data } = useQuery({
		queryKey: ["auth-status"],
		queryFn: () => api.get<LoginSnapshot>("/api/auth/status"),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	useEffect(() => {
		if (data) useAuthStore.getState().setSnapshot(data);
	}, [data]);
}
