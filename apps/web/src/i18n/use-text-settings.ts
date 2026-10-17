import { textSettingsOf } from "@bilibili-notify/internal/i18n";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../services/api";
import type { GlobalConfig } from "../types/globals";
import { i18n } from "./index";
import { writeLocalePreference, writeVoicePreference } from "./preference";

/**
 * 登录后把核心设置里的语言与口吻接到面板的字典 store,并记进浏览器(没登录时用)。
 * 挂在登录门之后的壳上;WS 的 `config-changed` 与重连都会失效 `["settings"]`,所以设置一变这里自然跟着。
 *
 * - 拿不到设置(`data` 是 `undefined`)≠ 设置里缺这一格:前者什么都不动。
 * - 设置里缺语言(0.x 升上来的由迁移写、新装的没选过):保持登录页正在用的语言,
 *   并把它 PATCH 进设置,**只写一次**;失败不写,下次登录(重新挂载)再试。
 */
export function useTextSettings(): void {
	const wrote = useRef(false);
	const { data } = useQuery({
		queryKey: ["settings"],
		queryFn: () => api.get<GlobalConfig>("/api/settings"),
	});

	useEffect(() => {
		if (data === undefined) return;
		const { voice } = textSettingsOf(data);
		const locale = data.locale ?? i18n.state().locale;
		i18n.set({ locale, voice });
		writeLocalePreference(locale);
		writeVoicePreference(voice);
		if (data.locale === undefined && !wrote.current) {
			wrote.current = true;
			// 失败就当没写:设置里仍缺这一格,下次登录再试;这里没有该提示用户的事
			api.patch("/api/settings", { locale }).catch(() => {});
		}
	}, [data]);
}
