import { createReadStream } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createSerialQueue } from "@bilibili-notify/internal";
import { appendJsonl, isLeftoverName } from "@bilibili-notify/storage";
import { dataPath } from "../runtime/roots.js";

export interface VideoViewsSample {
	sampledAt: string;
	views: number;
}
export interface VideoViewsStore {
	append(key: string, sample: VideoViewsSample): Promise<void>;
	listSamplesSince(key: string, since: string): Promise<VideoViewsSample[]>;
	drop(key: string): Promise<void>;
	clear(): Promise<void>;
	close(): Promise<void>;
}

/** 每小时一条的小型时序；写入、删订阅和整类清空共用写队，防止清空后晚到的写把文件复活。 */
export function createVideoViewsStore(opts: { dataRoot: string }): VideoViewsStore {
	const root = dataPath(opts.dataRoot, "stats", "video-views");
	const writes = createSerialQueue();
	const file = (key: string) => join(root, `${key}.jsonl`);
	const remove = async (key: string) => {
		try {
			await unlink(file(key));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	return {
		append(key, sample) {
			return writes.run("samples", async () => {
				await mkdir(root, { recursive: true });
				await appendJsonl(file(key), [{ sampledAt: sample.sampledAt, views: sample.views }]);
			});
		},
		async listSamplesSince(key, since) {
			const rows: VideoViewsSample[] = [];
			try {
				const reader = createInterface({
					input: createReadStream(file(key), { encoding: "utf8" }),
				});
				for await (const line of reader) {
					try {
						const row: unknown = JSON.parse(line);
						if (!row || typeof row !== "object") continue;
						const { sampledAt, views } = row as Record<string, unknown>;
						if (
							typeof sampledAt !== "string" ||
							!Number.isFinite(Date.parse(sampledAt)) ||
							typeof views !== "number" ||
							!Number.isSafeInteger(views) ||
							views < 0
						)
							continue;
						const at = new Date(sampledAt).toISOString();
						if (at >= since) rows.push({ sampledAt: at, views });
					} catch {
						/* Skip malformed rows without inventing a sample. */
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return rows.sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
		},
		drop: (key) => writes.run("samples", () => remove(key)),
		clear: () =>
			writes.run("samples", async () => {
				let names: string[];
				try {
					names = await readdir(root);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				for (const name of names) {
					if (name.endsWith(".jsonl") && !isLeftoverName(name)) await remove(name.slice(0, -6));
				}
			}),
		close: () => writes.close(),
	};
}
