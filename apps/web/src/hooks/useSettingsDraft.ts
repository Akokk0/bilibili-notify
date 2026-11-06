import { useEffect, useRef, useState } from "react";

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

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

export function useSettingsDraft<T>(baseline: T | undefined) {
	const previous = useRef<T | undefined>(undefined);
	const [draft, setDraft] = useState<T | null>(null);
	useEffect(() => {
		if (baseline === undefined) return;
		const old = previous.current;
		setDraft((current) =>
			current === null || old === undefined ? baseline : (rebase(old, current, baseline) as T),
		);
		previous.current = baseline;
	}, [baseline]);
	return [draft, setDraft] as const;
}
