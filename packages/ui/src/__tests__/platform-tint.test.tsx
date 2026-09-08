// @vitest-environment jsdom

/**
 * `PlatformIcon` 与它的两个查表 hook —— 表**从外面注入**。
 *
 * 这张表原先写死在库里(六个平台名、色、短名),于是每接进来一个新平台都得改一次
 * 纯展示件库。现在库只管**怎么画**:有图标画图标、没有画首字方章、色可被 tone 盖、
 * 认不出就退静默档。所以这个文件里一个真平台名都不该出现 —— 用的全是假名字,
 * 库能不能画对与它认不认识 onebot 无关。
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	PlatformIcon,
	type PlatformMeta,
	PlatformMetaProvider,
	usePlatformLabel,
	usePlatformTint,
} from "../atoms";

const TABLE: Record<string, PlatformMeta> = {
	"has-icon": { tint: "#3b82f6", label: "有图标", icon: "qq" },
	"no-icon": { tint: "#07c160", label: "方章" },
	// 注入的是外来数据,给个库里没有的图标名是迟早的事 —— 不许因此炸掉。
	"bad-icon": { tint: "#00c2ff", label: "坏名字", icon: "not-an-icon" },
};

function Wrap({ children }: { children: ReactNode }) {
	return <PlatformMetaProvider value={(p) => TABLE[p]}>{children}</PlatformMetaProvider>;
}

function Probe({ platform }: { platform: string }) {
	const tint = usePlatformTint();
	const label = usePlatformLabel();
	return <i data-testid="probe" data-tint={tint(platform)} data-label={label(platform)} />;
}

function probe(): HTMLElement {
	return screen.getByTestId("probe");
}

afterEach(cleanup);

describe("查表 hook", () => {
	it("注入过的平台读得到自己的色与短名", () => {
		render(
			<Wrap>
				<Probe platform="no-icon" />
			</Wrap>,
		);
		expect(probe().dataset.tint).toBe("#07c160");
		expect(probe().dataset.label).toBe("方章");
	});

	it("表里没有的平台退静默档 token,短名就是平台名本身", () => {
		render(
			<Wrap>
				<Probe platform="carrier-pigeon" />
			</Wrap>,
		);
		expect(probe().dataset.tint).toBe("var(--color-bn-inactive)");
		expect(probe().dataset.label).toBe("carrier-pigeon");
	});

	it("压根没有 Provider 时也是这套 —— 库自己不认识任何平台", () => {
		render(<Probe platform="no-icon" />);
		expect(probe().dataset.tint).toBe("var(--color-bn-inactive)");
		expect(probe().dataset.label).toBe("no-icon");
	});
});

describe("PlatformIcon", () => {
	it("给了图标名就画图标", () => {
		const { container } = render(
			<Wrap>
				<PlatformIcon platform="has-icon" />
			</Wrap>,
		);
		expect(container.querySelector("svg")).toBeTruthy();
		expect(container.querySelector("span")).toBeNull();
	});

	it("没有图标就画首字方章,底色是标识色", () => {
		const { container } = render(
			<Wrap>
				<PlatformIcon platform="no-icon" />
			</Wrap>,
		);
		const badge = container.querySelector("span") as HTMLElement;
		expect(badge.textContent).toBe("方");
		expect(badge.style.background).toBe("rgb(7, 193, 96)");
	});

	it("图标名库里没有,退方章而不是空白", () => {
		const { container } = render(
			<Wrap>
				<PlatformIcon platform="bad-icon" />
			</Wrap>,
		);
		expect(container.querySelector("svg")).toBeNull();
		expect((container.querySelector("span") as HTMLElement).textContent).toBe("坏");
	});

	it("认不出的平台:方章底色退静默档,字是平台名首字", () => {
		const { container } = render(
			<Wrap>
				<PlatformIcon platform="carrier-pigeon" />
			</Wrap>,
		);
		const badge = container.querySelector("span") as HTMLElement;
		expect(badge.style.background).toContain("--color-bn-inactive");
		expect(badge.textContent).toBe("c");
	});

	it("tone 盖得掉标识色 —— 摆在皮肤的实心强调块上要跟着文字色走", () => {
		const { container } = render(
			<Wrap>
				<PlatformIcon platform="no-icon" tone="currentColor" />
			</Wrap>,
		);
		expect((container.querySelector("span") as HTMLElement).style.background).toBe("currentcolor");
	});
});
