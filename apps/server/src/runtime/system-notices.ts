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
 *
 * 升级之后的「本次更新」(`updated`):开机时比较正在跑的版本与这一代**跑过的最高版本**,更高就记一条。
 * 跑过的最高版本不另存一格 —— 它恒等于 `max(createdBy, 清单里每条 updated 的版本)`(每次升级都会记一条,
 * 看过的也留着),所以只往高走:升到 1.1 又退回 1.0.1 再升回 1.1,不会再弹一次(「每个版本一次」)。
 * 说明文字(概述、⚠️ 段)盘上不存,读清单那一刻从载荷里的数据文件现补,所以以后按语言取不用迁移。
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseNoteEntry, SystemNotice } from "@bilibili-notify/contract";
import { createSerialQueue } from "@bilibili-notify/internal";
import { atomicWriteJson } from "@bilibili-notify/storage";
import { z } from "zod";
import { releasesBetween } from "../update/release-notes.js";
import { releaseUrlOf } from "../update/trusted-keys.js";
import { compareVersions, isDevBuild } from "../update/version-order.js";
import { GENERATION_FILE } from "./generations.js";

const base = { id: z.string(), createdAt: z.string(), acknowledgedAt: z.string().optional() };

/**
 * 盘上的一条:contract 的形状,外加看过的时刻。与线上不同的两处:`migrated` 不存版本与说明(版本取
 * `generation.json` 的 `createdBy`,说明现补);`updated` 存比较的基线 `from`(不存说明)。
 */
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
	z.object({ ...base, kind: z.literal("updated"), version: z.string(), from: z.string() }),
]);

type StoredNotice = z.infer<typeof StoredNoticeSchema>;

/** 记一条时交进来的(盘上的形状):id 与时刻由这里盖。 */
type NoticeFields = StoredNotice extends infer N
	? N extends StoredNotice
		? Omit<N, "id" | "createdAt" | "acknowledgedAt">
		: never
	: never;

export interface SystemNoticeStore {
	/** 记一条新的,交回记下的那条(线上的形状,说明已现补)。 */
	append(fields: NoticeFields): Promise<SystemNotice>;
	/** 主人看过了。没有这一条回 false,盘上不动。 */
	acknowledge(id: string): Promise<boolean>;
	/** 没看过的那些,先记的在前;「X 起不来」只给比正在跑的版本新的,「更新了」只给不比它新的。 */
	list(): Promise<SystemNotice[]>;
	/**
	 * 开机比较:正在跑的版本比这一代跑过的最高版本新,就记一条「更新了」,范围从那个版本之后算起。
	 * 上一条「更新了」还没看过又升了一版 → 合成一条:新的从旧那条没看过的起点算起,旧的标看过。
	 * 开发版什么都不记;一样或更旧(被退回)也不记。
	 */
	recordUpdate(): Promise<void>;
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
	/**
	 * 载荷里的更新说明(`readReleaseNotes` 读出来的)。缺省空表:只追加的调用方(开新代失败、迁好了)不用管,
	 * 但那样交出去的 `migrated` / `updated` 就没有说明。
	 */
	releaseNotes?: readonly Omit<ReleaseNoteEntry, "releaseUrl">[];
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

	/** `from < v ≤ to` 的各版说明,每条补上发布页地址。 */
	const releasesFor = (from: string, to: string): ReleaseNoteEntry[] =>
		releasesBetween(opts.releaseNotes ?? [], from, to).map((entry) => ({
			...entry,
			releaseUrl: releaseUrlOf(entry.version),
		}));

	/** 开出这一代的版本;读不到(不是字符串)就拿正在跑的版本顶。 */
	const createdByOf = (raw: Record<string, unknown>) =>
		typeof raw.createdBy === "string" ? raw.createdBy : undefined;

	/**
	 * 盘上 → 线上:去掉看过的时刻,现补说明。`migrated` 的说明范围是 1.0 起到开出这一代的那一版
	 * (载荷里只收 1.x 的段,所以从 0.0.0 数起就是「1.0 起」)。
	 */
	const toWire = (notice: StoredNotice, raw: Record<string, unknown>): SystemNotice => {
		const { id, createdAt } = notice;
		switch (notice.kind) {
			case "migrated": {
				const version = createdByOf(raw) ?? opts.runningVersion;
				return {
					id,
					createdAt,
					kind: "migrated",
					cardSkinsDropped: notice.cardSkinsDropped,
					masterTargetCleared: notice.masterTargetCleared,
					version,
					releases: releasesFor("0.0.0", version),
				};
			}
			case "updated":
				return {
					id,
					createdAt,
					kind: "updated",
					version: notice.version,
					releases: releasesFor(notice.from, notice.version),
				};
			case "generation-failed":
				return {
					id,
					createdAt,
					kind: "generation-failed",
					source: notice.source,
					message: notice.message,
				};
			case "rolled-back":
				return { id, createdAt, kind: "rolled-back", version: notice.version };
		}
	};

	return {
		append(fields) {
			return writes.run(path, async () => {
				const { raw, notices } = await readRaw();
				const notice = {
					...fields,
					id: randomUUID(),
					createdAt: new Date().toISOString(),
				} as StoredNotice;
				await atomicWriteJson(path, { ...raw, notices: [...notices, notice] });
				return toWire(notice, raw);
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
			const { raw, notices } = await readRaw();
			return parsed(notices)
				.filter((notice) => notice.acknowledgedAt === undefined)
				.filter((notice) => notice.kind !== "rolled-back" || newerThanRunning(notice.version))
				.filter((notice) => notice.kind !== "updated" || !newerThanRunning(notice.version))
				.map((notice) => toWire(notice, raw));
		},

		recordUpdate() {
			return writes.run(path, async () => {
				if (isDevBuild(opts.runningVersion)) return;
				const { raw, notices } = await readRaw();
				const stored = parsed(notices);
				const updates = stored.flatMap((notice) => (notice.kind === "updated" ? [notice] : []));
				// 跑过的最高版本:开出这一代的版本,与每条「更新了」记下的版本里最高的那个。
				const createdBy = createdByOf(raw);
				const ran = [...(createdBy ? [createdBy] : []), ...updates.map((n) => n.version)];
				const highest = ran.reduce<string | undefined>(
					(top, v) => (top === undefined || compareVersions(v, top) > 0 ? v : top),
					undefined,
				);
				if (highest === undefined || compareVersions(opts.runningVersion, highest) <= 0) return;

				// 没看过的旧「更新了」并进新的这一条:范围从其中最早的起点算起,旧的标看过。
				const unseen = updates.filter((notice) => notice.acknowledgedAt === undefined);
				const from = unseen.reduce(
					(low, notice) => (compareVersions(notice.from, low) < 0 ? notice.from : low),
					highest,
				);
				const now = new Date().toISOString();
				const unseenIds = new Set(unseen.map((notice) => notice.id));
				const marked = notices.map((entry) =>
					unseenIds.has((entry as { id?: string })?.id ?? "")
						? { ...(entry as object), acknowledgedAt: now }
						: entry,
				);
				const fresh = {
					kind: "updated" as const,
					version: opts.runningVersion,
					from,
					id: randomUUID(),
					createdAt: now,
				};
				await atomicWriteJson(path, { ...raw, notices: [...marked, fresh] });
			});
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
