import type { Locale } from "@bilibili-notify/internal/i18n";
import ai from "./content/ai.md?raw";
import enAi from "./content/en/ai.md?raw";
import enLogin from "./content/en/login.md?raw";
import enOverview from "./content/en/overview.md?raw";
import enPush from "./content/en/push.md?raw";
import enRender from "./content/en/render.md?raw";
import enSubs from "./content/en/subs.md?raw";
import jaAi from "./content/ja/ai.md?raw";
import jaLogin from "./content/ja/login.md?raw";
import jaOverview from "./content/ja/overview.md?raw";
import jaPush from "./content/ja/push.md?raw";
import jaRender from "./content/ja/render.md?raw";
import jaSubs from "./content/ja/subs.md?raw";
import login from "./content/login.md?raw";
import overview from "./content/overview.md?raw";
import push from "./content/push.md?raw";
import render from "./content/render.md?raw";
import subs from "./content/subs.md?raw";
import twAi from "./content/zh-TW/ai.md?raw";
import twLogin from "./content/zh-TW/login.md?raw";
import twOverview from "./content/zh-TW/overview.md?raw";
import twPush from "./content/zh-TW/push.md?raw";
import twRender from "./content/zh-TW/render.md?raw";
import twSubs from "./content/zh-TW/subs.md?raw";

const zhCN = { overview, login, push, subs, render, ai };

/** 使用指引随全局语言切换；仍留在关于页的懒加载边界内，不改历史发行说明。 */
export const GUIDE_CONTENT = {
	"zh-CN": zhCN,
	en: {
		overview: enOverview,
		login: enLogin,
		push: enPush,
		subs: enSubs,
		render: enRender,
		ai: enAi,
	},
	ja: {
		overview: jaOverview,
		login: jaLogin,
		push: jaPush,
		subs: jaSubs,
		render: jaRender,
		ai: jaAi,
	},
	"zh-TW": {
		overview: twOverview,
		login: twLogin,
		push: twPush,
		subs: twSubs,
		render: twRender,
		ai: twAi,
	},
} satisfies Record<Locale, typeof zhCN>;
