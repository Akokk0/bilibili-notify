// @vitest-environment jsdom
/**
 * 概览页的系统状态卡:有新版时在版本号旁边说一句,并给一个直达系统页更新卡片的
 * 按钮。没新版、或者后端失联(那份状态只是快照)时什么都不加。
 */

import type { UpdateStatusDTO } from "@bilibili-notify/contract";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SystemHealthCard } from "../Dashboard";

vi.stubGlobal("__WEB_VERSION__", "0.0.0-test");

function LocationProbe() {
	const loc = useLocation();
	return <div data-testid="loc">{`${loc.pathname}${loc.hash}`}</div>;
}

function dto(state: UpdateStatusDTO["state"]): UpdateStatusDTO {
	return { currentVersion: "0.8.0", rollbackTarget: null, pinnedVersion: null, state };
}

function renderCard(over: { update?: UpdateStatusDTO; reachable?: boolean } = {}) {
	return render(
		<MemoryRouter initialEntries={["/"]}>
			<SystemHealthCard
				health={{ status: "ok", version: "0.8.0", uptime: 1, startedAt: "2026-09-02T00:00:00Z" }}
				reachable={over.reachable ?? true}
				logLevel="info"
				logLevels={undefined}
				loggedIn
				subCount={0}
				targetCount={0}
				dynamicEnabled={false}
				liveEnabled={false}
				imageEnabled={false}
				aiEnabled={false}
				update={over.update}
			/>
			<Routes>
				<Route path="*" element={<LocationProbe />} />
			</Routes>
		</MemoryRouter>,
	);
}

afterEach(() => {
	cleanup();
});

describe("SystemHealthCard —— 有新版时", () => {
	it("版本号旁边说一句,「去更新」直达系统页的更新卡片", async () => {
		renderCard({
			update: dto({ phase: "available", target: "0.9.0", releaseUrl: "https://x", checkedAt: 1 }),
		});

		expect(screen.getByText("有新版 0.9.0")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "去更新" }));
		expect(screen.getByTestId("loc").textContent).toBe("/system#update");
	});

	it("下好了的也算 —— 文案跟系统页那节一个口径", () => {
		renderCard({ update: dto({ phase: "ready", target: "0.9.0", releaseUrl: "https://x" }) });
		expect(screen.getByText("0.9.0 已就绪")).toBeTruthy();
		expect(screen.getByRole("button", { name: "去更新" })).toBeTruthy();
	});

	it("已是最新 / 还没查:不催", () => {
		renderCard({ update: dto({ phase: "up-to-date", checkedAt: 1 }) });
		expect(screen.queryByRole("button", { name: "去更新" })).toBeNull();
		cleanup();
		renderCard({ update: undefined });
		expect(screen.queryByRole("button", { name: "去更新" })).toBeNull();
	});

	it("后端失联时不催 —— 那份状态只是快照,按了也去不了哪", () => {
		renderCard({
			reachable: false,
			update: dto({ phase: "available", target: "0.9.0", releaseUrl: "https://x", checkedAt: 1 }),
		});
		expect(screen.queryByRole("button", { name: "去更新" })).toBeNull();
	});
});
