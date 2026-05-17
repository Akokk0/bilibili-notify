import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
	HistoryEntry,
	HistoryPayload,
	HistorySource,
	Logger,
	MessageBus,
	NotificationPayload,
} from "@bilibili-notify/internal";
import { HistoryEntrySchema } from "@bilibili-notify/internal";

/**
 * jsonl-by-day history persistence + bus emission.
 *
 * Each successful or failed sink dispatch produces a single {@link HistoryEntry}
 * appended to `<dataDir>/history/<YYYY-MM-DD>.jsonl`. After the append the
 * store emits `history-recorded` on the bus so the WS `push-events` channel
 * fans the entry out to connected dashboards.
 *
 * Image bytes are written to `<dataDir>/history/img/<entryId>.<ext>` with the
 * relative file name stored in `payload.imageRef`. The dashboard reads the
 * blob via the static fileserver mounted on `/history-img/*`.
 *
 * Append-only design — entries are never updated in place. The retention pass
 * (see `retention.ts`) drops day files older than the configured horizon.
 */

export interface HistoryAppendInput {
	source: HistorySource;
	uid: string;
	subscriptionId: string;
	targets: Array<{ targetId: string; ok: boolean; latencyMs: number; err?: string }>;
	payload: NotificationPayload;
	/** Snapshot of sub.cachedProfile.name at write time; survives订阅删除。 */
	unameSnapshot?: string;
	/** Snapshot of sub.cachedProfile.avatar at write time。 */
	uavatarSnapshot?: string;
}

export interface HistoryQuery {
	limit?: number;
	since?: string;
	source?: HistorySource;
	uid?: string;
}

export interface HistoryStore {
	append(input: HistoryAppendInput): Promise<HistoryEntry>;
	query(opts: HistoryQuery): Promise<HistoryEntry[]>;
	imageDir(): string;
}

export interface CreateHistoryStoreOptions {
	dataDir: string;
	bus: MessageBus;
	logger: Logger;
}

export function createHistoryStore(opts: CreateHistoryStoreOptions): HistoryStore {
	const root = join(opts.dataDir, "history");
	const imgRoot = join(root, "img");

	async function ensureDirs(): Promise<void> {
		await mkdir(root, { recursive: true });
		await mkdir(imgRoot, { recursive: true });
	}

	function dayFile(dateIso: string): string {
		// YYYY-MM-DDTHH:MM:SS.sssZ → YYYY-MM-DD
		return join(root, `${dateIso.slice(0, 10)}.jsonl`);
	}

	async function writeImage(entryId: string, buffer: Buffer, mime: string): Promise<string> {
		const ext = mimeToExt(mime);
		const name = `${entryId}.${ext}`;
		await writeFile(join(imgRoot, name), buffer);
		return name;
	}

	async function reduce(payload: NotificationPayload, entryId: string): Promise<HistoryPayload> {
		switch (payload.kind) {
			case "text":
				return { kind: "text", text: payload.text };
			case "image": {
				const imageRef = await writeImage(entryId, payload.image.buffer, payload.image.mime);
				return { kind: "image", text: payload.caption, imageRef };
			}
			case "composite": {
				const textParts: string[] = [];
				let imageRef: string | undefined;
				let imageIdx = 0;
				for (const seg of payload.segments) {
					if (seg.type === "text") {
						textParts.push(seg.text);
					} else if (seg.type === "image" && !imageRef) {
						const name = `${entryId}-${imageIdx++}.${mimeToExt(seg.mime)}`;
						await writeFile(join(imgRoot, name), seg.buffer);
						imageRef = name;
					} else if (seg.type === "link") {
						textParts.push(seg.title ? `${seg.title} ${seg.href}` : seg.href);
					}
				}
				return {
					kind: "composite",
					text: textParts.join("\n"),
					imageRef,
				};
			}
		}
	}

	async function append(input: HistoryAppendInput): Promise<HistoryEntry> {
		await ensureDirs();
		const id = randomUUID();
		const ts = new Date().toISOString();
		const payload = await reduce(input.payload, id);
		const entry: HistoryEntry = {
			id,
			ts,
			source: input.source,
			uid: input.uid,
			subscriptionId: input.subscriptionId,
			targetIds: input.targets.map((t) => t.targetId),
			result: {
				ok: input.targets.every((t) => t.ok),
				per: input.targets,
			},
			payload,
			unameSnapshot: input.unameSnapshot,
			uavatarSnapshot: input.uavatarSnapshot,
		};
		// Defensive validation — schema mismatches are programmer errors, but
		// recording corrupt jsonl is worse than rejecting the write.
		const parsed = HistoryEntrySchema.safeParse(entry);
		if (!parsed.success) {
			opts.logger.error(
				`[history] entry rejected by schema, dropping: ${JSON.stringify(parsed.error.issues)}`,
			);
			throw new Error("history entry schema validation failed");
		}
		const line = `${JSON.stringify(parsed.data)}\n`;
		await writeFile(dayFile(ts), line, { flag: "a", encoding: "utf8" });
		opts.bus.emit("history-recorded", parsed.data);
		return parsed.data;
	}

	async function query(q: HistoryQuery): Promise<HistoryEntry[]> {
		await ensureDirs();
		const limit = Math.min(q.limit ?? 100, 500);
		const sinceMs = q.since ? Date.parse(q.since) : Number.NEGATIVE_INFINITY;
		const out: HistoryEntry[] = [];

		// List day files, newest first.
		let files: string[];
		try {
			const all = await readdir(root);
			files = all
				.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
				.sort()
				.reverse();
		} catch {
			return [];
		}

		for (const file of files) {
			const path = join(root, file);
			const collected = await readJsonl(path);
			// In-file is chronological (append-only); reverse so newest first per day.
			for (let i = collected.length - 1; i >= 0; i--) {
				const entry = collected[i];
				if (!entry) continue;
				if (Date.parse(entry.ts) <= sinceMs) continue;
				if (q.source && entry.source !== q.source) continue;
				if (q.uid && entry.uid !== q.uid) continue;
				out.push(entry);
				if (out.length >= limit) return out;
			}
		}
		return out;
	}

	async function readJsonl(path: string): Promise<HistoryEntry[]> {
		const out: HistoryEntry[] = [];
		try {
			const stream = createReadStream(path, { encoding: "utf8" });
			const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
			for await (const line of rl) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);
					const r = HistoryEntrySchema.safeParse(parsed);
					if (r.success) out.push(r.data);
				} catch {
					// skip malformed line
				}
			}
		} catch {
			// missing file is fine
		}
		return out;
	}

	return {
		append,
		query,
		imageDir: () => imgRoot,
	};
}

function mimeToExt(mime: string): string {
	const m = mime.toLowerCase();
	if (m.includes("png")) return "png";
	if (m.includes("webp")) return "webp";
	if (m.includes("gif")) return "gif";
	return "jpg";
}

/** Internal helper used by retention.ts. */
export async function listDayFiles(dataDir: string): Promise<string[]> {
	const root = join(dataDir, "history");
	try {
		const all = await readdir(root);
		return all.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
	} catch {
		return [];
	}
}

/** Internal helper used by retention.ts. */
export async function deleteDayFile(dataDir: string, fileName: string): Promise<void> {
	await unlink(join(dataDir, "history", fileName));
}
