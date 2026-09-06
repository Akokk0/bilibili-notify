// @vitest-environment jsdom
/**
 * 前端半边的四个场景:守「跑完之后那份 store / 查询确实变成了那个样子」。
 */

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { deriveOnboarding } from "../../components/onboarding/derive";
import { useOnboardingInputsOverride } from "../../components/onboarding/inputs-override";
import { HEALTH_QUERY_KEY } from "../../hooks/useBackendReachable";
import { useDraftStore } from "../../store/draft";
import { useToastStore } from "../../store/notifications";
import { onboardingInputsFor, WEB_SCENARIOS } from "../web-scenarios";

function scenario(id: string) {
	const s = WEB_SCENARIOS.find((x) => x.id === id);
	if (!s) throw new Error(`no ${id}`);
	return s;
}

const qc = new QueryClient();

beforeEach(() => {
	useToastStore.getState().clear();
	useDraftStore.getState().unregister();
	useOnboardingInputsOverride.getState().set(null);
});

describe("web.toast-flood", () => {
	it("涌 N 张;超过上限时最旧的被挤掉", () => {
		const out = scenario("web.toast-flood").run({ count: 7 }, { qc });
		expect(out).toContain("7");
		const items = useToastStore.getState().items;
		expect(items).toHaveLength(5);
		expect(items.map((i) => (i.kind === "notice" ? i.title : "?"))).toEqual([
			"devtools 第 3 张",
			"devtools 第 4 张",
			"devtools 第 5 张",
			"devtools 第 6 张",
			"devtools 第 7 张",
		]);
	});
});

describe("web.backend-unreachable", () => {
	it("把健康探测那条查询置成失败、数据清空 —— 壳层据此切错误态", () => {
		const client = new QueryClient();
		client.setQueryData(HEALTH_QUERY_KEY, { status: "ok", uptime: 1 });
		scenario("web.backend-unreachable").run({}, { qc: client });
		const state = client.getQueryState(HEALTH_QUERY_KEY);
		expect(state?.status).toBe("error");
		expect(state?.data).toBeUndefined();
		expect(String(state?.error)).toContain("devtools");
	});

	it("查询还没建起来就只回一句话", () => {
		expect(scenario("web.backend-unreachable").run({}, { qc: new QueryClient() })).toMatch(
			/没得切/,
		);
	});
});

describe("web.draft-island", () => {
	it("塞一份假草稿并切到指定态;生效条能看见;收摊撤掉", () => {
		const s = scenario("web.draft-island");
		s.run({ state: "error", message: "假装炸了" }, { qc });
		const st = useDraftStore.getState();
		expect(st.current?.pageKey).toBe("devtools");
		expect(st.uiState).toBe("error");
		expect(st.errorMessage).toBe("假装炸了");
		expect(s.active?.()).toEqual({ scenarioId: "web.draft-island", label: "灵动岛 → error" });

		s.reset?.();
		expect(useDraftStore.getState().current).toBeNull();
		expect(s.active?.()).toBeNull();
	});

	it("岛上「丢弃」也能撤掉它", () => {
		scenario("web.draft-island").run({ state: "dirty" }, { qc });
		useDraftStore.getState().current?.onDiscard();
		expect(useDraftStore.getState().current).toBeNull();
	});
});

describe("web.onboarding-step", () => {
	it("停在第 ③ 步:前两步完成、这一步是 active", () => {
		const view = deriveOnboarding(onboardingInputsFor("target"));
		expect(view.steps.map((s) => s.done)).toEqual([true, true, false, false, false]);
		expect(view.activeKey).toBe("target");
	});

	it("全部完成:五步全绿、activeKey 为 null", () => {
		const view = deriveOnboarding(onboardingInputsFor("done"));
		expect(view.allDone).toBe(true);
		expect(view.activeKey).toBeNull();
	});

	it("跑一下装上覆盖,收摊摘掉", () => {
		const s = scenario("web.onboarding-step");
		s.run({ step: "subs" }, { qc });
		expect(useOnboardingInputsOverride.getState().inputs?.subsCount).toBe(0);
		expect(useOnboardingInputsOverride.getState().inputs?.targets[0]?.testStatus?.ok).toBe(true);
		expect(s.active?.()).toMatchObject({ scenarioId: "web.onboarding-step" });
		s.reset?.();
		expect(useOnboardingInputsOverride.getState().inputs).toBeNull();
	});
});
