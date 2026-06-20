// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ConfirmButton, ConfirmProvider, useConfirm } from "./ui";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
	}
	container.remove();
	root = undefined;
});

describe("ConfirmProvider", () => {
	it("resolves true when confirmed with Enter", async () => {
		const onResult = vi.fn();
		await render(
			<ConfirmProvider>
				<ConfirmHarness onResult={onResult} />
			</ConfirmProvider>,
		);

		await click(getButton("打开确认"));
		expect(container.textContent).toContain("继续吗？");
		await pressKey("Enter");

		expect(onResult).toHaveBeenCalledWith(true);
	});

	it("resolves false when cancelled with Escape", async () => {
		const onResult = vi.fn();
		await render(
			<ConfirmProvider>
				<ConfirmHarness onResult={onResult} />
			</ConfirmProvider>,
		);

		await click(getButton("打开确认"));
		expect(container.textContent).toContain("继续吗？");
		await pressKey("Escape");

		expect(onResult).toHaveBeenCalledWith(false);
	});

	it("resolves false when cancelled with the cancel button", async () => {
		const onResult = vi.fn();
		await render(
			<ConfirmProvider>
				<ConfirmHarness onResult={onResult} />
			</ConfirmProvider>,
		);

		await click(getButton("打开确认"));
		await click(getButton("返回"));

		expect(onResult).toHaveBeenCalledWith(false);
	});
});

describe("ConfirmButton", () => {
	it("asks before running a danger action and only runs it after approval", async () => {
		const onConfirm = vi.fn();
		await render(
			<ConfirmProvider>
				<ConfirmButton tone="danger" confirmText="确定删除？" onConfirm={onConfirm}>
					删除
				</ConfirmButton>
			</ConfirmProvider>,
		);

		await click(getButton("删除"));
		expect(container.textContent).toContain("确定删除？");
		await click(getButton("取消"));
		expect(onConfirm).not.toHaveBeenCalled();

		await click(getButton("删除"));
		await click(getButton("确定"));

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});
});

function ConfirmHarness({ onResult }: { readonly onResult: (value: boolean) => void }) {
	const requestConfirmation = useConfirm();
	return (
		<button
			type="button"
			onClick={() =>
				void requestConfirmation({
					title: "测试确认",
					message: "继续吗？",
					confirmText: "继续",
					cancelText: "返回",
				}).then(onResult)
			}
		>
			打开确认
		</button>
	);
}

async function render(node: ReactNode) {
	root = createRoot(container);
	await act(async () => {
		root?.render(node);
	});
	await flush();
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function pressKey(key: string) {
	await act(async () => {
		globalThis.dispatchEvent(
			new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
		);
	});
	await flush();
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

function getButton(label: string): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!button) throw new Error(`Button not found: ${label}`);
	return button;
}
