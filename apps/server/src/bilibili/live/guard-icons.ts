/**
 * 大航海徽章图标:运行时从 B 站静态站抓进图库,用图库引用交给会员卡(3a-33)。
 *
 * 仓库与安装包里不放 B 站的图标文件;三张图的地址只从档位表(`BILIBILI_GUARD_PROGRAM` 各档的 `icon.url`)读。
 */

import {
	BILIBILI_GUARD_PROGRAM,
	type ImageRef,
	type Logger,
	type MembershipTier,
	type Result,
} from "@bilibili-notify/internal";
import { IMAGE_REQUEST_HEADERS } from "../images";

/** 档位表里的三档(体系声明成逐档列出,不会是 `"custom"`)。 */
const GUARD_TIERS: readonly MembershipTier[] = Array.isArray(BILIBILI_GUARD_PROGRAM.tiers)
	? BILIBILI_GUARD_PROGRAM.tiers
	: [];

/** 抓这几张图时带的请求头:B 站静态站的图按站内引用来取。装配处建请求客户端时用它,核心那边不写 B 站的地址。 */
export const GUARD_ICON_REQUEST_HEADERS = IMAGE_REQUEST_HEADERS;

/** 两次抓取尝试之间的最小间隔:抓不到时别每条上舰都去打一次网络。 */
export const GUARD_ICON_RETRY_INTERVAL_MS = 5 * 60 * 1000;

export interface GuardIconsDeps {
	/** 抓图服务(只用抓远端图那一口)。 */
	images: {
		fetchImage(url: string): Promise<Result<{ ref: ImageRef }>>;
	};
	logger: Logger;
	now?: () => number;
}

export interface GuardIcons {
	/** 把还没抓到的图标抓进图库。抓不到不抛、记一条日志;同时进来的调用共用一次在途的抓取;两次尝试之间有最小间隔。 */
	ensure(): Promise<void>;
	/** 这一档的图标:抓到了给图库引用,没抓到给 `undefined`。 */
	iconOf(tierKey: string): { ref: ImageRef } | undefined;
	/** 手里所有的图库引用,给图库引用方报名单用。 */
	refs(): ImageRef[];
}

export function createGuardIcons(deps: GuardIconsDeps): GuardIcons {
	const now = deps.now ?? Date.now;
	const held = new Map<string, ImageRef>();
	let lastAttemptAt: number | undefined;
	let inFlight: Promise<void> | undefined;

	async function fetchMissing(): Promise<void> {
		const missing = GUARD_TIERS.filter(
			(tier) => tier.icon?.url !== undefined && !held.has(tier.key),
		);
		await Promise.all(
			missing.map(async (tier) => {
				// 抓图服务的约定是回结果、不抛;这里仍然接住,因为开机那一处不等它(`void ensure()`),漏出去就是没人接的拒绝。
				try {
					const result = await deps.images.fetchImage(tier.icon?.url ?? "");
					if (result.ok) {
						held.set(tier.key, result.ref);
						return;
					}
					deps.logger.warn(
						`[guard-icons] 抓「${tier.name}」徽章图失败: ${result.code}: ${result.message}`,
					);
				} catch (error) {
					deps.logger.warn(
						`[guard-icons] 抓「${tier.name}」徽章图失败: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}),
		);
	}

	return {
		ensure() {
			if (inFlight) return inFlight;
			const complete = GUARD_TIERS.every(
				(tier) => tier.icon?.url === undefined || held.has(tier.key),
			);
			if (complete) return Promise.resolve();
			if (lastAttemptAt !== undefined && now() - lastAttemptAt < GUARD_ICON_RETRY_INTERVAL_MS) {
				return Promise.resolve();
			}
			lastAttemptAt = now();
			inFlight = fetchMissing().finally(() => {
				inFlight = undefined;
			});
			return inFlight;
		},
		iconOf(tierKey) {
			const ref = held.get(tierKey);
			return ref === undefined ? undefined : { ref };
		},
		refs() {
			return [...held.values()];
		},
	};
}
