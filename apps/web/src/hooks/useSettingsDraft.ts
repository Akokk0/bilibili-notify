import { useCallback, useEffect } from "react";
import { useResourceState } from "../components/library/resource-drafts";

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** 草稿的显式 null 删除键，缺席的键沿用旧值，数组整体替换。 */
export function mergeSettingsDraft<T>(base: T, patch: Record<string, unknown>): T {
	if (!record(patch)) return patch as T;
	const merged = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch)) {
		const previous = merged[key];
		if (value === null) delete merged[key];
		else if (record(previous) && record(value)) merged[key] = mergeSettingsDraft(previous, value);
		else merged[key] = value;
	}
	return merged as T;
}

/** 新快照只更新未编辑的格；本地删除和数组替换同样是编辑，不能被后台刷新抹掉。 */
function rebase(previous: unknown, draft: unknown, next: unknown): unknown {
	if (JSON.stringify(previous) === JSON.stringify(draft)) return next;
	if (!record(previous) || !record(draft) || !record(next)) return draft;
	const merged: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(draft), ...Object.keys(next)])) {
		if (!(key in draft) && key in previous) continue;
		const value = rebase(previous[key], draft[key], next[key]);
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

export function useSettingsDraft<T>(baseline: T | undefined, resourceKey?: string) {
	const [state, setState] = useResourceState<{
		key: string | undefined;
		previous: T | undefined;
		draft: T | null;
	}>(resourceKey, { key: resourceKey, previous: undefined, draft: null });
	useEffect(() => {
		if (baseline === undefined) return;
		setState(({ key, previous, draft }) => ({
			key: resourceKey,
			previous: baseline,
			draft:
				key !== resourceKey || draft === null || previous === undefined
					? baseline
					: (rebase(previous, draft, baseline) as T),
		}));
	}, [baseline, setState, resourceKey]);
	const setDraft = useCallback(
		(next: T | null | ((current: T | null) => T | null)) =>
			setState((state) => ({
				...state,
				draft:
					typeof next === "function"
						? (next as (current: T | null) => T | null)(state.draft)
						: next,
			})),
		[setState],
	);
	return [state.draft, setDraft] as const;
}
