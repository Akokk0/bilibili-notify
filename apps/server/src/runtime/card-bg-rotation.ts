/**
 * 背景图轮换游标。当某 (scope, kind) 配置了 ≥2 张背景图时,「每次推送轮换」依次取下一张。
 *
 * 游标按 scopeKey 独立计数,值为「下次取用的序号」(取模列表长度);列表长度变化时取模天然
 * 安全。snapshot 暴露给上层做 fs 持久化 —— 独立端重启后用上次 snapshot 续接,不归零。
 * 纯逻辑、无 IO:持久化的读写由调用方(engines 装配处)包在 fs + 定时 flush 外层。
 */

/** scope 取下一张背景:空列表→undefined,单图→该图(不推进),多图→顺序轮换并推进游标。 */
export type PickCardBackground = (scopeKey: string, images: string[]) => string | undefined;

export interface CardBgRotator {
	pick: PickCardBackground;
	/** 当前游标快照(浅拷贝),交给持久化层落盘。 */
	snapshot(): Record<string, number>;
	/** 自上次 clearDirty 起是否有过推进(用于 debounce 持久化,避免无谓写盘)。 */
	isDirty(): boolean;
	clearDirty(): void;
}

/** @param initial 上次持久化的游标快照(重启续接);缺省从零开始。 */
export function createCardBgRotator(initial: Record<string, number> = {}): CardBgRotator {
	const cursors: Record<string, number> = { ...initial };
	let dirty = false;

	return {
		pick(scopeKey, images) {
			if (images.length === 0) return undefined;
			if (images.length === 1) return images[0];
			const cur = cursors[scopeKey] ?? 0;
			// 取模并归一化到 [0, len)(防御负值 / 列表变短)。
			const idx = ((cur % images.length) + images.length) % images.length;
			cursors[scopeKey] = idx + 1;
			dirty = true;
			return images[idx];
		},
		snapshot: () => ({ ...cursors }),
		isDirty: () => dirty,
		clearDirty: () => {
			dirty = false;
		},
	};
}
