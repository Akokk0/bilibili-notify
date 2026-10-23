import {
	checkUserRegex,
	type Disposable,
	type Source,
	type SourceAuth,
	type SourceContext,
} from "@bilibili-notify/internal";
import { createRegistry } from "../integrations/registry.js";
import { stopQuietly } from "../integrations/stop-quietly.js";
import { errorMessageOf } from "../util/error-message.js";

/**
 * 登记表对外给的来源视图:不含 start / stop(启停只归登记表)。今天是 `{ sourceKey, descriptor, auth?, health? }`;
 * `sourceKey` 是登记时认领的那个键(`login <来源>` 要认键,所以视图得带着它)。
 */
export type SourceView = Omit<Source, "start" | "stop"> & { sourceKey: string };

/** 带登录口的来源:`login` 指令挑它、`status` 给它出「登录」行。 */
export interface SourceLoginView {
	sourceKey: string;
	/** 描述符的 `label`,给人看的名字。 */
	label: string;
	auth: SourceAuth;
}

/** 在册来源里带登录口的那几个,按登记先后。现读(来源可以来去),别缓存。 */
export function listLoginSources(views: readonly SourceView[]): SourceLoginView[] {
	const found: SourceLoginView[] = [];
	for (const view of views) {
		if (view.auth)
			found.push({ sourceKey: view.sourceKey, label: view.descriptor.label, auth: view.auth });
	}
	return found;
}

/**
 * 订阅来源的登记表:一个来源键一个主人。
 */
export interface SourceRegistry {
	/**
	 * 认领键 → `await source.start(ctx)` → 回一个撤下它的把手。键被占了就抛;`start` 抛了:
	 * 把键放掉、错原样抛出去(登记失败不留半个)。把手 `dispose`:放键,再调 `source.stop()`
	 * (不等它,失败只记 warn)。
	 */
	register(sourceKey: string, source: Source, ctx: SourceContext): Promise<Disposable>;
	/** 现在谁认领着这个键;没人 = undefined。 */
	get(sourceKey: string): SourceView | undefined;
	/** 全部在册的来源,按登记先后(第一个读者是会员档位读口)。 */
	list(): readonly SourceView[];
}

export function createSourceRegistry(): SourceRegistry {
	const table = createRegistry<SourceView>(
		(key) => `source for key "${key}" is already registered`,
	);
	return {
		get: (sourceKey) => table.get(sourceKey),
		list: () => Array.from(table.entries(), ([, view]) => view),
		async register(sourceKey, source, ctx) {
			// 描述符声明的外部 id 格式先体检(同清单那一半,同一道 `checkUserRegex`):坏正则拖不住新建订阅,
			// 所以不让这个来源进来。抛法同键被占 —— 在认领、`start` 之前,不留半个。
			const { externalIdRegex } = source.descriptor;
			if (externalIdRegex !== undefined) {
				const checked = checkUserRegex(externalIdRegex);
				if (!checked.ok) {
					throw new Error(`source "${sourceKey}" 的 externalIdRegex 不合规: ${checked.reason}`);
				}
			}
			// 会员体系 id 全局唯一(R3 甲,档 key 只在体系内唯一):跟已在册的撞了、或自己这一份里写重了,
			// 都在认领与 `start` 之前拒收 —— 放进来之后按体系 id 取门槛 / 文案 / 档位就分不清是谁的了。
			const declaredPrograms = source.descriptor.membershipPrograms ?? [];
			const seenPrograms = new Set<string>();
			for (const program of declaredPrograms) {
				if (seenPrograms.has(program.id)) {
					throw new Error(
						`source "${sourceKey}" declares membership program "${program.id}" twice`,
					);
				}
				seenPrograms.add(program.id);
			}
			for (const [key, view] of table.entries()) {
				for (const program of view.descriptor.membershipPrograms ?? []) {
					if (!seenPrograms.has(program.id)) continue;
					throw new Error(
						`source "${sourceKey}" membership program "${program.id}" is already declared by "${key}"`,
					);
				}
			}
			const { health, fetchLiveStatus, liveInteractions } = source;
			const claim = table.claim(sourceKey, {
				sourceKey,
				descriptor: source.descriptor,
				auth: source.auth,
				// 同 `health`:直接放 `source.searchCreators` 会丢掉 `this`。
				searchCreators: (query, signal) => source.searchCreators(query, signal),
				// 同 `searchCreators`:逐成员转发,别丢来源自己的 `this`。
				fetchProfile: (identity, signal) => source.fetchProfile(identity, signal),
				// 同上:直接放 `source.fetchLiveStatus` 会丢掉 `this`。没实现就不放这一格(核心据此知道它没有拉取式)。
				...(fetchLiveStatus
					? {
							fetchLiveStatus: (identity, signal) => fetchLiveStatus.call(source, identity, signal),
						}
					: {}),
				// 同 `fetchLiveStatus`:转发时不丢 `this`。观众头像与档位图标两个懒取口。
				...(liveInteractions
					? {
							liveInteractions: {
								fetchViewerAvatar: (identity, viewerId, signal) =>
									liveInteractions.fetchViewerAvatar.call(
										liveInteractions,
										identity,
										viewerId,
										signal,
									),
								fetchTierIcon: (identity, program, tierKey, signal) =>
									liveInteractions.fetchTierIcon.call(
										liveInteractions,
										identity,
										program,
										tierKey,
										signal,
									),
							},
						}
					: {}),
				// 不能直接放 `source.health`:那会丢掉 `this`。没交就不放这一格。
				...(health ? { health: () => health.call(source) } : {}),
			});
			try {
				await source.start(ctx);
			} catch (err) {
				claim.dispose();
				throw err;
			}
			let removed = false;
			return {
				dispose() {
					if (removed) return;
					removed = true;
					claim.dispose();
					stopQuietly(
						() => source.stop(),
						(err) => ctx.logger.warn(`[source] ${sourceKey} stop 失败: ${errorMessageOf(err)}`),
					);
				},
			};
		},
	};
}
