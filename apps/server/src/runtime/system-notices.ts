/**
 * 开机之后要告诉主人的事(⑧;ADR-0022 决策 3 下 10-01 的 🔗):迁好了、主人要求开的新代没开成、某一版起不来被
 * 启动器退回。存在当前这代 `generation.json` 的 `notices` 里,一条一条记;主人看过就记 `acknowledgedAt`。面板经
 * `GET /api/system/notices` 读没看过的那些,形状是 contract 的 {@link SystemNotice}。
 *
 * 存在代里,所以换了一代(全新开始、重新迁移)就是一张新的清单,新代的「迁好了」会再出现一次。桌面版每次重启换
 * 端口,已读不能放在浏览器里。
 *
 * 读写都在原文上改:读不懂的条目(以后的版本加的种类)清单里不给,但不从盘上抹掉;generation.json 别的格也一样,
 * 那一代以后还要给那个版本用。写都排进一条队:面板连点两下「看过了」,两次读改写不会互相盖掉。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SystemNotice } from "@bilibili-notify/contract";
import { createSerialQueue } from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import { z } from "zod";
import { compareVersions } from "../update/version-order.js";
import { GENERATION_FILE } from "./generations.js";

const base = { id: z.string(), createdAt: z.string(), acknowledgedAt: z.string().optional() };

/** 盘上的一条:contract 的形状,外加看过的时刻。 */
const StoredNoticeSchema = z.discriminatedUnion("kind", [
	z.object({
		...base,
		kind: z.literal("migrated"),
		cardSkinsDropped: z.boolean(),
		masterTargetCleared: z.boolean(),
	}),
	z.object({
		...base,
		kind: z.literal("generation-failed"),
		source: z.enum(["empty", "zero"]),
		message: z.string(),
	}),
	z.object({ ...base, kind: z.literal("rolled-back"), version: z.string() }),
]) satisfies z.ZodType<SystemNotice & { acknowledgedAt?: string }>;

type StoredNotice = z.infer<typeof StoredNoticeSchema>;

/** 记一条时交进来的:id 与时刻由这里盖。 */
type NoticeFields = SystemNotice extends infer N
	? N extends SystemNotice
		? Omit<N, "id" | "createdAt">
		: never
	: never;

export interface SystemNoticeStore {
	/** 记一条新的,交回记下的那条。 */
	append(fields: NoticeFields): Promise<SystemNotice>;
	/** 主人看过了。没有这一条回 false,盘上不动。 */
	acknowledge(id: string): Promise<boolean>;
	/** 没看过的那些,先记的在前;「X 起不来」只给比正在跑的版本新的。 */
	list(): Promise<SystemNotice[]>;
	/**
	 * 启动器判死的版本(`boot-state.json` 的 `failed`)里,比正在跑的新、还没记过的,各记一条「X 起不来」。
	 * 看过的那条不再记 —— 判死名单要等那一版真起来才会放掉它,不然每次开机都冒一条。
	 */
	recordRollbacks(failedVersions: readonly string[]): Promise<void>;
}

export interface SystemNoticeStoreOptions {
	/** 当前那一代的目录(generation.json 所在)。 */
	dir: string;
	/** 正在跑的版本:判「X 起不来」还算不算数。 */
	runningVersion: string;
}

export function createSystemNoticeStore(opts: SystemNoticeStoreOptions): SystemNoticeStore {
	const path = join(opts.dir, GENERATION_FILE);
	const writes = createSerialQueue();
	const newerThanRunning = (version: string) => compareVersions(version, opts.runningVersion) > 0;

	async function readRaw(): Promise<{ raw: Record<string, unknown>; notices: unknown[] }> {
		const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		return { raw, notices: Array.isArray(raw.notices) ? raw.notices : [] };
	}

	const parsed = (notices: readonly unknown[]): StoredNotice[] =>
		notices.flatMap((entry) => {
			const result = StoredNoticeSchema.safeParse(entry);
			return result.success ? [result.data] : [];
		});

	const toWire = ({ acknowledgedAt: _, ...notice }: StoredNotice): SystemNotice => notice;

	return {
		append(fields) {
			return writes.run(path, async () => {
				const { raw, notices } = await readRaw();
				const notice = { ...fields, id: randomUUID(), createdAt: new Date().toISOString() };
				await atomicWriteJson(path, { ...raw, notices: [...notices, notice] });
				return notice as SystemNotice;
			});
		},

		acknowledge(id) {
			return writes.run(path, async () => {
				const { raw, notices } = await readRaw();
				const index = notices.findIndex((entry) => (entry as { id?: unknown })?.id === id);
				if (index < 0) return false;
				const next = notices.map((entry, i) =>
					i === index ? { ...(entry as object), acknowledgedAt: new Date().toISOString() } : entry,
				);
				await atomicWriteJson(path, { ...raw, notices: next });
				return true;
			});
		},

		async list() {
			const { notices } = await readRaw();
			return parsed(notices)
				.filter((notice) => notice.acknowledgedAt === undefined)
				.filter((notice) => notice.kind !== "rolled-back" || newerThanRunning(notice.version))
				.map(toWire);
		},

		recordRollbacks(failedVersions) {
			return writes.run(path, async () => {
				const { raw, notices } = await readRaw();
				const known = new Set(
					parsed(notices).flatMap((notice) =>
						notice.kind === "rolled-back" ? [notice.version] : [],
					),
				);
				const fresh = failedVersions
					.filter((version) => newerThanRunning(version) && !known.has(version))
					.map((version) => ({
						kind: "rolled-back" as const,
						version,
						id: randomUUID(),
						createdAt: new Date().toISOString(),
					}));
				if (fresh.length === 0) return;
				await atomicWriteJson(path, { ...raw, notices: [...notices, ...fresh] });
			});
		},
	};
}
