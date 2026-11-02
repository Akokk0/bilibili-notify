import type { ProblemsResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { api } from "../services/api";
export const PROBLEMS_QUERY_KEY = ["problems"] as const;
export function useProblems() {
	return useQuery({
		queryKey: PROBLEMS_QUERY_KEY,
		queryFn: () => api.get<ProblemsResponse>("/api/problems"),
		retry: false,
	});
}
