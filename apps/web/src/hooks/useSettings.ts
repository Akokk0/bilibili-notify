/**
 * `/api/settings` 的那一份 react-query 缓存,与改设置的两个口。
 *
 * 读它的地方有十几处,必须共用**同一个 key 与同一个取法**:缓存里存的是整份回话(`{ core, <集成键>… }`),
 * 只要核心那份的用 {@link useCoreSettings}(`select` 挑出 `core`,不改缓存的形状),系统页要 B 站那几格的读整份。
 * 各写各的 queryFn 的话,先拉的那一处决定缓存里是什么形状,别处读到的就是另一个形状。
 */

import type { GlobalConfigView, SettingsResponse } from "@bilibili-notify/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../services/api";
import type { GlobalConfigPatch, SettingsPatch } from "../types/globals";

/** `/api/settings` 的 react-query 键(失效、乐观写都认它)。 */
export const SETTINGS_KEY = ["settings"] as const;

/** 问 `/api/settings` 的整份选项,连 queryFn 一起。 */
export const SETTINGS_QUERY = queryOptions({
	queryKey: SETTINGS_KEY,
	queryFn: () => api.get<SettingsResponse>("/api/settings"),
});

const coreOf = (settings: SettingsResponse): GlobalConfigView => settings.core;

/** 整份设置(核心那份在 `core` 下,各集成的挂在自己的键下)。 */
export function useSettings() {
	return useQuery(SETTINGS_QUERY);
}

/** 核心那份设置。 */
export function useCoreSettings() {
	return useQuery({ ...SETTINGS_QUERY, select: coreOf });
}

/** 改设置:核心那份的补丁在 `core` 下,各集成的挂在自己的键下。回的是改完的整份。 */
export function patchSettings(patch: SettingsPatch): Promise<SettingsResponse> {
	return api.patch<SettingsResponse>("/api/settings", patch);
}

/** 只改核心那份。 */
export function patchCoreSettings(patch: GlobalConfigPatch): Promise<SettingsResponse> {
	return patchSettings({ core: patch });
}
