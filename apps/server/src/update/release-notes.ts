/**
 * 升级之后「本次更新」要念的说明。
 *
 * 数据在载荷旁的 `release-notes.json`:装配时(`scripts/assemble-server-bundle.mjs`)从 `apps/CHANGELOG.md`
 * 抽 1.0 起各版的概述与 ⚠️ 段,所以不走应用内更新的人(拉镜像、重装桌面)也有。属于载荷的东西相对载荷入口解析
 * (`config/web-dist.ts` 的 `payloadDirOf`)。
 *
 * 注意 `summary` / `caution` 是 **markdown 原文**,和更新清单里通知卡念的纯文字 `notes` 不是一回事。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseNoteEntry } from "@bilibili-notify/contract";
import type { Logger } from "@bilibili-notify/internal";
import { z } from "zod";
import { errorMessageOf } from "../util/error-message.js";
import { compareVersions, isDevBuild, isPrerelease } from "./version-order.js";

/** 与 `scripts/server-bundle-assets.mjs` 的 `RELEASE_NOTES_FILE` 同名 —— 那边是 .mjs,这边引不到。 */
const RELEASE_NOTES_FILE = "release-notes.json";

const FileSchema = z.object({
	releases: z.array(
		z.object({
			version: z.string(),
			date: z.string().optional(),
			summary: z.string(),
			caution: z.string().optional(),
		}),
	),
});

export interface ReadReleaseNotesInput {
	/** 载荷所在的目录。 */
	payloadDir: string;
	/** 正在跑的版本:开发版没有这份文件是常态,不出声。 */
	runningVersion: string;
	logger: Logger;
}

/**
 * 读载荷里的更新说明。缺了或读不懂都给空表(弹窗只剩标题,不拦开机),并在日志里说清原因 ——
 * 开发版源码里从不装配,缺文件是常态,不出声。
 */
export async function readReleaseNotes(
	input: ReadReleaseNotesInput,
): Promise<Omit<ReleaseNoteEntry, "releaseUrl">[]> {
	const path = join(input.payloadDir, RELEASE_NOTES_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (!isDevBuild(input.runningVersion)) {
			input.logger.warn(
				`[update] 载荷里没有 ${RELEASE_NOTES_FILE},「本次更新」只会有标题:${path}(${(error as NodeJS.ErrnoException).code ?? "读不了"})`,
			);
		}
		return [];
	}
	try {
		return FileSchema.parse(JSON.parse(text)).releases;
	} catch (error) {
		input.logger.warn(
			`[update] ${RELEASE_NOTES_FILE} 读不懂,「本次更新」只会有标题:${errorMessageOf(error)}`,
		);
		return [];
	}
}

const coreOf = (version: string) => version.split("-", 1)[0] ?? version;

/**
 * `from < v ≤ to` 跨过了哪几版,新的在前(先后按 {@link compareVersions},不看文件里的次序)。
 *
 * 同号的正式版盖掉它自己的预发布段:范围里同时有 1.1.0 与 1.1.0-alpha.N 时只列 1.1.0 ——
 * 正式版的 ⚠️ 导读本来就是写给「从上一个正式版直接升上来」的人的(ADR-0005 决策 16 下对「每一版」的收窄)。
 * 所以 0.x 升 1.0 也只剩 1.0.0 那一段。正式版不在范围里(升到的是预发布)时预发布段照给。
 */
export function releasesBetween<T extends { version: string }>(
	entries: readonly T[],
	from: string,
	to: string,
): T[] {
	const inRange = entries.filter(
		(entry) => compareVersions(entry.version, from) > 0 && compareVersions(entry.version, to) <= 0,
	);
	const finals = new Set(inRange.filter((e) => !isPrerelease(e.version)).map((e) => e.version));
	return inRange
		.filter((entry) => !isPrerelease(entry.version) || !finals.has(coreOf(entry.version)))
		.sort((a, b) => compareVersions(b.version, a.version));
}
