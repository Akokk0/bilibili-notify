import { useCallback, useEffect, useRef } from "react";
import {
	type DraftRegistration,
	type DraftUiState,
	deriveNaturalUiState,
	useDraftStore,
} from "../store/draft";
import { type FieldDiff, walkTreeDiff } from "../utils/walkTreeDiff";
import { useDebouncedMemo } from "./useDebouncedMemo";

/**
 * useDirtyDraft —— 4 个 draft 页(Rules / Cards / Ai / System)接入灵动岛的
 * 单行 API。
 *
 * 每页拿到 server baseline(globalsQuery.data)+ 本地 draft(useState),把
 * (pageKey, pageLabel, draft, baseline, onSave, onDiscard) 喂给 hook,hook
 * 自己跑 debounced walkTreeDiff、注册到 zustand draftStore、wrap onSave 跑 5 态
 * 生命周期(saving → saved 1.2s → idle / error 不自动消失)。
 *
 * 返回值:
 * - `diff`     当前字段级 diff(debounce 后)
 * - `isDirty`  diff.length > 0
 * - `save`     包装好的保存,可直接绑给保存按钮
 * - `discard`  包装好的丢弃
 *
 * 调用方仍要负责:维持本地 draft / 调用 mutation 更新 baseline / 在 onSave
 * 里 throw 错误(本 hook 会捕获并切 error 态)。
 */
export interface UseDirtyDraftOptions<T> {
	pageKey: string;
	pageLabel: string;
	draft: T | null;
	baseline: T | null;
	onSave: () => Promise<unknown> | unknown;
	onDiscard: () => void;
}

export interface UseDirtyDraftResult {
	diff: FieldDiff[];
	isDirty: boolean;
	save: () => Promise<void>;
	discard: () => void;
}

const EMPTY_DIFF: FieldDiff[] = [];

export function useDirtyDraft<T>(opts: UseDirtyDraftOptions<T>): UseDirtyDraftResult {
	const { pageKey, pageLabel, draft, baseline, onSave, onDiscard } = opts;

	const diff = useDebouncedMemo<FieldDiff[]>(
		() => {
			if (draft === null || baseline === null) return EMPTY_DIFF;
			return walkTreeDiff(baseline, draft);
		},
		150,
		[draft, baseline],
	);
	const isDirty = diff.length > 0;

	// store actions 是 zustand 静态引用,放心当 effect dep。
	const register = useDraftStore((s) => s.register);
	const unregister = useDraftStore((s) => s.unregister);

	// 调用方 callback 用 ref 锁住,避免每次 render 都 register(callback 引用
	// 通常每次都变)。register 在 effect 里调,效果等价。
	const onSaveRef = useRef(onSave);
	const onDiscardRef = useRef(onDiscard);
	onSaveRef.current = onSave;
	onDiscardRef.current = onDiscard;

	const save = useCallback(async () => {
		await runSaveFlow(() => onSaveRef.current(), draftStoreHandle());
	}, []);

	const discard = useCallback(() => {
		onDiscardRef.current();
		clearNonNaturalUiState(draftStoreHandle());
	}, []);

	// register / 更新 current(diff 变化 → store 同步)。
	//
	// 当调用方把 draft 或 baseline 显式置 null 时(常见于 Rules 在 per-UP scope
	// 模式下不接灵动岛),立即 unregister 而不是注册 `diff:[]` —— 后者会让灵
	// 动岛短暂停在 idle 态(不可见),但 store.current 还指向本页 onSave/onDiscard
	// 闭包,易被后续 saving 路径误用。明示 null = 明示「本页此刻不接灵动岛」。
	useEffect(() => {
		if (draft === null || baseline === null) {
			unregister();
			return;
		}
		register({ pageKey, pageLabel, diff, onSave: save, onDiscard: discard });
	}, [register, unregister, pageKey, pageLabel, diff, save, discard, draft, baseline]);

	// unmount cleanup —— 切页 / 路由跳走时清掉 current
	useEffect(() => () => unregister(), [unregister]);

	return { diff, isDirty, save, discard };
}

// ── runSaveFlow 抽成纯函数,store handle 注入便于测试 ────────────────────────

export interface SaveFlowHandle {
	setUiState: (next: DraftUiState, errorMessage?: string | null) => void;
	getState: () => { uiState: DraftUiState; current: DraftRegistration | null };
}

/** zustand store → SaveFlowHandle。生产路径调它,测试路径可手造 handle。 */
function draftStoreHandle(): SaveFlowHandle {
	return {
		setUiState: (next, msg) => useDraftStore.getState().setUiState(next, msg),
		getState: () => {
			const s = useDraftStore.getState();
			return { uiState: s.uiState, current: s.current };
		},
	};
}

/**
 * 丢弃后从非自然态(saving/saved/error)拽回 dirty,让 register 在下一轮以 diff
 * 派生出自然态(diff=[] → idle)。store register 顶替策略默认保留非自然态以保护
 * saving/saved feedback,但丢弃语义就是用户主动放弃当前流转 → 必须解锁。
 */
export function clearNonNaturalUiState(handle: SaveFlowHandle): void {
	const { uiState } = handle.getState();
	if (uiState === "error" || uiState === "saved" || uiState === "saving") {
		handle.setUiState("dirty");
	}
}

export const SAVED_LINGER_MS = 1200;

/**
 * saved → idle linger timer 的单例句柄。dashboard 是单 SPA,任意时刻全局只能
 * 有一个 saved 态在 lingering;新 saved 进来时先 clearTimeout 旧的,避免「旧
 * save 的 1.2s timer 抢断新 save 的 saved 态」的竞态(audit R1)。
 */
let savedLingerTimer: ReturnType<typeof setTimeout> | null = null;

/** 测试 reset,避免 useFakeTimers 在 vitest module 共享 state 下泄漏。 */
export function _resetSavedLingerTimerForTest(): void {
	if (savedLingerTimer !== null) {
		clearTimeout(savedLingerTimer);
		savedLingerTimer = null;
	}
}

/**
 * 跑 save 生命周期:saving → (await) → saved → 1.2s 后回 idle/dirty 自然态。
 * onSave throw → 切 error 态,不自动消失。
 *
 * 1.2s 之后的 uiState 转换有守卫:仅在「当前还是 saved」时转,避免覆盖用户
 * 在这 1.2s 窗口里的新操作(再次点保存、改字段触发 dirty、unmount 等)。
 */
export async function runSaveFlow(
	onSave: () => Promise<unknown> | unknown,
	handle: SaveFlowHandle,
	savedLingerMs: number = SAVED_LINGER_MS,
): Promise<void> {
	handle.setUiState("saving");
	try {
		await onSave();
		handle.setUiState("saved");
		// 新 saved 顶替旧 saved linger:连续点保存场景下,旧 timer fire 会把
		// 状态错置成 deriveNaturalUiState(),把新 saved 抹早 ~(2× linger - 实际间隔)
		// 毫秒。clear 旧的再排新的,保证「最后一次 saved 起算 1.2s」。
		if (savedLingerTimer !== null) clearTimeout(savedLingerTimer);
		savedLingerTimer = setTimeout(() => {
			savedLingerTimer = null;
			const { uiState, current } = handle.getState();
			if (uiState === "saved") {
				handle.setUiState(deriveNaturalUiState(current));
			}
		}, savedLingerMs);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		handle.setUiState("error", msg);
	}
}
