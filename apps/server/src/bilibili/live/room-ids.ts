import {
	type Disposable,
	fail,
	type KeyValueStore,
	type Logger,
	ok,
	type Result,
} from "@bilibili-notify/internal";
import { errorMessageOf } from "../../util/error-message.js";
import type { Api } from "../api/index.js";

/**
 * 两次解析请求之间至少隔 300ms。冷启动时直播监听会对名单里的每位 UP 一起要房号;
 * 不隔开就会一起打 wbi 接口。
 */
const REQUEST_INTERVAL_MS = 300;

export interface RoomIds {
	/** 同步读这个人的房号缓存;只认正整数串。 */
	get(externalId: string): string | undefined;
	/** 读缓存或请求用户信息解析房号;同一个人的在途请求合并成一发。 */
	resolve(externalId: string): Promise<Result<{ roomId: string }>>;
	/** 名单变了:删掉不在名单里的人留下的 `room:<uid>`。 */
	syncSubscriptions(): void;
}

function positiveIntegerString(value: unknown): string | undefined {
	return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : undefined;
}

export function createRoomIds(opts: {
	api: Pick<Api, "fetchUserInfo">;
	state: Pick<KeyValueStore, "get" | "set" | "delete">;
	subscriptions: () => readonly { externalId: string }[];
	setTimeout: (fn: () => void, ms: number) => Disposable;
	now?: () => number;
	logger: Logger;
}): RoomIds {
	const now = opts.now ?? Date.now;
	const subscribedIds = () => new Set(opts.subscriptions().map((view) => view.externalId));
	let knownExternalIds = subscribedIds();
	let lastNetworkAt: number | undefined;
	let networkTail = Promise.resolve();
	let stateTail = Promise.resolve();
	const inFlight = new Map<string, Promise<Result<{ roomId: string }>>>();

	/** 状态写的读改删排成一条队,免得解析写缓存和名单删除交错后把刚删的键写回来。 */
	function stateTask<T>(task: () => Promise<T>): Promise<T> {
		const made = stateTail.then(task, task);
		stateTail = made.then(
			() => undefined,
			() => undefined,
		);
		return made;
	}

	function wait(ms: number): Promise<void> {
		return new Promise((resolve) => {
			let timer: Disposable | undefined;
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				timer?.dispose();
				resolve();
			};
			timer = opts.setTimeout(finish, ms);
			if (settled) timer.dispose();
		});
	}

	/** 所有出网共享一条队;后一发从上一次出网开始计时,隔够 300ms 才发。 */
	function runNetwork<T>(task: () => Promise<T>): Promise<T> {
		const made = networkTail.then(async () => {
			if (lastNetworkAt !== undefined) {
				const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (now() - lastNetworkAt));
				if (waitMs > 0) await wait(waitMs);
			}
			lastNetworkAt = now();
			return await task();
		});
		networkTail = made.then(
			() => undefined,
			() => undefined,
		);
		return made;
	}

	function get(externalId: string): string | undefined {
		return positiveIntegerString(opts.state.get(`room:${externalId}`));
	}

	async function request(externalId: string): Promise<Result<{ roomId: string }>> {
		let result: Awaited<ReturnType<Api["fetchUserInfo"]>>;
		try {
			result = await runNetwork(() => opts.api.fetchUserInfo(externalId));
		} catch (error) {
			return fail("unavailable", errorMessageOf(error));
		}
		if (!result.ok) return result;

		const roomId = result.data?.live_room?.roomid;
		if (typeof roomId !== "number" || !Number.isInteger(roomId) || roomId <= 0) {
			return fail("not_found", "live room is not available");
		}
		const resolved = String(roomId);
		if (subscribedIds().has(externalId)) {
			const written = await stateTask(() => opts.state.set(`room:${externalId}`, resolved));
			if (!written.ok) {
				opts.logger.warn(
					`[room-ids] uid=${externalId} 的房号没写进去: ${written.code}: ${written.message}`,
				);
			}
		}
		return ok({ roomId: resolved });
	}

	return {
		get,
		resolve(externalId) {
			const cached = get(externalId);
			if (cached) return Promise.resolve(ok({ roomId: cached }));
			const running = inFlight.get(externalId);
			if (running) return running;
			const made = request(externalId);
			inFlight.set(externalId, made);
			void made.finally(() => {
				if (inFlight.get(externalId) === made) inFlight.delete(externalId);
			});
			return made;
		},
		syncSubscriptions() {
			const current = subscribedIds();
			for (const externalId of knownExternalIds) {
				if (current.has(externalId)) continue;
				void stateTask(() => opts.state.delete(`room:${externalId}`)).then((removed) => {
					if (removed.ok) return;
					opts.logger.warn(
						`[room-ids] uid=${externalId} 的房号没删掉: ${removed.code}: ${removed.message}`,
					);
				});
			}
			knownExternalIds = current;
		},
	};
}
