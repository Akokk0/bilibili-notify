import type { DestinationStatus, Json, KeyValueStore, Result } from "@bilibili-notify/internal";
import type { QQOfficialConnectionSettings } from "./qq-official-settings.js";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Asia/Shanghai",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

function qqUsageKey(settings: QQOfficialConnectionSettings, group: string): string {
	return `atAllUsage.${settings.sandbox ? "sandbox" : "live"}.${settings.appId}.${group}`;
}

type Usage = NonNullable<DestinationStatus["atAllUsage"]>;
type RecordState = Exclude<Usage["state"], "not-recorded">;
type UsageRecord = { date: string; state: RecordState };
const strength: Record<RecordState, number> = { indeterminate: 1, used: 2, exhausted: 3 };

function savedRecord(value: Json | undefined): UsageRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return undefined;
	if (value.state !== "used" && value.state !== "exhausted" && value.state !== "indeterminate")
		return undefined;
	return { date: value.date, state: value.state };
}

/** 保存失败时仍保留本进程已知事实；同群写入串行，迟到的旧日结果不覆盖新日。 */
export function createQQAtAllUsage(onWriteFailure: (message: string) => void) {
	const memory = new Map<string, UsageRecord>();
	const pending = new Map<string, Promise<void>>();
	function known(store: KeyValueStore, key: string) {
		return memory.get(key) ?? savedRecord(store.get(key));
	}
	return {
		read(store: KeyValueStore, settings: QQOfficialConnectionSettings, group: string): Usage {
			const date = dateFormatter.format(new Date());
			const entry = known(store, qqUsageKey(settings, group));
			return {
				state: entry?.date === date ? entry.state : "not-recorded",
				date,
				timezone: "Asia/Shanghai",
				source: "bn",
			};
		},
		async record(
			store: KeyValueStore,
			settings: QQOfficialConnectionSettings,
			group: string,
			result: Result,
			submittedAt: number,
		): Promise<void> {
			const state: RecordState | undefined = result.ok
				? "pendingAudit" in result && result.pendingAudit === true
					? "indeterminate"
					: "used"
				: result.upstreamCode === 304019
					? "exhausted"
					: result.code === "indeterminate"
						? "indeterminate"
						: undefined;
			if (!state) return;
			const key = qqUsageKey(settings, group);
			const next: UsageRecord = { date: dateFormatter.format(new Date(submittedAt)), state };
			const job = (pending.get(key) ?? Promise.resolve()).then(async () => {
				const before = known(store, key);
				if (
					before &&
					(before.date > next.date ||
						(before.date === next.date && strength[before.state] >= strength[next.state]))
				)
					return;
				memory.delete(key);
				memory.set(key, next);
				while (memory.size > 2048) memory.delete(memory.keys().next().value as string);
				const written = await store.set(key, next);
				if (!written.ok) onWriteFailure(written.message);
			});
			pending.set(key, job);
			try {
				await job;
			} finally {
				if (pending.get(key) === job) pending.delete(key);
			}
		},
	};
}
