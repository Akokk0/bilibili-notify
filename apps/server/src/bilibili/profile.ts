import {
	type CreatorProfileReport,
	type Disposable,
	type Failure,
	fail,
	type Identity,
	type Json,
	type KeyValueStore,
	type Logger,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../util/error-message.js";
import type { Api } from "./api/index.js";
import { logText, t } from "./i18n.js";
import { type ImagesDeps, type ProfileAvatarFields, syncProfileAvatar } from "./images.js";
import { PROBLEM_TEXTS } from "./problem-texts.js";

/**
 * B 站来源的 `fetchProfile`(`docs/1.0/subscription-sources.md`):核心按资料刷新 cron 一条一条地问,按 id 取人
 * (女仆查没订阅的人)也是它。主人 10-21 定**每轮拉整张用户卡** —— 名字、头像地址、签名、粉丝数一次拿齐,
 * 请求数与从前「稳态只问粉丝数」一样(每条一次),UP 改名换头像下一轮就跟上。
 *
 * - **整轮刹车归来源**:撞上 `rate_limited` 就进 B 站风控层(路名 `profile`,只进表不私聊,3b-18 的口径),
 *   之后 {@link RISK_BACKOFF_MS} 里每一条都直接回同一个失败、不出网,核心那头不用懂 B 站的风控;
 * - **出网间隔**留在这里({@link REQUEST_INTERVAL_MS}):核心串行地一条接一条问,B 站不喜欢贴着发;
 * - **头像**先抓进图库再交引用。B 站这头在自己的 `ctx.state` 里每人记一个 `profile:<uid>`:头像来源地址与
 *   引用(地址没变且有引用就不重抓,见 `syncProfileAvatar`)、直播那头取到的粉丝牌名(不为它多发请求);
 * - **只记名单里的人**:不在订阅名单里的(女仆查的陌生人)照交名字粉丝简介,不抓头像、不写 state;
 *   名单变了删掉不在名单里的键。
 */

/** 撞风控之后整轮刹车多久(与从前粉丝轮询的退避同一个数)。 */
const RISK_BACKOFF_MS = 5 * 60_000;
/** 两次出网之间至少隔多久。 */
const REQUEST_INTERVAL_MS = 200;

export interface ProfileFetcherDeps {
	api: Pick<Api, "fetchUserCard">;
	problems: {
		reportRisk(path: string, options: { notify: boolean }): void;
		resolveRisk(path: string): void;
	};
	state: Pick<KeyValueStore, "get" | "set" | "delete">;
	subscriptions: () => readonly { externalId: string }[];
	images: ImagesDeps["images"];
	logger: Logger;
	now: () => number;
	setTimeout: (fn: () => void, ms: number) => Disposable;
}

/** `ctx.state` 里 `profile:<uid>` 那一份:头像两格同 `syncProfileAvatar` 的规矩,粉丝牌名是直播那头记的。 */
interface ProfileState extends ProfileAvatarFields {
	fanClubName?: string;
}

export function createProfileFetcher(deps: ProfileFetcherDeps): {
	fetchProfile(identity: Identity, signal: AbortSignal): Promise<Result<CreatorProfileReport>>;
	rememberFanClubName(externalId: string, name: string): void;
	syncSubscriptions(): void;
} {
	let lastRateLimit: Failure | undefined;
	let riskBackoffUntil: number | undefined;
	let lastNetworkAt: number | undefined;
	let knownExternalIds = new Set(deps.subscriptions().map((view) => view.externalId));
	let stateWrites = Promise.resolve();

	/**
	 * 读改写 `profile:<uid>` 排成一条队:拉资料写头像与直播那头写粉丝牌名交错着来时,后落地的那条会把先落地
	 * 那条改的格冲回去。一条抛了不卡住后面的。
	 */
	function stateTask<T>(task: () => Promise<T>): Promise<T> {
		const made = stateWrites.then(task, task);
		stateWrites = made.then(
			() => undefined,
			() => undefined,
		);
		return made;
	}

	function stateOf(externalId: string): ProfileState {
		const raw = deps.state.get(`profile:${externalId}`);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
		const fields = raw as Record<string, Json>;
		return {
			...(typeof fields.avatarUrl === "string" ? { avatarUrl: fields.avatarUrl } : {}),
			...(typeof fields.avatar === "string" ? { avatar: fields.avatar } : {}),
			...(typeof fields.fanClubName === "string" ? { fanClubName: fields.fanClubName } : {}),
		};
	}

	/**
	 * state 写不进去只丢这一次的记忆(下一轮重抓头像、粉丝牌名等下一场直播):记一句、不拖累交资料。
	 * 那一句由调用处写在 `logger.warn` 里,这里只递标准码与原话。
	 */
	function logStateFailure(result: Result, warn: (failure: Failure) => void): void {
		if (!result.ok) warn(result);
	}

	/** 离上一次出网不足间隔就先等;等的时候宿主不等了(`signal` 中止)回 `false`,这一发不出网。 */
	function waitForInterval(signal: AbortSignal): Promise<boolean> {
		const elapsed = lastNetworkAt === undefined ? REQUEST_INTERVAL_MS : deps.now() - lastNetworkAt;
		const waitMs = Math.max(0, REQUEST_INTERVAL_MS - elapsed);
		if (waitMs === 0 && !signal.aborted) return Promise.resolve(true);
		return new Promise((resolve) => {
			let timer: Disposable | undefined;
			let settled = false;
			const finish = (ready: boolean): void => {
				if (settled) return;
				settled = true;
				timer?.dispose();
				signal.removeEventListener("abort", onAbort);
				resolve(ready);
			};
			const onAbort = (): void => finish(false);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				finish(false);
				return;
			}
			timer = deps.setTimeout(() => finish(true), waitMs);
		});
	}

	return {
		async fetchProfile(identity, signal) {
			if (
				lastRateLimit !== undefined &&
				riskBackoffUntil !== undefined &&
				deps.now() < riskBackoffUntil
			) {
				return lastRateLimit;
			}
			// 宿主那头(`callSource`)中止时自己收尾、不看这里回什么;这句只为类型完整。
			if (!(await waitForInterval(signal))) {
				return fail("unavailable", "the call was cancelled by the host");
			}
			lastNetworkAt = deps.now();
			let result: Awaited<ReturnType<ProfileFetcherDeps["api"]["fetchUserCard"]>>;
			try {
				result = await deps.api.fetchUserCard(identity.externalId);
			} catch (error) {
				// 连不上、超时、非 2xx:请求层抛的。收成一时失败交给核心(下一轮照问),原话进日志。
				const message = errorMessageOf(error);
				deps.logger.warn(logText("log.bilibili.profile.fetchFailed"), {
					externalId: identity.externalId,
					error,
				});
				return fail("unavailable", message);
			}
			if (!result.ok) {
				if (result.code === "rate_limited") {
					lastRateLimit = result;
					riskBackoffUntil = deps.now() + RISK_BACKOFF_MS;
					deps.problems.reportRisk("profile", {
						notify: PROBLEM_TEXTS.riskControlled.notify.profile,
					});
				}
				return result;
			}
			deps.problems.resolveRisk("profile");
			const card = result.data?.card;
			if (!card || typeof card.name !== "string" || card.name.trim() === "") {
				return fail("unavailable", t("bilibili.response.malformed"));
			}

			const next = await stateTask(async () => {
				const subscribed = deps
					.subscriptions()
					.some((view) => view.externalId === identity.externalId);
				if (!subscribed) return {};
				const current = stateOf(identity.externalId);
				const avatarFields = await syncProfileAvatar(current, card.face, {
					images: deps.images,
					logger: deps.logger,
				});
				const merged = { ...current, ...avatarFields };
				const written = await deps.state.set(`profile:${identity.externalId}`, merged);
				logStateFailure(written, (reason) =>
					deps.logger.warn(logText("log.bilibili.profile.avatarWriteFailed"), {
						externalId: identity.externalId,
						code: reason.code,
						message: reason.message,
					}),
				);
				return merged;
			});
			return ok({
				name: card.name,
				...(next.avatar === undefined ? {} : { avatar: next.avatar }),
				...(card.sign ? { bio: card.sign } : {}),
				...(Number.isInteger(card.fans) && card.fans >= 0 ? { followers: card.fans } : {}),
				...(next.fanClubName === undefined ? {} : { fanClubName: next.fanClubName }),
			});
		},
		/** 直播那头取到主播信息时记下粉丝牌名,下一次 `fetchProfile` 交资料时带上。 */
		rememberFanClubName(externalId, name) {
			const subscribed = deps.subscriptions().some((view) => view.externalId === externalId);
			if (!subscribed) return;
			void stateTask(async () => {
				const current = stateOf(externalId);
				if (current.fanClubName === name) return;
				const written = await deps.state.set(`profile:${externalId}`, {
					...current,
					fanClubName: name,
				});
				logStateFailure(written, (reason) =>
					deps.logger.warn(logText("log.bilibili.profile.fanClubWriteFailed"), {
						externalId: externalId,
						code: reason.code,
						message: reason.message,
					}),
				);
			});
		},
		/**
		 * 名单变了:删掉不在名单里的 `profile:*`。state 不能列键,只能比这个进程里见过的上一份名单 ——
		 * 停机期间被删的订阅留下的键清不掉(只是几十字节的孤儿,订阅加回来时会被覆盖)。
		 */
		syncSubscriptions() {
			const current = new Set(deps.subscriptions().map((view) => view.externalId));
			for (const externalId of knownExternalIds) {
				if (current.has(externalId)) continue;
				void stateTask(async () => {
					const removed = await deps.state.delete(`profile:${externalId}`);
					logStateFailure(removed, (reason) =>
						deps.logger.warn(logText("log.bilibili.profile.deleteFailed"), {
							externalId: externalId,
							code: reason.code,
							message: reason.message,
						}),
					);
				});
			}
			knownExternalIds = current;
		},
	};
}
