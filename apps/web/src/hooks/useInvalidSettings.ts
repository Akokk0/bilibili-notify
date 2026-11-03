import type { InvalidSettingsResponse } from "@bilibili-notify/contract";
import { useQuery } from "@tanstack/react-query";
import { useTextOptions } from "../i18n";
import { api } from "../services/api";

export const INVALID_SETTINGS_QUERY_PREFIX = ["invalid-settings"] as const;
export function useInvalidSettings(path: string) {
	const { locale, voice } = useTextOptions();
	return useQuery({
		queryKey: [...INVALID_SETTINGS_QUERY_PREFIX, path, locale, voice],
		queryFn: () => api.get<InvalidSettingsResponse>(path),
		retry: false,
	});
}
