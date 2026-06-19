import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DraftRegistration, DraftUiState } from "../../store/draft";
import {
	_resetSavedLingerTimerForTest,
	clearNonNaturalUiState,
	runSaveFlow,
	SAVED_LINGER_MS,
	type SaveFlowHandle,
} from "../useDirtyDraft";

interface StubState {
	uiState: DraftUiState;
	errorMessage: string | null;
	current: DraftRegistration | null;
}

function stubHandle(initial: Partial<StubState> = {}): {
	handle: SaveFlowHandle;
	state: StubState;
	transitions: { uiState: DraftUiState; errorMessage: string | null }[];
} {
	const state: StubState = {
		uiState: "dirty",
		errorMessage: null,
		current: null,
		...initial,
	};
	const transitions: { uiState: DraftUiState; errorMessage: string | null }[] = [];
	const handle: SaveFlowHandle = {
		setUiState: (next, msg = null) => {
			state.uiState = next;
			state.errorMessage = next === "error" ? msg : null;
			transitions.push({ uiState: state.uiState, errorMessage: state.errorMessage });
		},
		getState: () => ({ uiState: state.uiState, current: state.current }),
	};
	return { handle, state, transitions };
}

const dirtyCurrent: DraftRegistration = {
	pageKey: "rules",
	pageLabel: "动态过滤规则",
	diff: [{ code: "blockKeywords", oldValue: [], newValue: ["x"] }],
	onSave: () => {},
	onDiscard: () => {},
};

describe("runSaveFlow", () => {
	beforeEach(() => {
		_resetSavedLingerTimerForTest();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		_resetSavedLingerTimerForTest();
	});

	it("success:saving → saved,1.2s 后 → idle(diff 空时)", async () => {
		const { handle, transitions } = stubHandle({ current: null });
		const p = runSaveFlow(async () => {}, handle);
		await p;
		expect(transitions.map((t) => t.uiState)).toEqual(["saving", "saved"]);

		vi.advanceTimersByTime(SAVED_LINGER_MS);
		expect(transitions.map((t) => t.uiState)).toEqual(["saving", "saved", "idle"]);
	});

	it("success:1.2s 后若 diff 仍非空 → dirty(用户在 saved 期间又改了)", async () => {
		const { handle, transitions, state } = stubHandle({ current: null });
		await runSaveFlow(async () => {}, handle);
		// 模拟用户在 saved 1.2s 窗口里又触发了 dirty:current 被更新到非空 diff
		state.current = dirtyCurrent;
		vi.advanceTimersByTime(SAVED_LINGER_MS);
		expect(transitions.at(-1)).toEqual({ uiState: "dirty", errorMessage: null });
	});

	it("success:1.2s 内 uiState 被其他流程改写 → 不强转 idle", async () => {
		const { handle, transitions, state } = stubHandle({ current: null });
		await runSaveFlow(async () => {}, handle);
		// 模拟用户在窗口内再次点保存 → saving 态(不应被 saved-linger 覆盖)
		state.uiState = "saving";
		vi.advanceTimersByTime(SAVED_LINGER_MS);
		const tail = transitions.at(-1);
		// 只在最后期望仍是 saved(因为守卫看不到再次 saving 是外部改的;但守卫
		// 检查 uiState !== "saved" 时跳过)。这里 state.uiState=saving,守卫跳过。
		expect(tail).toEqual({ uiState: "saved", errorMessage: null });
	});

	it("error:Error 实例 → uiState=error + errorMessage=err.message", async () => {
		const { handle, state } = stubHandle();
		await runSaveFlow(() => Promise.reject(new Error("网络中断")), handle);
		expect(state.uiState).toBe("error");
		expect(state.errorMessage).toBe("网络中断");
	});

	it("error:非 Error 实例 → toString 兜底", async () => {
		const { handle, state } = stubHandle();
		await runSaveFlow(() => Promise.reject("raw string"), handle);
		expect(state.uiState).toBe("error");
		expect(state.errorMessage).toBe("raw string");
	});

	it("error 后 1.2s 不会自动转 idle(没排 timer)", async () => {
		const { handle, transitions } = stubHandle();
		await runSaveFlow(() => Promise.reject(new Error("x")), handle);
		const beforeAdvance = transitions.length;
		vi.advanceTimersByTime(5000);
		expect(transitions.length).toBe(beforeAdvance);
	});

	it("自定义 savedLingerMs", async () => {
		const { handle, transitions } = stubHandle({ current: null });
		await runSaveFlow(async () => {}, handle, 50);
		vi.advanceTimersByTime(49);
		expect(transitions.map((t) => t.uiState)).toEqual(["saving", "saved"]);
		vi.advanceTimersByTime(1);
		expect(transitions.map((t) => t.uiState)).toEqual(["saving", "saved", "idle"]);
	});

	it("同步 onSave 也走完整流程", async () => {
		const { handle, transitions } = stubHandle({ current: null });
		await runSaveFlow(() => 42, handle);
		expect(transitions.map((t) => t.uiState)).toEqual(["saving", "saved"]);
	});

	it("clearNonNaturalUiState 把 error/saved/saving 拽回 dirty", () => {
		for (const initial of ["error", "saved", "saving"] as const) {
			const { handle, state } = stubHandle({ uiState: initial });
			clearNonNaturalUiState(handle);
			expect(state.uiState).toBe("dirty");
		}
	});

	it("clearNonNaturalUiState 在 idle/dirty 态不动 store", () => {
		for (const initial of ["idle", "dirty"] as const) {
			const { handle, transitions } = stubHandle({ uiState: initial });
			clearNonNaturalUiState(handle);
			expect(transitions).toEqual([]);
		}
	});

	it("连续两次 save:旧 linger timer 被 clear,只有第二次的 1.2s 生效", async () => {
		const { handle, transitions } = stubHandle({ current: null });
		// 第一次 save
		await runSaveFlow(async () => {}, handle);
		// 推进 500ms(第一次 linger 还剩 700ms)
		vi.advanceTimersByTime(500);
		// 第二次 save —— 应该清掉旧 linger timer
		await runSaveFlow(async () => {}, handle);
		// 推进到第一次 linger 原本的 fire 时机(再 700ms 即 1200ms 后)。如果旧
		// timer 没 clear,这里 transitions 会追加一条 idle/dirty。
		vi.advanceTimersByTime(700);
		expect(transitions.map((t) => t.uiState)).toEqual(["saving", "saved", "saving", "saved"]);
		// 再推进到第二次 linger 真正 fire(总 1200ms after second save)
		vi.advanceTimersByTime(500);
		expect(transitions.at(-1)).toEqual({ uiState: "idle", errorMessage: null });
	});
});
