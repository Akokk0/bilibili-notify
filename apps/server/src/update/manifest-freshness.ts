import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 每个渠道见过的最大清单签发时间,落在 `<versionsRoot>/manifest-freshness.json`。
 *
 * 这是防回放的全部记忆:签名只证明「这串字节我们签过」,加速站(设计上的中间人)可以
 * 永远回放一份签过的旧清单,把用户钉在已撤回的版本上。记住见过的最大值、比它旧的不收,
 * 回放就只剩「拒绝服务」这一种本事 —— 那才是文档里那句「有签名,代理站最多只能拒绝服务」
 * 成立的前提。
 *
 * 按渠道分开记:stable 与 alpha 各有各的清单,签发时间互不可比。
 *
 * 和 boot-state 一样是启发式状态:读不出来当没见过(退化成第一次,不是错误);写不进去
 * 也不拦着检查更新。写走 tmp + rename,撕裂写不会把记忆清零。
 */

const FILE = "manifest-freshness.json";

export type FreshnessChannel = "stable" | "prerelease";

type Seen = Partial<Record<FreshnessChannel, number>>;

function read(versionsRoot: string): Seen {
	try {
		const raw = JSON.parse(readFileSync(join(versionsRoot, FILE), "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null) return {};
		const seen: Seen = {};
		for (const channel of ["stable", "prerelease"] as const) {
			const value = (raw as Record<string, unknown>)[channel];
			if (typeof value === "number" && Number.isInteger(value) && value > 0) seen[channel] = value;
		}
		return seen;
	} catch {
		return {};
	}
}

export function readSeenIssuedAt(
	versionsRoot: string,
	channel: FreshnessChannel,
): number | undefined {
	return read(versionsRoot)[channel];
}

/** 只往前记:比已见过的小就不动 —— 记忆只能变新,不能被一份旧清单改回去。 */
export function rememberIssuedAt(
	versionsRoot: string,
	channel: FreshnessChannel,
	issuedAt: number,
): void {
	const seen = read(versionsRoot);
	const current = seen[channel];
	if (current !== undefined && current >= issuedAt) return;
	try {
		mkdirSync(versionsRoot, { recursive: true });
		const tmp = join(versionsRoot, `.${FILE}.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify({ ...seen, [channel]: issuedAt }));
		renameSync(tmp, join(versionsRoot, FILE));
	} catch {
		// 写不进去(只读挂载、磁盘满)不拦着检查更新;代价是下次少一层防回放。
	}
}
