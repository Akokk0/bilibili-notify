/**
 * 老会话里的工具痕迹没有 `label` / `argText`(标签自带是后来的事)—— 读会话的回应里由服务端
 * 现补,面板才不必再自己抄一张「工具名 → 中文」的表。
 *
 * 钉三件事:① 核心的、注入的(挑带值翻译的卡种)老痕迹都补上了;② 认不出的工具名不补、本来就带
 * 标签的不改;③ **只补在回应里,盘上的文件逐字没变**。这里不 mock `@bilibili-notify/ai`:补法
 * 用的就是工具环发 start 事件时那同一个函数。
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { CONVERSATIONS_DIR, createConversationStore } from "../../ai/conversation-store.js";
import { createAiRoute } from "../ai.js";
import type { RouteDeps } from "../types.js";

async function setup() {
	const dataDir = await mkdtemp(join(tmpdir(), "bn-aitrace-"));
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const conversationStore = createConversationStore({ dataRoot: dataDir, logger });
	const deps = {
		store: { getGlobals: () => ({ ai: { enabled: true } }) },
		runtime: { serviceCtx: { logger }, conversationStore },
	} as unknown as RouteDeps;
	return { dataDir, conversationStore, app: createAiRoute(deps) };
}

describe("GET /conversations/:id —— 老痕迹现补标签", () => {
	it("核心的、注入的老痕迹补上 label / argText;认不出的不补;已带的不改;盘上文件不变", async () => {
		const { dataDir, conversationStore, app } = await setup();
		const conv = await conversationStore.create();
		await conversationStore.appendMessages(conv.id, [
			{ role: "user", content: "查一下" },
			{
				role: "assistant",
				content: "好",
				tools: [
					{ name: "get_user_info", args: { uid: "12345", name: "咩栗" }, ok: true },
					{ name: "get_user_stats", args: { uid: "12345" }, ok: true },
					{ name: "write_card", args: { skin: "abc", kind: "live" }, ok: true },
					{ name: "load_skill", args: { name: "weekly-report" }, ok: true },
					{ name: "list_subscriptions", args: {}, ok: true },
					{ name: "subscribe_user", args: { uid: "1" }, ok: false },
					{
						name: "get_user_videos",
						args: { uid: "1" },
						ok: true,
						label: "当时存下的名字",
						argText: "当时的入参",
					},
				],
			},
		]);
		const file = join(dataDir, ...CONVERSATIONS_DIR, `${conv.id}.json`);
		const before = await readFile(file, "utf8");

		const res = await app.request(`/conversations/${conv.id}`);
		const body = (await res.json()) as {
			conversation: { messages: Array<{ tools?: unknown[] }> };
		};

		expect(body.conversation.messages[1]?.tools).toEqual([
			{
				name: "get_user_info",
				args: { uid: "12345", name: "咩栗" },
				ok: true,
				label: "查看 UP 主资料",
				argText: "咩栗",
			},
			{
				name: "get_user_stats",
				args: { uid: "12345" },
				ok: true,
				label: "查看数据概览",
				argText: "12345",
			},
			{
				name: "write_card",
				args: { skin: "abc", kind: "live" },
				ok: true,
				label: "写卡片",
				argText: "直播卡",
			},
			{
				name: "load_skill",
				args: { name: "weekly-report" },
				ok: true,
				label: "使用技能",
				argText: "weekly-report",
			},
			{ name: "list_subscriptions", args: {}, ok: true, label: "查看订阅列表" },
			// 已下架、不在册的工具:不补,面板回落显示原名
			{ name: "subscribe_user", args: { uid: "1" }, ok: false },
			// 本来就带标签的原样保留(存下来的字不跟着现在的表变)
			{
				name: "get_user_videos",
				args: { uid: "1" },
				ok: true,
				label: "当时存下的名字",
				argText: "当时的入参",
			},
		]);
		expect(await readFile(file, "utf8")).toBe(before);
	});
});
