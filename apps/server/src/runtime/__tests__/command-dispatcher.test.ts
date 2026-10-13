/**
 * 指令分发器 —— 主人在私聊里敲的指令,从这里认出来、校验参数、交出去。
 *
 * 这里守的重点是**口子有多窄**。通用分发器天生想对未知输入给回音(「无此指令」),
 * 而任何回音都是接口指纹 —— 试探者靠报错差异就能摸出指令表,而这条私聊通道的对面
 * 是主人的 B 站账号与推送控制权。所以顺序被钉死为**鉴权在前、解析在后**:
 * 没过门的连一个字都收不到,过了门的才有完整的报错与用法提示。
 *
 * 下面每条「静默」断言都在钉这件事:不只是「没执行」,而是**连 reply 都没有**。
 */

import { fail, type NotificationPayload, ok, type Result } from "@bilibili-notify/internal";
import { describe, expect, it, vi } from "vite-plus/test";
import { extractPrivateMessage } from "../../platforms/onebot-inbound.js";
import { createCommandDispatcher } from "../command-dispatcher.js";

/** 测试替身收口 —— 只填被读到的字段。 */
// biome-ignore lint/suspicious/noExplicitAny: 见上
type Any = any;

const logger = { debug() {}, info() {}, warn() {}, error() {} } as Any;

const MASTER = "10001";
const STRANGER = "20002";
const PLATFORM = "onebot";
/** 入站帧的来源。鉴权比的是三坐标,平台这一格得跟主人那条私聊对得上。 */
const META = { connectionId: "a1", platform: PLATFORM };

/** `null` = 主人私聊 user_id 没配上(不能用 undefined:默认参数会把它换成 MASTER)。 */
function makeDispatcher(
	commands: {
		name: string;
		aliases?: string[];
		signature?: string;
		// 老用例的 run 不返回东西:当成 ok()。要测失败 / 抛错的用例自己返回 fail() 或抛。
		// biome-ignore lint/suspicious/noConfusingVoidType: `async () => {}` 推出来的就是 Promise<void>
		run: (values: Any, ctx: Any) => Promise<Result | void>;
	}[],
	master: string | null = MASTER,
	prefix = "/",
	confirmation?: Any,
	log: Any = logger,
) {
	// 声明出入参:回给主人的**那句话**本身也是断言对象(比如未知指令时有没有连带
	// 给出建议),无参的替身会让 `mock.calls[0][0]` 连类型都取不到。
	const reply = vi.fn(async (_text: string) => {});
	// 回话经 `sendToAddress` 回到发指令的会话;文字载荷拆成 `reply` 的入参,方便按「那句话」断言,
	// 完整的 (连接, 会话, 载荷) 在 `sendToAddress` 上。
	const sendToAddress = vi.fn(
		async (_connectionId: string, _session: Any, payload: NotificationPayload) => {
			if (payload.kind === "text") await reply(payload.text);
			return ok({ latencyMs: 0 });
		},
	);
	// 配置是**现读**的:主人在面板上改完前缀 / 别名,reconcile 之后就该生效。
	const config = { enabled: true, prefix, aliases: {} as Record<string, string[]> };
	const dispatcher = createCommandDispatcher({
		logger: log,
		masterIdentity: () => (master === null ? undefined : { platform: PLATFORM, address: master }),
		sendToAddress,
		config: () => config,
		commands: commands.map((c) => ({
			...c,
			run: async (values: Any, ctx: Any) => (await c.run(values, ctx)) ?? ok(),
		})),
		confirmation,
	});
	return { dispatcher, reply, sendToAddress, config };
}

describe("鉴权门", () => {
	it("不是主人:handler 不跑,而且一个字都不回", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "状态" }, META);

		expect(run).not.toHaveBeenCalled();
		// 回「你没权限」等于告诉对方这里有个接口可以试探。
		expect(reply).not.toHaveBeenCalled();
	});

	it("🔴 号一样但平台不一样:不是主人", async () => {
		// OneBot 的 QQ 号与官机的 C2C openid 是两个命名空间。从前这里比的是一个裸
		// 字符串,撞上就等于把整条指令链路交给陌生人 —— 改配置、发推送、批准锐评。
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		// 正文带前缀 —— 不带的话这条消息本来就不会路由到 handler,测试会因为
		// 完全无关的原因变绿。
		await dispatcher.handleMessage(
			{ userId: MASTER, text: "/状态" },
			{ connectionId: "a2", platform: "qq-official" },
		);

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("路由", () => {
	it("主人发已知指令 → 交给对应 handler", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META);

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("参数", () => {
	it("按签名解析后再交给 handler —— handler 拿到的是已校验的值,不是原始文本", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "静音", signature: "<时长:duration>", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 3h" }, META);

		expect(run).toHaveBeenCalledWith({ 时长: 3 * 3600_000 }, expect.anything());
	});

	it("参数不合法 → 告诉主人哪里错了,而且**不进** handler", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([
			{ name: "静音", signature: "<时长:duration>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 一会儿" }, META);

		expect(run).not.toHaveBeenCalled();
		expect(reply).toHaveBeenCalledWith(expect.stringContaining("时长"));
	});
});

describe("前缀闸", () => {
	it("主人说别的话:不当指令,也不拿「无此指令」去打扰他", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "今天天气不错" }, META);

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	// 带了前缀 = 意图明确,这时才敢回「没这条指令」。不带前缀的话同一套逻辑会对主人
	// 的**每一句聊天**都回这句。
	it("带前缀但没这条指令 → 提示主人", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/不存在" }, META);

		expect(reply).toHaveBeenCalled();
	});

	// 一句「没有这条指令」把主人扔回去自己翻帮助,而他多半只是漏了个字母。
	it("敲错一点点 → 连带指出最近的那条", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "mute", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/mut" }, META);

		// 带上**当前**前缀,主人能直接照抄 —— 他把前缀改成 `bn ` 之后,写死 `/` 的
		// 建议就是一条敲了没反应的指令。
		expect(reply.mock.calls[0]?.[0]).toContain("/mute");
	});

	it("建议只看指令名那一截 —— 参数不该把距离撑爆", async () => {
		const { dispatcher, reply } = makeDispatcher([
			{ name: "mute", signature: "<时长:duration>", run: async () => {} },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/mut 3h" }, META);

		expect(reply.mock.calls[0]?.[0]).toContain("/mute");
	});

	it("别名同样能被指出来 —— 主人敲的是中文,回英文主名等于让他重学一遍", async () => {
		const { dispatcher, reply } = makeDispatcher([
			{ name: "mute", aliases: ["静音"], run: async () => {} },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静因" }, META);

		expect(reply.mock.calls[0]?.[0]).toContain("/静音");
	});

	// 指错一条比不指更糟:主人会照着敲第二次,发现还是不对,才开始怀疑我们。
	it("差太远就只说没有,不乱指", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "mute", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/天气预报" }, META);

		expect(reply).toHaveBeenCalledOnce();
		expect(reply.mock.calls[0]?.[0]).not.toContain("/mute");
	});

	// 强制联动优先:前缀为空时连「没有这条指令」都不说,建议自然更不能漏出去。
	it("前缀为空时,再像也不给建议", async () => {
		const { dispatcher, reply } = makeDispatcher(
			[{ name: "mute", run: async () => {} }],
			MASTER,
			"",
		);

		await dispatcher.handleMessage({ userId: MASTER, text: "mut" }, META);

		expect(reply).not.toHaveBeenCalled();
	});

	// 强制联动:前缀配成空,就必须退化成「认不出当没看见」。这两件事得在代码里绑死,
	// 不能只在 UI 上写行提示指望主人自己想明白 —— 他配出一个会打扰自己的组合,
	// 是我们的设计错误,不是他的操作错误。
	it("前缀为空时,认不出的输入必须静默", async () => {
		const { dispatcher, reply } = makeDispatcher(
			[{ name: "状态", run: async () => {} }],
			MASTER,
			"",
		);

		await dispatcher.handleMessage({ userId: MASTER, text: "今天天气不错" }, META);

		expect(reply).not.toHaveBeenCalled();
	});

	it("前缀为空时,整句精确匹配仍然有效", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "");

		await dispatcher.handleMessage({ userId: MASTER, text: "状态" }, META);

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("零回音(鉴权在解析之前)", () => {
	it("主人私聊目标没配:谁都不认,也不回", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }], null);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META);

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	// 这条最能说明顺序的意义:同样是「未知指令」,主人会收到提示,陌生人一个字都收不到。
	// 鉴权若写成路由里的中间件,这句提示就会先漏出去。
	it("陌生人发未知指令:同样零回音", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "/不存在" }, META);

		expect(reply).not.toHaveBeenCalled();
	});

	it("陌生人发合法指令带合法参数:照样不执行、不回音", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([
			{ name: "静音", signature: "<时长:duration>", run },
		]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "/静音 3h" }, META);

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("健壮性", () => {
	it("整句必须只有指令 —— 「看看状态吧」不触发", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "");

		await dispatcher.handleMessage({ userId: MASTER, text: "看看状态吧" }, META);

		expect(run).not.toHaveBeenCalled();
	});

	it("handler 抛错不该把这条入站链路带塌 —— 它还担着审批的 y/n", async () => {
		const boom = vi.fn(async () => {
			throw new Error("boom");
		});
		const { dispatcher } = makeDispatcher([{ name: "状态", run: boom }]);

		await expect(
			dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META),
		).resolves.toBeUndefined();
		expect(boom).toHaveBeenCalledOnce();
	});

	// 群消息进不来这儿:adapter 那层只把私聊交给指令分发(见 onebot-inbound.test 的
	// routeInboundFrame)。这里只剩「私聊帧归一化之后走得通」这一条链。
	it("OneBot 私聊帧经 adapter 归一化后走得通", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }]);

		const msg = extractPrivateMessage({
			post_type: "message",
			message_type: "private",
			user_id: MASTER,
			raw_message: "/状态",
		});
		if (!msg) throw new Error("私聊帧没解析出来");
		await dispatcher.handleMessage(msg, META);

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("确认流窗口(第二道门)", () => {
	/** 待确认队列的替身。dispatcher 不知道 y/n 这个语法,只问「消费了吗」。 */
	function makeConfirmation(waiting: boolean) {
		return {
			isWaiting: () => waiting,
			tryHandle: vi.fn(async (msg: { text: string }) => /^(y|n)$/i.test(msg.text.trim())),
		};
	}

	it("有待确认项时,y 交给确认流,不进指令表", async () => {
		const run = vi.fn(async () => {});
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([{ name: "y", run }], MASTER, "", confirmation);

		await dispatcher.handleMessage({ userId: MASTER, text: "y" }, META);

		expect(confirmation.tryHandle).toHaveBeenCalledOnce();
		expect(run).not.toHaveBeenCalled();
	});

	// 这是收编时顺带修掉的一个毛病:以前无条件解析 y/n,主人在私聊里随口打个 y
	// (英文聊天里很常见)就会收到「现在没有等待审批的锐评哦～」。草稿 TTL 有 48 小时,
	// 真要批准几乎不可能撞上超时;没待审时那个 y 就只是个普通字母。
	it("没有待确认项时,压根不问确认流 —— y 只是个普通字母", async () => {
		const confirmation = makeConfirmation(false);
		const { dispatcher, reply } = makeDispatcher(
			[{ name: "状态", run: async () => {} }],
			MASTER,
			"/",
			confirmation,
		);

		await dispatcher.handleMessage({ userId: MASTER, text: "y" }, META);

		expect(confirmation.tryHandle).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	it("确认流不认的输入继续往下走指令表", async () => {
		const run = vi.fn(async () => {});
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "/", confirmation);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META);

		expect(confirmation.tryHandle).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
	});

	it("确认流也在鉴权门之后 —— 陌生人的 y 碰不到它", async () => {
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([], MASTER, "/", confirmation);

		await dispatcher.handleMessage({ userId: STRANGER, text: "y" }, META);

		expect(confirmation.tryHandle).not.toHaveBeenCalled();
	});
});

describe("别名", () => {
	it("别名能触发,和主名等价", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "help", aliases: ["帮助", "?"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/帮助" }, META);
		await dispatcher.handleMessage({ userId: MASTER, text: "/?" }, META);
		await dispatcher.handleMessage({ userId: MASTER, text: "/help" }, META);

		expect(run).toHaveBeenCalledTimes(3);
	});

	// koishi 专门修过这个回归(`fix regression of command alias args`)—— 别名匹配
	// 只剥掉主名的长度,参数就跟着错位。它的别名还是硬编码的,我们的还让主人自己配。
	it("别名带参数 —— 参数不能因为别名长度不同而错位", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([
			{ name: "mute", aliases: ["静音"], signature: "<duration:duration|时长>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 3h" }, META);

		expect(run).toHaveBeenCalledWith({ duration: 3 * 3600_000 }, expect.anything());
	});

	it("没配别名的指令照常工作", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "status", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META);

		expect(run).toHaveBeenCalledOnce();
	});

	it("边界仍然要守 —— 「/静音吧」不该命中别名「静音」", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "mute", aliases: ["静音"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音吧" }, META);

		expect(run).not.toHaveBeenCalled();
	});
});

/**
 * 触发词冲突 —— 两条指令抢同一个词,只有一条会响,而且是**静默**的。
 *
 * 方案里点名过这个:主人给「周报」起了个别名叫「状态」,运行时二选一,他看到的是
 * 某条指令神秘失灵。别名将来是面板上可配的,所以这道判定迟早要被真实用户踩到 ——
 * 在注册那一刻就炸,比让他自己去猜哪条坏了强得多。
 */
describe("createCommandDispatcher — 触发词冲突", () => {
	const noop = async () => {};

	it("两条指令主名撞了 → 注册时就抛", () => {
		expect(() =>
			makeDispatcher([
				{ name: "report", run: noop },
				{ name: "report", run: noop },
			]),
		).toThrow(/report/);
	});

	it("别名撞了别的指令的主名 → 一样抛", () => {
		expect(() =>
			makeDispatcher([
				{ name: "status", run: noop },
				{ name: "report", aliases: ["status"], run: noop },
			]),
		).toThrow(/status/);
	});

	it("两条指令共用一个别名 → 一样抛", () => {
		expect(() =>
			makeDispatcher([
				{ name: "status", aliases: ["看看"], run: noop },
				{ name: "report", aliases: ["看看"], run: noop },
			]),
		).toThrow(/看看/);
	});

	it("互不相干的指令照常注册", () => {
		expect(() =>
			makeDispatcher([
				{ name: "status", aliases: ["状态"], run: noop },
				{ name: "report", aliases: ["周报"], run: noop },
			]),
		).not.toThrow();
	});
});

/**
 * 面板上的可配置项:总开关 / 前缀 / 别名。
 *
 * 配置改完走 `config-changed` 总线,dispatcher `reconcile()` 重建指令表 —— 前缀与
 * 总开关是每条消息现读的,别名要重建(它进了触发词表)。
 */
describe("配置", () => {
	const noop = async () => {};

	// 「关掉 = 整条入站链路只剩确认流」。**确认流不能一起关掉** —— 否则主人关一下
	// 指令,手里那份等审批的周报就再也批不掉了,而他多半想不到是这个开关干的。
	it("总开关关掉:指令不跑,但审批的 y/n 照常认", async () => {
		const run = vi.fn(async () => {});
		// 只认 y/n,别的原样放过 —— 真实的确认流就是这样,一律吞掉的替身会让
		// 「指令被总开关挡住」和「被确认流吃掉」两件事分不开。
		const confirmation = {
			isWaiting: () => true,
			tryHandle: vi.fn(async (msg: { text: string }) => /^(y|n)$/i.test(msg.text.trim())),
		};
		const { dispatcher, config } = makeDispatcher(
			[{ name: "status", run }],
			MASTER,
			"/",
			confirmation,
		);
		config.enabled = false;

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META);
		expect(run).not.toHaveBeenCalled();

		// 总开关关着,y 仍然进得了确认流(每条消息都会被问一次 —— 那正是
		// 「只剩确认流」的意思),而且是**被消费**的那一条。
		await dispatcher.handleMessage({ userId: MASTER, text: "y" }, META);
		expect(confirmation.tryHandle).toHaveBeenCalledWith(
			expect.objectContaining({ text: "y" }),
			META,
			expect.anything(),
		);
		expect(await confirmation.tryHandle.mock.results.at(-1)?.value).toBe(true);
	});

	// 关掉之后连「指令已关闭」都不回:他自己关的,不需要被提醒;而回音又会把这条
	// 私聊变回一个会插嘴的地方。
	it("总开关关掉:一个字都不回", async () => {
		const { dispatcher, reply, config } = makeDispatcher([{ name: "status", run: noop }]);
		config.enabled = false;

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META);
		expect(reply).not.toHaveBeenCalled();
	});

	it("前缀是现读的 —— 改完立刻按新的认", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([{ name: "status", run }]);
		config.prefix = "bn ";

		await dispatcher.handleMessage({ userId: MASTER, text: "bn status" }, META);
		expect(run).toHaveBeenCalledOnce();
	});

	it("配了别名 → 内置的那份被整份替换", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([{ name: "status", aliases: ["状态"], run }]);
		config.aliases = { status: ["看看"] };
		dispatcher.reconcile();

		await dispatcher.handleMessage({ userId: MASTER, text: "/看看" }, META);
		expect(run).toHaveBeenCalledOnce();
		// 整份替换:内置的「状态」已经不认了。区分「我不想要别名」和「我没动过」
		// 正是为此 —— 两者在盘上必须长得不一样。
		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META);
		expect(run).toHaveBeenCalledOnce();
	});

	it("别名配成空数组 → 只剩主名", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([{ name: "status", aliases: ["状态"], run }]);
		config.aliases = { status: [] };
		dispatcher.reconcile();

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META);
		expect(run).not.toHaveBeenCalled();
		await dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META);
		expect(run).toHaveBeenCalledOnce();
	});

	it("没配的指令继续用内置别名", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([
			{ name: "status", aliases: ["状态"], run },
			{ name: "mute", aliases: ["静音"], run: noop },
		]);
		config.aliases = { mute: ["安静"] };
		dispatcher.reconcile();

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META);
		expect(run).toHaveBeenCalledOnce();
	});

	// reconcile 是在 `config-changed` 的总线回调里被调的。那里抛出去 = 一个
	// unhandledRejection,而独立端装了处理器会**直接关掉整个进程** —— 一次手滑的
	// 别名配置不该有这种后果。保住上一份能用的表,记一条日志。
	it("重建撞车:保住上一份表,不抛", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([
			{ name: "status", aliases: ["状态"], run },
			{ name: "mute", run: noop },
		]);
		config.aliases = { mute: ["status"] };

		expect(() => dispatcher.reconcile()).not.toThrow();
		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, META);
		expect(run).toHaveBeenCalledOnce();
	});
});

/**
 * 手机输入法会把 `/mute` 自动首字母大写成 `/Mute`。严格比对的话主人得到的是
 * 「没有这条指令」,而他屏幕上那行字和帮助里印的看起来一模一样 —— 这种「明明照着
 * 抄的却不认」最劝退。触发词全是小写英文或中文,放宽大小写没有歧义代价。
 */
describe("大小写", () => {
	it("`/Mute` 认得出来", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "mute", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/Mute" }, META);

		expect(run).toHaveBeenCalledOnce();
	});

	it("大小写混排带参数也不错位", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([
			{ name: "mute", signature: "<duration:duration|时长>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/MuTe 3h" }, META);

		expect(run).toHaveBeenCalledWith({ duration: 3 * 3600_000 }, expect.anything());
	});

	it("别名同样宽容", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "report", aliases: ["Weekly"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/weekly" }, META);

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("run 的结果:失败由框架统一回话", () => {
	it("返回失败(敲的是本名)→ 会话里收到「『本名』没办成：原话」", async () => {
		const { dispatcher, reply } = makeDispatcher([
			{ name: "mute", aliases: ["静音"], run: async () => fail("invalid", "时长太长了") },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/mute" }, META);

		expect(reply.mock.calls).toEqual([["『mute』没办成：时长太长了"]]);
	});

	it("返回失败(敲的是别名)→ 填别名,不填内部的本名", async () => {
		const { dispatcher, reply } = makeDispatcher([
			{ name: "mute", aliases: ["静音"], run: async () => fail("invalid", "时长太长了") },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音" }, META);

		expect(reply.mock.calls).toEqual([["『静音』没办成：时长太长了"]]);
	});

	it("抛错 → 会话里收到「出错了，详情在日志里」,并记 error 级日志(带指令名与抛的内容)", async () => {
		const error = vi.fn();
		const { dispatcher, reply } = makeDispatcher(
			[
				{
					name: "status",
					run: async () => {
						throw new Error("boom");
					},
				},
			],
			MASTER,
			"/",
			undefined,
			{ ...logger, error },
		);

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META);

		expect(reply.mock.calls).toEqual([["出错了，详情在日志里"]]);
		expect(error).toHaveBeenCalledOnce();
		expect(error.mock.calls[0]?.[0]).toContain("status");
		expect(error.mock.calls[0]?.[0]).toContain("boom");
	});

	it("办成了 → 框架不多说一个字(只有指令自己的回话)", async () => {
		const { dispatcher, reply } = makeDispatcher([
			{
				name: "status",
				run: async (_v, ctx) => {
					await ctx.reply("在的");
					return ok();
				},
			},
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META);

		expect(reply.mock.calls).toEqual([["在的"]]);
	});

	it("失败那句话没送到:照「回话没送到」记 warn,不再套一层", async () => {
		const warn = vi.fn();
		const error = vi.fn();
		const dispatcher = createCommandDispatcher({
			logger: { ...logger, warn, error },
			masterIdentity: () => ({ platform: PLATFORM, address: MASTER }),
			sendToAddress: async () => fail("unavailable", "连接断了"),
			config: () => ({ enabled: true, prefix: "/", aliases: {} }),
			commands: [{ name: "status", run: async () => fail("unavailable", "x") }],
		});

		await expect(
			dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("连接断了"));
		expect(error).not.toHaveBeenCalled();
	});

	it("指令抛错、连「出错了」那句也回不出去(发送口自己拒绝):入站链路不塌,两头的原因各留一行", async () => {
		const warn = vi.fn();
		const error = vi.fn();
		const dispatcher = createCommandDispatcher({
			logger: { ...logger, warn, error },
			masterIdentity: () => ({ platform: PLATFORM, address: MASTER }),
			sendToAddress: async () => {
				throw new Error("派发器炸了");
			},
			config: () => ({ enabled: true, prefix: "/", aliases: {} }),
			commands: [
				{
					name: "status",
					run: async () => {
						throw new Error("boom");
					},
				},
			],
		});

		await expect(
			dispatcher.handleMessage({ userId: MASTER, text: "/status" }, META),
		).resolves.toBeUndefined();

		expect(error).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"));
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("派发器炸了"));
	});
});

describe("回话回到发指令的会话", () => {
	/** 发信人与来的连接,都和「主人目标那条连接」(这里没有)无关:回话只认这条消息自己。 */
	const FROM = { connectionId: "conn-from", platform: PLATFORM };

	it("指令的 ctx.reply 经 sendToAddress 回到这条消息的连接 + 发信人(私聊)", async () => {
		const { dispatcher, sendToAddress } = makeDispatcher([
			{ name: "状态", run: async (_v, ctx) => void (await ctx.reply("在的")) },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, FROM);

		expect(sendToAddress).toHaveBeenCalledExactlyOnceWith(
			"conn-from",
			{ scope: "private", address: MASTER },
			{ kind: "text", text: "在的" },
		);
	});

	it("分发器自己的回话(未知指令、参数写错)同样回到那里", async () => {
		const { dispatcher, sendToAddress } = makeDispatcher([
			{ name: "静音", signature: "<时长:duration>", run: async () => {} },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/不存在" }, FROM);
		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 一会儿" }, FROM);

		expect(sendToAddress).toHaveBeenCalledTimes(2);
		for (const call of sendToAddress.mock.calls) {
			expect(call[0]).toBe("conn-from");
			expect(call[1]).toEqual({ scope: "private", address: MASTER });
		}
	});

	it("确认流拿到的 ctx.reply 也回到那里", async () => {
		const confirmation = {
			isWaiting: () => true,
			tryHandle: vi.fn(async (_m: Any, _meta: Any, ctx: Any) => {
				await ctx.reply("收到");
				return true;
			}),
		};
		const { dispatcher, sendToAddress } = makeDispatcher([], MASTER, "/", confirmation);

		await dispatcher.handleMessage({ userId: MASTER, text: "y" }, FROM);

		expect(sendToAddress).toHaveBeenCalledExactlyOnceWith(
			"conn-from",
			{ scope: "private", address: MASTER },
			{ kind: "text", text: "收到" },
		);
	});

	it("每条消息各造各的 reply:连接换了,回话跟着换", async () => {
		const { dispatcher, sendToAddress } = makeDispatcher([
			{ name: "状态", run: async (_v, ctx) => void (await ctx.reply("在的")) },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, FROM);
		await dispatcher.handleMessage(
			{ userId: MASTER, text: "/状态" },
			{ connectionId: "conn-other", platform: PLATFORM },
		);

		expect(sendToAddress.mock.calls.map((c) => c[0])).toEqual(["conn-from", "conn-other"]);
	});

	it("reply 收消息体:图原样交给 sendToAddress", async () => {
		const image: NotificationPayload = {
			kind: "image",
			image: { buffer: Buffer.from([1, 2, 3]), mime: "image/png" },
		};
		const { dispatcher, sendToAddress } = makeDispatcher([
			{ name: "图", run: async (_v, ctx) => void (await ctx.reply(image)) },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/图" }, FROM);

		expect(sendToAddress).toHaveBeenCalledExactlyOnceWith(
			"conn-from",
			{ scope: "private", address: MASTER },
			image,
		);
	});

	it("没送到:记一条带原因的 warn,不抛,结果照样回给指令", async () => {
		const warn = vi.fn();
		const failure = fail("unavailable", "连接断了");
		let seen: Any;
		const dispatcher = createCommandDispatcher({
			logger: { ...logger, warn },
			masterIdentity: () => ({ platform: PLATFORM, address: MASTER }),
			sendToAddress: async () => failure,
			config: () => ({ enabled: true, prefix: "/", aliases: {} }),
			commands: [
				{
					name: "状态",
					run: async (_v: Any, ctx: Any) => {
						seen = await ctx.reply("在的");
						return ok();
					},
				},
			],
		});

		await expect(
			dispatcher.handleMessage({ userId: MASTER, text: "/状态" }, FROM),
		).resolves.toBeUndefined();

		expect(seen).toBe(failure);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("连接断了"));
	});
});
