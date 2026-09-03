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

import { describe, expect, it, vi } from "vite-plus/test";
import { extractPrivateMessage } from "../../platforms/onebot-inbound.js";
import { createCommandDispatcher } from "../command-dispatcher.js";

/** 测试替身收口 —— 只填被读到的字段。 */
// biome-ignore lint/suspicious/noExplicitAny: 见上
type Any = any;

const logger = { debug() {}, info() {}, warn() {}, error() {} } as Any;

const MASTER = "10001";
const STRANGER = "20002";

/** `null` = 主人私聊 user_id 没配上(不能用 undefined:默认参数会把它换成 MASTER)。 */
function makeDispatcher(
	commands: {
		name: string;
		aliases?: string[];
		signature?: string;
		run: (values: Any) => Promise<void>;
	}[],
	master: string | null = MASTER,
	prefix = "/",
	confirmation?: Any,
) {
	// 声明出入参:回给主人的**那句话**本身也是断言对象(比如未知指令时有没有连带
	// 给出建议),无参的替身会让 `mock.calls[0][0]` 连类型都取不到。
	const reply = vi.fn(async (_text: string) => {});
	// 配置是**现读**的:主人在面板上改完前缀 / 别名,reconcile 之后就该生效。
	const config = { enabled: true, prefix, aliases: {} as Record<string, string[]> };
	const dispatcher = createCommandDispatcher({
		logger,
		masterUserId: () => master ?? undefined,
		reply: reply as Any,
		config: () => config,
		commands,
		confirmation,
	});
	return { dispatcher, reply, config };
}

describe("鉴权门", () => {
	it("不是主人:handler 不跑,而且一个字都不回", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "状态" });

		expect(run).not.toHaveBeenCalled();
		// 回「你没权限」等于告诉对方这里有个接口可以试探。
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("路由", () => {
	it("主人发已知指令 → 交给对应 handler", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("参数", () => {
	it("按签名解析后再交给 handler —— handler 拿到的是已校验的值,不是原始文本", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "静音", signature: "<时长:duration>", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 3h" });

		expect(run).toHaveBeenCalledWith({ 时长: 3 * 3600_000 });
	});

	it("参数不合法 → 告诉主人哪里错了,而且**不进** handler", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([
			{ name: "静音", signature: "<时长:duration>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 一会儿" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).toHaveBeenCalledWith(expect.stringContaining("时长"));
	});
});

describe("前缀闸", () => {
	it("主人说别的话:不当指令,也不拿「无此指令」去打扰他", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "今天天气不错" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	// 带了前缀 = 意图明确,这时才敢回「没这条指令」。不带前缀的话同一套逻辑会对主人
	// 的**每一句聊天**都回这句。
	it("带前缀但没这条指令 → 提示主人", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/不存在" });

		expect(reply).toHaveBeenCalled();
	});

	// 一句「没有这条指令」把主人扔回去自己翻帮助,而他多半只是漏了个字母。
	it("敲错一点点 → 连带指出最近的那条", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "mute", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/mut" });

		// 带上**当前**前缀,主人能直接照抄 —— 他把前缀改成 `bn ` 之后,写死 `/` 的
		// 建议就是一条敲了没反应的指令。
		expect(reply.mock.calls[0]?.[0]).toContain("/mute");
	});

	it("建议只看指令名那一截 —— 参数不该把距离撑爆", async () => {
		const { dispatcher, reply } = makeDispatcher([
			{ name: "mute", signature: "<时长:duration>", run: async () => {} },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/mut 3h" });

		expect(reply.mock.calls[0]?.[0]).toContain("/mute");
	});

	it("别名同样能被指出来 —— 主人敲的是中文,回英文主名等于让他重学一遍", async () => {
		const { dispatcher, reply } = makeDispatcher([
			{ name: "mute", aliases: ["静音"], run: async () => {} },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静因" });

		expect(reply.mock.calls[0]?.[0]).toContain("/静音");
	});

	// 指错一条比不指更糟:主人会照着敲第二次,发现还是不对,才开始怀疑我们。
	it("差太远就只说没有,不乱指", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "mute", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/天气预报" });

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

		await dispatcher.handleMessage({ userId: MASTER, text: "mut" });

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

		await dispatcher.handleMessage({ userId: MASTER, text: "今天天气不错" });

		expect(reply).not.toHaveBeenCalled();
	});

	it("前缀为空时,整句精确匹配仍然有效", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "");

		await dispatcher.handleMessage({ userId: MASTER, text: "状态" });

		expect(run).toHaveBeenCalledOnce();
	});
});

describe("零回音(鉴权在解析之前)", () => {
	it("主人私聊目标没配:谁都不认,也不回", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run }], null);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	// 这条最能说明顺序的意义:同样是「未知指令」,主人会收到提示,陌生人一个字都收不到。
	// 鉴权若写成路由里的中间件,这句提示就会先漏出去。
	it("陌生人发未知指令:同样零回音", async () => {
		const { dispatcher, reply } = makeDispatcher([{ name: "状态", run: async () => {} }]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "/不存在" });

		expect(reply).not.toHaveBeenCalled();
	});

	it("陌生人发合法指令带合法参数:照样不执行、不回音", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, reply } = makeDispatcher([
			{ name: "静音", signature: "<时长:duration>", run },
		]);

		await dispatcher.handleMessage({ userId: STRANGER, text: "/静音 3h" });

		expect(run).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});
});

describe("健壮性", () => {
	it("整句必须只有指令 —— 「看看状态吧」不触发", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "");

		await dispatcher.handleMessage({ userId: MASTER, text: "看看状态吧" });

		expect(run).not.toHaveBeenCalled();
	});

	it("handler 抛错不该把这条入站链路带塌 —— 它还担着审批的 y/n", async () => {
		const boom = vi.fn(async () => {
			throw new Error("boom");
		});
		const { dispatcher } = makeDispatcher([{ name: "状态", run: boom }]);

		await expect(
			dispatcher.handleMessage({ userId: MASTER, text: "/状态" }),
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
		await dispatcher.handleMessage(msg);

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

		await dispatcher.handleMessage({ userId: MASTER, text: "y" });

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

		await dispatcher.handleMessage({ userId: MASTER, text: "y" });

		expect(confirmation.tryHandle).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	it("确认流不认的输入继续往下走指令表", async () => {
		const run = vi.fn(async () => {});
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([{ name: "状态", run }], MASTER, "/", confirmation);

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });

		expect(confirmation.tryHandle).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
	});

	it("确认流也在鉴权门之后 —— 陌生人的 y 碰不到它", async () => {
		const confirmation = makeConfirmation(true);
		const { dispatcher } = makeDispatcher([], MASTER, "/", confirmation);

		await dispatcher.handleMessage({ userId: STRANGER, text: "y" });

		expect(confirmation.tryHandle).not.toHaveBeenCalled();
	});
});

describe("别名", () => {
	it("别名能触发,和主名等价", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "help", aliases: ["帮助", "?"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/帮助" });
		await dispatcher.handleMessage({ userId: MASTER, text: "/?" });
		await dispatcher.handleMessage({ userId: MASTER, text: "/help" });

		expect(run).toHaveBeenCalledTimes(3);
	});

	// koishi 专门修过这个回归(`fix regression of command alias args`)—— 别名匹配
	// 只剥掉主名的长度,参数就跟着错位。它的别名还是硬编码的,我们的还让主人自己配。
	it("别名带参数 —— 参数不能因为别名长度不同而错位", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([
			{ name: "mute", aliases: ["静音"], signature: "<duration:duration|时长>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音 3h" });

		expect(run).toHaveBeenCalledWith({ duration: 3 * 3600_000 });
	});

	it("没配别名的指令照常工作", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "status", run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" });

		expect(run).toHaveBeenCalledOnce();
	});

	it("边界仍然要守 —— 「/静音吧」不该命中别名「静音」", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "mute", aliases: ["静音"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/静音吧" });

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

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" });
		expect(run).not.toHaveBeenCalled();

		// 总开关关着,y 仍然进得了确认流(每条消息都会被问一次 —— 那正是
		// 「只剩确认流」的意思),而且是**被消费**的那一条。
		await dispatcher.handleMessage({ userId: MASTER, text: "y" });
		expect(confirmation.tryHandle).toHaveBeenCalledWith(expect.objectContaining({ text: "y" }));
		expect(await confirmation.tryHandle.mock.results.at(-1)?.value).toBe(true);
	});

	// 关掉之后连「指令已关闭」都不回:他自己关的,不需要被提醒;而回音又会把这条
	// 私聊变回一个会插嘴的地方。
	it("总开关关掉:一个字都不回", async () => {
		const { dispatcher, reply, config } = makeDispatcher([{ name: "status", run: noop }]);
		config.enabled = false;

		await dispatcher.handleMessage({ userId: MASTER, text: "/status" });
		expect(reply).not.toHaveBeenCalled();
	});

	it("前缀是现读的 —— 改完立刻按新的认", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([{ name: "status", run }]);
		config.prefix = "bn ";

		await dispatcher.handleMessage({ userId: MASTER, text: "bn status" });
		expect(run).toHaveBeenCalledOnce();
	});

	it("配了别名 → 内置的那份被整份替换", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([{ name: "status", aliases: ["状态"], run }]);
		config.aliases = { status: ["看看"] };
		dispatcher.reconcile();

		await dispatcher.handleMessage({ userId: MASTER, text: "/看看" });
		expect(run).toHaveBeenCalledOnce();
		// 整份替换:内置的「状态」已经不认了。区分「我不想要别名」和「我没动过」
		// 正是为此 —— 两者在盘上必须长得不一样。
		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });
		expect(run).toHaveBeenCalledOnce();
	});

	it("别名配成空数组 → 只剩主名", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher, config } = makeDispatcher([{ name: "status", aliases: ["状态"], run }]);
		config.aliases = { status: [] };
		dispatcher.reconcile();

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });
		expect(run).not.toHaveBeenCalled();
		await dispatcher.handleMessage({ userId: MASTER, text: "/status" });
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

		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });
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
		await dispatcher.handleMessage({ userId: MASTER, text: "/状态" });
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

		await dispatcher.handleMessage({ userId: MASTER, text: "/Mute" });

		expect(run).toHaveBeenCalledOnce();
	});

	it("大小写混排带参数也不错位", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([
			{ name: "mute", signature: "<duration:duration|时长>", run },
		]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/MuTe 3h" });

		expect(run).toHaveBeenCalledWith({ duration: 3 * 3600_000 });
	});

	it("别名同样宽容", async () => {
		const run = vi.fn(async () => {});
		const { dispatcher } = makeDispatcher([{ name: "report", aliases: ["Weekly"], run }]);

		await dispatcher.handleMessage({ userId: MASTER, text: "/weekly" });

		expect(run).toHaveBeenCalledOnce();
	});
});
