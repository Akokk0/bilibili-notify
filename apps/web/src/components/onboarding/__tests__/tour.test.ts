/**
 * 导览(带我做)的判据跟随逻辑与脚本完整性。
 *
 * 形态定案(2026-08-29 二轮,主人拍板):控件级粒度 + 左下角伴随悬浮窗 +
 * 判据驱动为主 —— 主步(login/adapter/target/test/subs,五轮定稿顺序:先打通
 * 推送通道再订阅)的切换由机器判据驱动(activeKey 变了自动跳到新主步的第一个
 * 子步),主步内的子步才是手动翻页。
 *
 * 钉住:
 * - 判据**前进与回退都跟随**:回退=前置被破坏(退出登录/删连接),导览带
 *   用户回去补 —— 曾做成「只进不退」,真机退出登录后卡在连接步、登录被
 *   略过(2026-08-29 主人纠正)。「不回头」只约束交互层:没有「上一步」按钮;
 * - activeKey 没变 → 保持手动子步位置;
 * - 脚本完整性:五个主步都有子步、每个子步 route 都是站内路由、锚点在词表内、
 *   说明步(advanceOnRoute)不配锚点(它在目标页面上一帧都不停留)。
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";
import { listSources } from "../../../__tests__/walk";
import { i18n } from "../../../i18n";
import {
	MODAL_ONLY_ANCHORS,
	reconcileTourPos,
	STEP_DONE_MESSAGES,
	TOUR_ANCHORS,
	TOUR_SCRIPT,
} from "../tour-script";

beforeEach(() => i18n.set({ locale: "zh-CN", voice: "plain" }));

describe("reconcileTourPos 判据跟随", () => {
	it("初始(无位置)→ 落在当前 activeKey 的第一个子步", () => {
		expect(reconcileTourPos(null, "login")).toEqual({ stepKey: "login", subIndex: 0 });
	});

	it("判据前进(login 完成 → activeKey=adapter)→ 自动切到 adapter 第一子步", () => {
		expect(reconcileTourPos({ stepKey: "login", subIndex: 0 }, "connection")).toEqual({
			stepKey: "connection",
			subIndex: 0,
		});
	});

	it("判据回退(前置被破坏,如退出登录)→ 跟随回去补,不卡在做不了的后续步", () => {
		expect(reconcileTourPos({ stepKey: "connection", subIndex: 1 }, "login")).toEqual({
			stepKey: "login",
			subIndex: 0,
		});
	});

	it("activeKey 未变 → 保持手动子步位置", () => {
		expect(reconcileTourPos({ stepKey: "connection", subIndex: 2 }, "connection")).toEqual({
			stepKey: "connection",
			subIndex: 2,
		});
	});

	it("子步越界(脚本改短了)→ 收回最后一个子步", () => {
		const max = TOUR_SCRIPT.connection.length - 1;
		expect(reconcileTourPos({ stepKey: "connection", subIndex: 99 }, "connection")).toEqual({
			stepKey: "connection",
			subIndex: max,
		});
	});

	it("全绿(activeKey=null)→ done 祝贺态", () => {
		expect(reconcileTourPos({ stepKey: "subs", subIndex: 0 }, null)).toEqual({
			stepKey: "done",
			subIndex: 0,
		});
	});
});

describe("TOUR_SCRIPT 脚本完整性", () => {
	it("五个主步都有至少一个子步", () => {
		for (const key of ["login", "connection", "target", "test", "subs"] as const) {
			expect(TOUR_SCRIPT[key].length).toBeGreaterThan(0);
		}
	});

	it("每个子步的 route 是站内绝对路径,锚点(单值或链)在词表内,link(如有)也指站内", () => {
		for (const steps of Object.values(TOUR_SCRIPT)) {
			for (const sub of steps) {
				expect(sub.route.startsWith("/")).toBe(true);
				const chain = Array.isArray(sub.anchor) ? sub.anchor : sub.anchor ? [sub.anchor] : [];
				for (const anchor of chain) expect(TOUR_ANCHORS).toContain(anchor);
				for (const anchor of (sub.anchorOnFail ?? []).flat()) {
					expect(TOUR_ANCHORS).toContain(anchor);
				}
				if (sub.link) expect(sub.link.to.startsWith("/")).toBe(true);
				// 说明步抵达即流转,在目标页一帧都不停 —— 配 anchor 只会闪一下灯,纯 bug
				if (sub.advanceOnRoute) expect(sub.anchor).toBeUndefined();
			}
		}
	});

	it("失败链:表单锚点在链头(过弹窗即复原靠它),「配置」与「测试」同亮成组(锁着也两个动作都可点)", () => {
		const cases = [
			{
				sub: TOUR_SCRIPT.connection.at(-1),
				form: "connection-form",
				cfg: "connection-config",
				test: "connection-test",
			},
			{ sub: TOUR_SCRIPT.test[0], form: "target-form", cfg: "target-config", test: "target-test" },
		] as const;
		for (const { sub, form, cfg, test } of cases) {
			const chain = sub?.anchorOnFail ?? [];
			expect(chain[0], "链头必须是弹窗内的表单锚点,否则点「配置」再取消灯就失踪").toBe(form);
			const group = chain.find((e) => Array.isArray(e) && e.includes(cfg));
			expect(
				group,
				"「配置」必须和「测试」结成同亮组 —— 引导锁不放开,两个动作都得在洞内",
			).toContain(test);
		}
	});

	it("锚点链不能只有弹窗内挂点 —— 弹窗没开时灯必须有页面级目标可指(subs 步栽过)", () => {
		// 「哪些挂点只住在弹窗里」这条事实住在词表旁边(MODAL_ONLY_ANCHORS),
		// 不在这里抄一份 —— 抄的那份漏标一个不会红,只会悄悄放行一条永不亮的链。
		for (const steps of Object.values(TOUR_SCRIPT)) {
			for (const sub of steps) {
				const chains = [
					Array.isArray(sub.anchor) ? sub.anchor : sub.anchor ? [sub.anchor] : [],
					(sub.anchorOnFail ?? []).flat(),
				];
				for (const chain of chains) {
					if (chain.length === 0) continue;
					expect(
						chain.some((a) => !MODAL_ONLY_ANCHORS.has(a)),
						`「${sub.title}」的锚点链全在弹窗里,弹窗没开时灯永不亮`,
					).toBe(true);
				}
			}
		}
	});
});

describe("锚点与页面挂点不脱节", () => {
	it("每个子步 route 都有顶栏页签可聚(off-route 指路的前提;「带我去」已退役)", async () => {
		const { NAV_ITEMS } = await import("../../../config/nav");
		const navTos = new Set(NAV_ITEMS.map((i) => i.to));
		for (const steps of Object.values(TOUR_SCRIPT)) {
			for (const sub of steps) {
				expect(navTos.has(sub.route), `${sub.route} 不在导航表,聚光灯无页签可指`).toBe(true);
			}
		}
		// header 的 NavLink 真挂了指路挂点 —— 被重构删掉时这里拦住
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const headerSrc = readFileSync(resolve(__dirname, "../../header.tsx"), "utf8");
		expect(headerSrc).toContain("data-tour-nav={t.to}");
	});

	it("词表里每个锚点都真实挂在某个页面源码上", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		// 扫全站而不是列三个文件名:挂点搬去别的页面/拆进组件时,列表式的守卫会
		// 红在「文件名对不上」而不是「挂点没了」,人就学会改列表而不是信它。
		// 排除导览自己那一箱 —— 词表与脚本本身就写着这些词面,算进来条条都白给。
		const srcDir = resolve(__dirname, "../../..");
		const files = listSources(srcDir, { skipTestDirs: true }).filter(
			(f) => !f.includes("/components/onboarding/"),
		);
		expect(files.length).toBeGreaterThan(50); // 目录没扫到时别假绿
		const sources = files.map((f) => readFileSync(f, "utf8")).join("\n");
		for (const anchor of TOUR_ANCHORS) {
			// 挂点被重构删掉时这条会红 —— 导览会静默失去高亮,只有这里拦得住。
			// 匹配带引号的词面而非完整 `data-tour="…"`:条件挂点(如 target-test 只挂
			// 在未测通的行上)的词面在三元表达式里。
			expect(sources, `"${anchor}" 挂点不在任何页面上`).toContain(`"${anchor}"`);
		}
	});
});

it.each([
	[
		"en",
		[
			"Sign in to a source",
			"Choose the highlighted QR sign-in, scan with the source app, and confirm. After sign-in succeeds, the guide advances automatically.",
			"Choose a connection type first",
			"BN supports QQ Official Bot, OneBot clients such as NapCat, group bots for Feishu, DingTalk and WeCom, and unspecified HTTP endpoints. Their capabilities and deployment requirements differ. Read the connection guide before choosing.",
			"Connection guide",
			"Create a push connection",
			"Choose the highlighted “+ New” and select a platform. For QQ Official Bot, enter appId and appSecret, or use the form’s QR connection option to fill them in. For OneBot, choose a transport; reverse WebSocket is recommended, with a listening port. Then choose “Save”.",
			"Connection guide",
			"Test the connection",
			"Choose “Test” on the new connection. When it succeeds, the status indicator turns green and the guide advances. If it fails, follow the error message; for OneBot, first check that NapCat is connected.",
			"Add a push target",
			"Choose the highlighted “+ New push target”, select the connection, and choose where to send messages. For OneBot, enter a group number or QQ number. For QQ Official Bot, first send the bot a message in QQ, then select that conversation in the form. Save to continue.",
			"Send a test push",
			"Choose “Test” on the target. Once the test message arrives, the delivery path is working. The last step is to add a subscription.",
			"Add your first subscription",
			"Choose the highlighted “Add subscription”, search for a creator by name or ID, and subscribe from the results. Select the push target you just created. New posts and live starts will then be delivered automatically.",
			"Signed in!",
			"Connection is working!",
			"Push target created!",
			"Test message delivered. The delivery path is working!",
			"Subscribed. Setup is complete!",
		],
	],
	[
		"ja",
		[
			"ソースにログイン",
			"強調表示されたQRログインを選び、ソースのアプリで読み取って確認してください。ログインに成功すると、自動で次のステップに進みます。",
			"まず接続方式を選ぶ",
			"BNはQQ公式ボット、NapCatなどのOneBotクライアント、Feishu・DingTalk・WeComのグループボット、および汎用HTTPエンドポイントに対応しています。機能と導入の手間が異なるため、接続ガイドを読んでから選んでください。",
			"接続ガイド",
			"配信接続を作成",
			"強調表示された「+ 新規」を選び、プラットフォームを選択します。QQ公式ボットはappIdとappSecretを入力するか、フォーム内のQR接続機能で取得します。OneBotは接続方式を選びます。リバースWebSocketが推奨で、待ち受けポートを指定します。入力後に「保存」を選んでください。",
			"接続ガイド",
			"接続をテスト",
			"作成した接続の「テスト」を選んでください。成功すると状態が緑色になり、自動で次のステップに進みます。失敗した場合はエラーの説明を確認してください。OneBotでは、まずNapCatが接続されているかを確認します。",
			"送信先を追加",
			"強調表示された「+ 送信先を追加」を選び、接続と配信先を指定します。OneBotはグループ番号またはQQ番号を入力します。QQ公式ボットは、先にQQでボットへメッセージを送り、フォームでその会話を選んでください。保存すると次に進みます。",
			"テスト通知を送信",
			"送信先の「テスト」を選んでください。テストメッセージが届けば、配信経路は正常です。最後に購読を追加します。",
			"最初の購読を追加",
			"強調表示された「購読を追加」を選び、名前またはIDでクリエイターを検索して、結果から購読します。作成した送信先を選んでください。新しい投稿とライブ開始が自動で配信されるようになります。",
			"ログインしました！",
			"接続できました！",
			"送信先を作成しました！",
			"テストメッセージが届き、配信経路を確認できました！",
			"購読を追加しました。設定完了です！",
		],
	],
	[
		"zh-TW",
		[
			"登入來源",
			"選擇反白顯示的 QR Code 登入，用來源應用程式掃描並確認。登入成功後會自動進入下一步。",
			"先選擇連線方式",
			"BN 支援 QQ 官方機器人、NapCat 等 OneBot 用戶端、Feishu／釘釘／企業微信的群組機器人，以及未指定的 HTTP 端點。各自的功能與部署成本不同，請先閱讀連線選型指引再決定。",
			"連線選型指引",
			"新增推播連線",
			"選擇反白顯示的「+ 新增」並選擇平台。QQ 官方機器人需填入 appId／appSecret，也可使用表單中的掃碼連線功能自動填入。OneBot 請選擇連線方式，建議使用反向 WebSocket 並填入監聽連接埠，完成後選擇「儲存」。",
			"連線選型指引",
			"測試連線",
			"在剛建立的連線上選擇「測試」。成功後狀態指示會變成綠色，並自動進入下一步。若失敗，請依錯誤提示檢查；OneBot 請先確認 NapCat 已連線。",
			"新增推播目標",
			"選擇反白顯示的「+ 新增推播目標」，選取連線並指定訊息的目的地。OneBot 可直接填入群組號碼或 QQ 號碼；QQ 官方機器人需先在 QQ 傳送一則訊息給機器人，再於表單選擇該會話。儲存後會進入下一步。",
			"傳送測試推播",
			"在目標上選擇「測試」。收到測試訊息就代表推播路徑已通，只差最後一步：新增訂閱。",
			"新增第一筆訂閱",
			"選擇反白顯示的「新增訂閱」，依名稱或 ID 搜尋創作者，從結果新增訂閱並勾選剛建立的推播目標。之後的新作品與開播通知就會自動傳送。",
			"登入完成！",
			"連線已通！",
			"推播目標已建立！",
			"測試訊息已送達，推播路徑已通！",
			"訂閱成功，設定完成！",
		],
	],
] as const)(
	"%s reads translated step instructions and completion messages without changing tour positions",
	(locale, text) => {
		const refs = [
			TOUR_SCRIPT.login[0],
			...TOUR_SCRIPT.connection,
			TOUR_SCRIPT.target[0],
			TOUR_SCRIPT.test[0],
			TOUR_SCRIPT.subs[0],
		];
		const anchors = refs.map((s) => s.anchor);
		i18n.set({ locale, voice: "plain" });
		expect(refs.map((s) => s.title)).toEqual([
			text[0],
			text[2],
			text[5],
			text[8],
			text[10],
			text[12],
			text[14],
		]);
		expect(refs.map((s) => s.body)).toEqual([
			text[1],
			text[3],
			text[6],
			text[9],
			text[11],
			text[13],
			text[15],
		]);
		expect(TOUR_SCRIPT.connection.slice(0, 2).map((s) => s.link)).toEqual([
			{ to: "/about/guide", label: text[4] },
			{ to: "/about/guide", label: text[7] },
		]);
		expect(Object.values(STEP_DONE_MESSAGES)).toEqual(text.slice(16));
		expect(refs.map((s) => s.route)).toEqual([
			"/system",
			"/targets",
			"/targets",
			"/targets",
			"/targets",
			"/targets",
			"/subs",
		]);
		expect(refs.map((s) => s.anchor)).toEqual(anchors);
		expect(reconcileTourPos({ stepKey: "connection", subIndex: 1 }, "connection")).toEqual({
			stepKey: "connection",
			subIndex: 1,
		});
		i18n.set({ locale: "zh-CN", voice: "plain" });
		expect(refs[2].title).toBe("新建推送连接");
	},
);
