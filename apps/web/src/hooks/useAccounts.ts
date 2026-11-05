import type { AccountsResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";

export const ACCOUNTS_QUERY_KEY = ["accounts"] as const;

/** The server orders registered login sources; all consumers share this snapshot. */
export function useAccounts({ enabled = true }: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: ACCOUNTS_QUERY_KEY,
		queryFn: () => api.get<AccountsResponse>("/api/accounts"),
		enabled,
	});
}

export function usePrimaryAccount() {
	const query = useAccounts();
	return query.isError ? undefined : query.data?.accounts?.[0];
}
