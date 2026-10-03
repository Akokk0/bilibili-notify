// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	SUBSCRIPTION_TAGS_QUERY_KEY,
	useSubscriptionTags,
} from "../../../hooks/useSubscriptionTags";
import type { SubscriptionTag } from "../../../types/domain";
import { TagEditDialog } from "../TagEditDialog";

vi.mock("../../../services/api", async (importActual) => ({
	...(await importActual<typeof import("../../../services/api")>()),
	api: { get: vi.fn(), put: vi.fn() },
}));

import { ApiError, api } from "../../../services/api";

/**
 * 给订阅挑标签的弹框(ADR-0034):按标签表的顺序列出已有的,当前所挂的预勾;勾 / 取消即时改草稿;就地新建 =
 * 先 PUT 整张新表(旧表末尾追加)、成功了才勾上;点确定把最终勾选的 id 交给父层(父层再落盘)。
 */
const GAME: SubscriptionTag = { id: "11111111-1111-4111-8111-111111111111", name: "游戏" };
const CHAT: SubscriptionTag = { id: "22222222-2222-4222-8222-222222222222", name: "杂谈" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const put = api.put as ReturnType<typeof vi.fn>;

/** 像 Subs 那样:标签表住在 react-query 缓存里,弹框拿到的是读出来的那一份,PUT 成功写回缓存后弹框当场看见新标签。 */
function Harness(props: {
	current: string[];
	onConfirm: (next: string[]) => void;
	onCancel?: () => void;
}) {
	const tags = useSubscriptionTags().data;
	return (
		<TagEditDialog
			tags={tags}
			current={props.current}
			onConfirm={props.onConfirm}
			onCancel={props.onCancel ?? vi.fn()}
		/>
	);
}

function renderDialog(table: SubscriptionTag[] | undefined, props: Parameters<typeof Harness>[0]) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	if (table) qc.setQueryData(SUBSCRIPTION_TAGS_QUERY_KEY, table);
	return render(
		<QueryClientProvider client={qc}>
			<Harness {...props} />
		</QueryClientProvider>,
	);
}

const checkbox = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
const typeNew = (value: string) =>
	fireEvent.change(screen.getByPlaceholderText("新建标签名"), { target: { value } });

beforeEach(() => {
	// 服务端回存下的那张表;测试里就是请求体原样。
	put.mockImplementation((_path: string, body: unknown) => Promise.resolve(body));
	(api.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("TagEditDialog", () => {
	it("按标签表的顺序渲染所有标签,当前所挂的预先勾选", () => {
		renderDialog([GAME, CHAT], { current: [CHAT.id], onConfirm: vi.fn() });

		expect(screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual([
			"游戏",
			"杂谈",
		]);
		expect(checkbox("杂谈").checked).toBe(true);
		expect(checkbox("游戏").checked).toBe(false);
	});

	it("勾选一个未挂的标签 → 即时勾上(草稿变化)", () => {
		renderDialog([GAME, CHAT], { current: [], onConfirm: vi.fn() });

		fireEvent.click(checkbox("游戏"));

		expect(checkbox("游戏").checked).toBe(true);
	});

	it("确定 → 把最终勾选的 id(按勾选的先后)交给 onConfirm", () => {
		const onConfirm = vi.fn();
		renderDialog([GAME, CHAT], { current: [CHAT.id], onConfirm });

		fireEvent.click(checkbox("游戏")); // 追加
		fireEvent.click(screen.getByText("确定"));

		expect(onConfirm).toHaveBeenCalledWith([CHAT.id, GAME.id]);
	});

	it("取消 → onCancel,不 onConfirm", () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		renderDialog([GAME], { current: [GAME.id], onConfirm, onCancel });

		fireEvent.click(screen.getByText("取消"));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("确定时丢掉标签表里已经没有的 id(别处删了标签),不交给服务端挨 400", () => {
		const onConfirm = vi.fn();
		renderDialog([GAME], { current: ["99999999-9999-4999-8999-999999999999", GAME.id], onConfirm });

		fireEvent.click(screen.getByText("确定"));

		expect(onConfirm).toHaveBeenCalledWith([GAME.id]);
	});

	describe("就地新建", () => {
		it("先把整张新表(旧表末尾追加)PUT 出去,成功后新标签出现在列表里并勾上", async () => {
			const onConfirm = vi.fn();
			renderDialog([GAME, CHAT], { current: [], onConfirm });

			typeNew("  重点 ");
			fireEvent.click(screen.getByText("添加"));

			await waitFor(() => expect(checkbox("重点").checked).toBe(true));
			expect(put).toHaveBeenCalledTimes(1);
			const [path, body] = put.mock.calls[0] as [string, SubscriptionTag[]];
			expect(path).toBe("/api/subscriptions/tags");
			expect(body.slice(0, 2)).toEqual([GAME, CHAT]);
			expect(body).toHaveLength(3);
			expect(body[2].name).toBe("重点");
			expect(body[2].id).toMatch(UUID);
			// 新标签排在表的末尾。
			expect(screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual([
				"游戏",
				"杂谈",
				"重点",
			]);
			// 输入框清空;确定交出的就是新标签的 id。
			expect((screen.getByPlaceholderText("新建标签名") as HTMLInputElement).value).toBe("");
			fireEvent.click(screen.getByText("确定"));
			expect(onConfirm).toHaveBeenCalledWith([body[2].id]);
		});

		it("空白名:添加钮不可点,不 PUT", () => {
			renderDialog([GAME], { current: [], onConfirm: vi.fn() });

			typeNew("   ");

			expect((screen.getByText("添加").closest("button") as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(screen.getByText("添加"));
			expect(put).not.toHaveBeenCalled();
		});

		it("与已有标签重名:不 PUT,把已有的那个勾上", async () => {
			const onConfirm = vi.fn();
			renderDialog([GAME, CHAT], { current: [], onConfirm });

			typeNew(" 杂谈 ");
			fireEvent.click(screen.getByText("添加"));

			await waitFor(() => expect(checkbox("杂谈").checked).toBe(true));
			expect(put).not.toHaveBeenCalled();
			expect(screen.getAllByRole("checkbox")).toHaveLength(2);
		});

		it("PUT 被拒(400):把服务端的原因摆出来,不勾、不丢输入、表不动", async () => {
			put.mockRejectedValue(
				new ApiError(
					400,
					{ code: "invalid", message: "标签表有 1 格不合法：1.name：已经有一个叫「游戏」的标签了" },
					"标签表有 1 格不合法：1.name：已经有一个叫「游戏」的标签了",
				),
			);
			const onConfirm = vi.fn();
			renderDialog([GAME], { current: [], onConfirm });

			typeNew("重点");
			fireEvent.click(screen.getByText("添加"));

			const alert = await screen.findByRole("alert");
			expect(alert.textContent).toBe("标签表有 1 格不合法：1.name：已经有一个叫「游戏」的标签了");
			expect(screen.getAllByRole("checkbox")).toHaveLength(1);
			expect((screen.getByPlaceholderText("新建标签名") as HTMLInputElement).value).toBe("重点");
			fireEvent.click(screen.getByText("确定"));
			expect(onConfirm).toHaveBeenCalledWith([]);
		});

		it("重试成功后,上一次的错误提示撤掉", async () => {
			put.mockRejectedValueOnce(new ApiError(400, undefined, "标签表有 1 格不合法"));
			renderDialog([GAME], { current: [], onConfirm: vi.fn() });

			typeNew("重点");
			fireEvent.click(screen.getByText("添加"));
			await screen.findByRole("alert");
			fireEvent.click(screen.getByText("添加"));

			await waitFor(() => expect(checkbox("重点").checked).toBe(true));
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("标签表还没读到:不许新建 —— PUT 是整张换,拿不到旧表就建会把表洗成只剩新的那一个", () => {
			renderDialog(undefined, { current: [], onConfirm: vi.fn() });

			typeNew("重点");

			expect((screen.getByText("添加").closest("button") as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(screen.getByText("添加"));
			expect(put).not.toHaveBeenCalled();
			expect(screen.getByText(/标签表还没读到/)).toBeTruthy();
		});

		it("标签表没读到时点确定:原样交回当前挂的标签,不能洗成空(订阅原有的标签会被抹掉)", () => {
			const onConfirm = vi.fn();
			renderDialog(undefined, { current: [GAME.id], onConfirm });

			fireEvent.click(screen.getByText("确定"));

			expect(onConfirm).toHaveBeenCalledWith([GAME.id]);
		});

		it("空表:提示先新建一个", () => {
			renderDialog([], { current: [], onConfirm: vi.fn() });

			expect(screen.getByText(/还没有任何标签/)).toBeTruthy();
		});
	});
});
