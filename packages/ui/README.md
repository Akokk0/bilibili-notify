# @bilibili-notify/ui

纯展示 React 基础件 + design tokens。**写任何 UI 之前先扫一遍下面的清单** —— 这里有的不许重写。

- **收录判据**:零业务依赖(不碰 api / store / react-query / 业务 schema)。缠业务的组件住 `apps/web/src/components`。
- **消费方式**:源码直出(`exports` 指 `src/index.ts`),消费方必须是 vite 系构建。入口 CSS 三件套:

  ```css
  @import "tailwindcss";
  @import "@bilibili-notify/ui/theme.css";
  @source "<相对入口 CSS 的 ../…/packages/ui/src>"; /* 让 Tailwind 扫到库组件里的 class */
  ```

- **消费者**:`apps/web`(Dashboard)、`apps/desktop`(启动页)。

## tokens(src/theme.css)

`@theme` 品牌调色板(`--color-bn-*` → `bg-bn-pink` 等 utilities)、明暗双套玻璃/页面变量(`--bn-glass-*` / `--bn-page-bg`,暗色走 `[data-theme="dark"]`)、`html/body` 基础皮肤、`.bn-glass` / `.bn-glass-strong` 玻璃面、`bn-pulse|spin|fade-in|page-in|drawer-in` 动效(页面根一律 `page-in`、抽屉用 `drawer-in`——都是纯位移;`fade-in` 这类 opacity 动画挂在玻璃卡祖先上会瞬时杀掉磨砂)、`.bn-no-scrollbar`。品牌色的另一份正本在 `packages/image/src/styles.ts`(SSR 渲染器),改色要两边同步。

## 组件清单

### atoms

| 组件 | 干什么 / 长什么样 |
| --- | --- |
| `Avatar` | 圆头像:有 `url` 显图,没有显首字母渐变底;`status` 加 LIVE 角标或呼吸点 |
| `Btn` | 按钮,7 变体(`primary` 粉实底 / `blue` 蓝实底 / `ghost` / `outline` 中性描边 / `danger` 纯红字 / `danger-outline` 红描边 / `danger-solid` 红实底)× 3 尺寸。**`danger` 与 `danger-outline` 的区别只在那圈边**(纯红字钮夹在说明文字里认不出可点),行内小钮的底保持透明;`danger-solid` 是确认弹窗「确认销毁」那一档,分量与 `primary` 对等。**实心底档(primary/blue/danger-solid)一律挂 `btn btn-primary` 双挂点、前景走 `on-solid` token** —— 单挂 `btn` 会被皮肤刷成中性底,实底前景浮上去就隐形(爱发电按钮的车;守卫在 web 的 skin-hook-coverage 测试) |
| `Pill` | 圆角小徽章(**不可点**的 `<span>`);`subtle` = 12% 底色染色字,否则实底白字 |
| `IconButton` | 只装一枚图标的方钮/圆钮(关闭 / 移除 / 箭头)。五档 `size`(xs 16 → xl 36)、三档 `tone`(**只管 hover 语义**,静态字色一律 tertiary)、`shape=pill`、`surface` 两档:`filled` 描边面底(要从背景里浮出来),`scrim` 遮罩 + 磨砂 + on-solid 字色(**压在图片 / 渐变上**的那种,底下是任意内容,tertiary 灰不可读 —— 这一档连静态字色一起换,不能只叠一层)。`label` 必填(图标没文字),tooltip 要另写才给 `title`。`className` **只收定位这类不冲突的**工具类(`absolute`/`opacity-0 group-hover:*`),覆盖本体是覆盖不住的 —— 要改本体就加档 |
| `AddButton` / `AddCard` / `AddFileButton` | 「这里还能再加一个」的虚线语汇(虚线=空位,指上去变粉=点我)。`AddButton` 行内走药丸、`block` 占整行走卡片圆角;`AddCard` 是网格里的一格,＋/标题/副标题**由组件出**,调用方只给文字;`AddFileButton` 是 file-input 变体(`<label>` 裹隐藏 input,上传中换句提示并禁用),形状/字号走 `className`。三者共用一份 `ADD_LANGUAGE` |
| `MenuItem` | 弹层(下拉 / 右键菜单 / 附件菜单)里的一整行:图标槽 + 内容,`active` 染粉加粗、`danger` 整行连图标转红。行内有副标题时**必须给 `ariaLabel`**,否则读屏器把标题和小字连起来念。**刻意不挂 `data-bn`** —— 皮肤给按钮写的实底落到每行菜单上很难看,而词表里没有 `menu-item` 这一档;浮层本体自己挂了 `glass-strong` |
| `ToneChip` | 「一排里选一个/开一个」的**可点**胶囊:选中 = 12% `tone` 底 + **实色 `tone` 边** + 正文色字,未选中退中性描边 + 悬停变正文色。**`tone` 不承担可读性**(当字色时字底同色相,亮色下 warn 只有 1.90:1),色彩识别交给实色边框。自带 `data-bn="btn"`;`tone` 收 hex **或** `var()`(内部 `color-mix`),纯操作钮可不填。别拿 `Pill` 套 `onClick` 顶替它 |
| `Toast` | 一句话瞬时提示(「已复制」「已保存失败」)。自己**不计时**,挂上撤下由调用方管 —— 但「停多久」走同包导出的 `TOAST_DURATION_MS`,别各拍各的(收编前三个调用方是 2000 / 2000 / 2400)。三条取值不许改:① 字色恒 `text-bn-text-primary`,**不写死白字** —— 底能被皮肤重绘、写死的字色不能,两者一起就是白底白字;② 语义走**描边**不走实心底(同 `ToneChip` 的道理);③ 钉**底部居中**,右下角是推送 toast 那一摞的地盘。自带 `data-bn="glass-strong"`。通知中心那种带图标/时间的富卡片不归它管 |
| `StatusDot` | 语义色状态点(`live/living` 粉+呼吸、`ok` 绿、`warn` 橙、`err` 红、`off`/`pending` 两档灰)。七档**全走 token**,跟皮肤换装;两档灰不许并成一个(`off` 走 textDisabled 浅、`pending` 走 textTertiary 深,靠深浅分「关着的」与「等着的」)。`size`:`md`(默认)8px 状态点、`sm` 6px 行内图例;逐项动态的图例色(模块 tone / 版式 accent)走 `color` 口盖档位色,与 `kind` 二选一 —— **能用语义档就别用 color** |
| `Toggle` | 开关(粉=开),`sm`/`md`;`ariaLabel` 给读屏器命名 |
| `Input` | 带可选前置 icon 的单行输入框 |
| `CheckRow` | 多选列表的选项行:粉勾选方块 + 文本,checkbox 本体 sr-only |
| `ErrorNote` | 「XX 失败:…」红字提示盒的唯一写法。恒 `role="alert"`(21 个调用点无一例外都是「出错了才渲染」)。可选 `icon` 左槽;`size` 三档**是三种位置**不是口味:`sm` 密集卡片内(UpCard 整卡只有 10~11px)、`md` 默认给表单面板、`lg` 给消息流里的横幅(AI 聊天正文 13px)。外边距走 `className`。自带 `data-bn="note note-danger"` |
| `WarnNote` | 「做完了但有几处没照办」黄字提示盒的唯一写法;`size` 两档与 `ErrorNote` 对齐(有了它「红/黄双色同形」的一对才写得出来);**行高与外边距走 `className`**。自带 `data-bn="note note-warn"` |
| `EmptyNote` | 「这里还什么都没有」中性虚线框的唯一写法;`md`(默认)给整块面板的空态、`sm` 给表单小节里内嵌的一行。**只此两档** —— 收编前站内九份手写在四种圆角三种字号之间漂。自带 `data-bn="note note-empty"`(**虚线是它的语义**,皮肤那头的 NOTES 也这么嘱咐) |
| `Spinner` | 品牌色圆环加载指示(淡粉底环 + 粉顶弧) |
| `PlatformIcon` / `platformLabel` / `platformTint` | 推送平台图标、显示名与**标识色**(onebot / qq-official / webhook)。三者同一张表 —— 色也导出,是因为不导出就只能在页面里照抄一份(Targets 就抄过,连兜底的灰都一字不差);认不出的平台退 `--color-bn-inactive` |
| `StatsBar` | 迷你堆叠柱状图(live/dyn/sc/guard 四段,由高到低堆)。**`colors` 必填,库里不留默认值** —— 那四段是推送家族色,唯一出处 `push-kinds.ts` 在业务侧,平台中立的库取不到;给默认值等于把此前那份写死的副本原样留下 |
| `Section` / `Row` | 抽屉与面板里的「小节标题 + 行列表」骨架 |
| `NoticeStack` / `NoticeCard` | 角落通知栈(portal + fixed 角落 + aria-live)与富通知卡(图标片 + 标题/时间行 + 正文 + 关闭钮,挂 `glass-strong`)。推送 toast(右下 polite)与组件告警(右上 assertive)共用;**颜色语义全留调用方** —— 逐 kind 染色走 `tileStyle`、静态语义配色走 `tileClassName`/`titleClassName`/`style`。`time` 收**预格式化**字符串(toast 到分、告警到秒,精度是语义)。一句话瞬时提示别用它,那是 `Toast` 的活 |

**提示盒三兄弟(`ErrorNote` / `WarnNote` / `EmptyNote`)共用一套尺寸阶梯** —— `sm` = `rounded-md` 11.5px、`md` = `rounded-lg` 12.5px、`lg` = `rounded-xl` 13px。它们说的是同一类话,只该差颜色不该差形状;此前三个各写各的,同一个弹窗里「保存失败」与「有几处没照办」长成两种控件。阶梯**只管圆角与字号**,内边距各归各的(空态盒撑满面板留白、红盒挤在字段之间,那是位置不是漂移)。`packages/ui/src/__tests__/note-family.test.tsx` 钉着这条。

### 表单受控件(form-controls)

| 组件 | 干什么 / 长什么样 |
| --- | --- |
| `TInput` / `TArea` / `TNum` / `TSelect` / `TColor` | 设置表单的 T 系列受控件:全部自带 `data-bn="input"` 挂点与 `bg-bn-field` 底;`secret` 走 password 型防明文;`ariaLabel` **不是装饰**(label 包裹场景读屏器会念整段提示);定宽走 `width` 数字(没装 tailwind-merge,`w-*` 类压不掉基线)。与 `Input` 的分工:`Input` 是带图标槽的搜索框原语,T 系列是设置表单家族 |
| `Picker` | 通用段选钮组(选项 ≤ ~5 用它别用 TSelect):挂 chip/chip-active、带 `aria-pressed`;`color` 是逐项语义色 |
| `ArrayEditor` / `QuietHoursEditor` | 「一列可增删的行」的两个特化:字符串行 / 免扰时段(0-23 整点对,跨午夜 start>end)。行号徽标 / 移除钮 / 虚线添加钮是**不导出**的实现细节 |

缠业务字典的两件**刻意不在库里**:`Field`(FIELD_LABELS code 体系 + data-code 灵动岛锚点)与 `LogLevelPicker`(LOG_LEVEL_TONE 色表)住 `apps/web/src/components/forms.tsx`,那边同时转口本节全部导出。

### 玻璃卡

| 组件 | 干什么 / 长什么样 |
| --- | --- |
| `GlassPanel` | 轻玻璃面板:标题/副标题/右槽/accent 渐变角光 + icon 方块。`accent` 收十六进制**或** `var(--color-bn-*)`(内部用 `color-mix()` 造透明度);缺省 = `var(--color-bn-pink)`,跟皮肤换装 |
| `GlassStatCard` | 数字大卡:label + 等宽大数字 + 可选呼吸点/footer;`color` 同 `GlassPanel.accent`,hex 与 `var()` 都收 |
| `GlassBox` | 重玻璃分区卡(Rules/Cards/AI 页那种):icon 芯片 + badge + 右侧动作槽 + 分隔线 |
| `CollapseBlock` | GlassBox 内的「开关折叠块」:关=灰、开=accent 染色并展开 children |
| `LoadingBlock` | 等待占位:Spinner + 提示语(可选第二行小字),`role=status`。`variant="card"`(默认)自带玻璃底,给直接坐在页面背景上的等待态;`variant="inset"` 去掉玻璃底,给**已经在别人卡里**的位置(否则玻璃叠玻璃)。「正在读取…」一律用它,别再裸写一行字 |

### 弹窗

| 组件 | 干什么 / 长什么样 |
| --- | --- |
| `PopoverShell` | 贴着触发器弹出的**浮层面板** —— 装 `MenuItem` 的那个壳。圆角/阴影/挂点由壳子定死;开口每样都对应真实的调用方分歧:`align`(贴左/贴右/`stretch` 两边都贴,输入框上方那种同宽浮层)、`side`(`bottom` 默认 / `top` 朝上开 —— 聊天输入区那两个就是,收编第一轮正是因为这个被漏掉)、`variant`(`inset` 默认给 MenuItem 留呼吸位 / `flush` 内容贴边 / `panel` 自定义面板)、`layer`(走分层表,该不该统一没查清)、`surface`(`solid` 菜单实底 / `solid-strong` 压在消息流之上那档 / `glass` 强玻璃 —— 顶栏那个标签面板挑强档是有实测理由的,见组件注释)、`role` + `ariaLabel`(**不是外观档**:菜单是 `menu`、候选列表是 `listbox`,读屏器靠它判断里面装的是什么)。**定位的 `relative` 包裹由调用方给**(触发器与浮层的相对关系只有它知道);`ref` 收着,「点外面关掉」几乎人人要。收编前六处各写各的:四种圆角、三种底、三种边、两种阴影、两种挂点写法,连里面装的全是 `MenuItem` 的两处都一个有内边距一个没有 |
| `ModalShell` | 弹窗骨架:portal 到 body、遮罩 + 居中卡、ESC/点遮罩关闭;body padding 可覆盖。**标题走 `title`(+可选 `description`),别自己写标题行** —— 字号与间距由壳子出、不留口子,此前 11 个弹窗各写各的,漂成 14/15/16px 三种字号与四种下边距。自绘表头(封面渐变那种)才两个都不传 |
| `ConfirmDialog` | ModalShell 之上的「确认/取消」轻对话框,`danger` 换红确认钮 |
| `DrawerShell` | 右侧滑出的**非模态**玻璃抽屉:portal 到 body、全高内滚、ESC 关闭、无遮罩(页面保持可见可交互,实时调参工作台用) |

### 导航

| 组件 | 干什么 / 长什么样 |
| --- | --- |
| `SectionNav` / `RailDot` | 页面分区导航,双形态:xl+ 左侧竖栏,窄视口顶部横向 chip 条(sticky) |
| `TabBarShell` / `TabButton` | 页面级 tab 条的外壳与单钮(选中=粉渐变实心);要逐项自定义内容时用这对原语 |
| `TabBar` | 一条普通的 N 项 tab(内部就是上面两件拼的),带右侧 hint 槽 |

### 其他

| 导出 | 干什么 |
| --- | --- |
| `Icon` / `IconName` | 内联 SVG 图标注册表(currentColor 染色),几十枚;加新图标进这里,别散落内联 |
| `FieldUpdatesProvider` / `useFieldUpdate` / `useFieldReset` | 「字段默认值有更新/可还原」的广播 context;无 Provider 时恒 null |
| `useDismiss` | 「点外面关掉」的唯一写法(住 popover.tsx)。`enabled` 只在浮层开着时挂监听、`escape` 连 Esc 一起关、`event` 选 mousedown/pointerdown —— 收编前五份手写行为各漂各的,差异现在是调用点上显式的选项 |

## 维护约定

- **别把皮肤挡在门外**(同一个模式已复发三回:tab 条那排、Subs/History 的筛选胶囊、Toggle):
  - **圆角走轴**。可点控件用 `rounded-bn-pill`(或 `rounded-bn-card`),**不写死 `rounded-full`** —— 写死的话皮肤把 `radius.pill` 调到 0 求一身硬直角也掰不直它。真正必须是**正圆**的(头像、状态点、光斑)照写 `rounded-full`,那是设计要求不是疏忽。
  - **颜色走 token**,`#d8d8d8` 这种字面值皮肤搬不动。**属性也一样** —— `accent="#FB7299"` 与 `accent="var(--color-bn-pink)"` 在默认装下像素级一致,差别只在装了皮肤之后:前者永远钉在 B 站粉。`color-token-conformance.test.ts` 拦「颜色属性写了与 token 同值的 hex」,带写明理由的豁免表。判据是**同值**而不是**是个 hex**:站里有一批刻意不跟皮肤的产品语言色(`config/push-kinds.ts`,「直播是粉的、动态是蓝的」,重上色会让两种 kind 撞成一色)住在常量色表里,那种写法(`tone: "#…"`)天然不在网内,引用它就写 `color={PUSH_TONE.live}`。同一份守卫另拦**原生 Tailwind 调色板类与任意值 hex 类**(`text-gray-500` / `bg-white` / `bg-[#0f1115]`)—— 那三种写法编译成固定色值,`--color-bn-*` 那一层根本不经过,三个端全扫且不留白名单。真的该恒定的东西也走 token:日志控制台与代码块那块暗面是 `--color-bn-console-*`,值固定、不进皮肤词表,但集中在一处 —— 收编前两处各写死一份,圆角与正文色都飘成了两副样子。
  - **透明度走 `color-mix()`,不许拼 hex alpha 后缀**。`` `${accent}44` `` 有两个静默死法:传 `var()` 拼出 `var(--color-bn-pink)44`、传 3 位 hex 拼出 `#8881f`,都是非法值、都被浏览器直接丢弃、都不会红。而且它反过来逼所有调用方只能传十六进制 —— 颜色也就跟不了皮肤。写 `color-mix(in srgb, X N%, transparent)`,三种入参都收。同一份守卫拦这条。
  - **圆角一律不许落在 `style={{…}}`**;颜色只有**逐项动态**的那一种可以(每个选项各异的语义色,如 `ToneChip` 的 `tone`、`GlassPanel` 的 `accent`、`Pill` 的 `color`)。**静态的、可换肤的颜色必须走 class** —— inline 压过一切 author 样式,皮肤连覆盖的机会都没有,而且 inline **没有 `:hover`**(`ToneChip` 初版把未选中态三色写进 inline,四颗胶囊当场集体丢了悬停反馈)。写死的动态值放 CSS 变量,`style` 里只留真正的运行时几何量(宽高、位移)。
  - **页面里手写的 `<button>` 记得挂 `data-bn`**。`skin-hooks.test.tsx` 只管库里那几个组件;两边全部手写按钮的覆盖由 `apps/web/src/__tests__/skin-hook-coverage.test.ts` 兜底 —— 它扫 `apps/web/src` 与 `packages/ui/src` 全 .tsx,不挂点就得进那份**写明理由**的豁免名单(下拉菜单行、列表行、透明覆盖层、纯文字链接、以及挂上会毁掉语义的开关类,才是合理的不挂)。
  - **手写的输入框同理**,由 `apps/web/src/__tests__/input-hook-coverage.test.ts` 兜底:除挂点外它还钉住**底色 token** —— 输入面走 `bg-bn-field`,不走 `bg-bn-surface`。这条只能静态扫:亮色下两个 token 都是 `#ffffff`,肉眼与截图都验不出来,暗色下才分开(`theme.css` 的 elevation 阶梯是 muted < **field(输入)** < surface(卡片) < strong(弹窗)),而且 `field` 在皮肤契约里是独立一键,写错 token 等于那一键够不着它。能直接用 `apps/web` 的 T 系列(`TInput` / `TArea` / `TNum` / `TSelect`)就别手写,它们四件都自带挂点与正确底色。
  - **两栏骨架走 `xl:grid-bn-rail`**,不手写 `xl:grid-cols-[220px_1fr]`。`SectionNav` 那五页共用这个骨架,收编前六处逐字节相同 —— `section-nav.tsx` 的注释里还得三次把类名抄出来解释自己跟谁配对。栏宽在 `--bn-rail-width`,**皮肤能调**(`SKIN_LIMITS.railWidth`,160~320);`grid` 与 `gap-4` 留在调用方(各页真的可能不同)。
  - **字号走阶梯**。九档在 `theme.css` 的 `--text-bn-*`(micro 9 → 2xs 10 → xs 11 → sm 12 → base 13 → md 15 → lg 17 → xl 20 → hero 28),写 `text-bn-xs` 而不是 `text-[11px]`。收编前 454 处写死的字号漂成 21 个值,半档遍地 —— 同样是配 `text-bn-text-tertiary` 的小字注脚,10 / 10.5 / 11 / 11.5 四个档都有人用。**不像圆角那样接成派生轴**:字号派生出小数会糊,而且九档下半段是 +1 密排、上半段越拉越开,一根系数表达不了。相对单位(`text-[0.88em]`,markdown 行内 code 比父级小一点)不在网内。**九档刻意不进皮肤词表** —— 开了就是大字模式,而阶梯不是等比的(下半段 +1 密排、上半段越拉越开),没法像圆角那样一根系数整体缩放;逐档开九个键则挡不住有人把 `xs` 调得比 `sm` 大,版式主次当场反过来。栏宽是反例,它开了:单个数字、两头夹死、调坏了最多是左栏胖瘦。注意 `text-` 横跨两个 namespace —— `text-bn-xs` 是字号、`text-bn-text-primary` 是颜色,守卫按 `--text-*` / `--color-*` 分开查。
  - **叠放层级走分层表**。`theme.css` 里一张 `--z-bn-*` 定死谁盖谁(raised 10 卡内抬升 → local 20 局部弹层 → nav 30 页面导航 → header 35 吸顶栏 → scrim 40 整页遮罩 → overlay 50 → menu 60 → toast-base 80 → island 100 → notify 200 → modal 300 → preview 500),写 `z-bn-modal` 而不是 `z-300`。收编前这 12 档散在十来个文件里,加一层浮层只能翻别处的 className 猜个不撞的数字 —— `header.tsx` 与 `draft-island.tsx` 的注释里各存了半张手写对照表就是这么来的。z-index 没有 Tailwind theme namespace,那一族和 shadow 一样手写 `@utility`。`color-token-conformance.test.ts` 拦裸数字,并钉住用到的每个 `z-bn-*` 在表里真有定义。
  - **Toggle 例外:不许挂 `btn`**。皮肤给按钮写的实底会盖掉轨道背景,开关的开/关当场看不出来。
- **文字挑档按名字语义,别按当下看到的深浅**:`text-primary`(标题/人名)> `text-secondary`(正文、说明、区块标签)> `text-tertiary`(UID、时间戳、协议行、图标字形)> `text-disabled`(禁用/轨道底),四档在亮暗两套里**同向**。亮色默认装曾从设计稿原样抄来一份**反的**(secondary #999 比 tertiary #666 还淡),于是同一个 className 在亮色下是最淡一档、在暗色和每一套皮肤里都是较重一档,`hover:text-bn-text-secondary` 这种「悬停变亮」的写法当场变淡。`apps/web/src/__tests__/theme-conformance.test.ts` 现在按对比度拦单调性、档距(≥1.25×)与 AA 底线。
- **`data-bn` 皮肤挂点是公开 API**:皮肤自定义 CSS 只能瞄准 `SKIN_CSS_HOOK_MAP`(contract skin.ts)里的挂点。映射到 `[data-bn~=…]` 的 hook 由组件真实背着属性(Btn=`btn`/`btn-primary`、Input 外框=`input`、Avatar 根=`avatar`、ModalShell 卡=`modal`、TabBarShell 与 SectionNav 双形态=`nav`、web 顶栏=`header`),`packages/ui/src/__tests__/skin-hooks.test.tsx` 拦挂点脱落。重构组件**不许丢属性**;换真实选择器改映射表,hook 名只增不改。

- **页级卡片容器一律玻璃底**:直接坐在页面背景上的卡片/容器,必须用玻璃件(`GlassPanel`/`GlassBox`/`GlassStatCard`)或裸 `.bn-glass` 类,**禁止**写实底(`bg-bn-surface`、`bg-white`)或「只有边框全透明」的容器——皮肤壁纸一开就穿帮。实底(`bg-bn-surface` 系)只许出现在玻璃容器**内部**的行/芯片上。自绘染色渐变要**叠**在玻璃底上(`background: <渐变>, var(--bn-glass-bg)`),别让渐变「渐到」玻璃底。
- **默认装玻璃卡无描边(卡片风)**:`.bn-glass`/`.bn-glass-strong` 的描边位默认透明(`var(--bn-glass-border, transparent)`),立体感靠阴影——玻璃件(`GlassPanel`/`GlassBox`/`GlassStatCard`)自带 `shadow-bn-card`,裸用 `.bn-glass` 类要自配 `shadow-bn-card`/`shadow-bn-elev`。别在默认装给玻璃卡手画边框;阴影写工具类不写进 `.bn-glass`(无层 CSS 会压死 utilities 层的阴影梯度,如 UpCard 的 hover 加深)。描边变量只由皮肤注入——皮肤 `glass.border`/`strongBorder` 是刻意描边风格(如霓虹边)的口子,这条路保留。
- 新组件先问一句:**它零业务依赖吗?** 不是就放 `apps/web`,别为了「进库」把 api/store 拖进来。
- 组件里的颜色类必须是已定义 token(`apps/web/src/__tests__/color-token-conformance.test.ts` 会拦未定义的);theme.css 里不许写无层 `position`(`css-layer-conformance.test.ts` 拦)。
- 加了组件**同步更新本清单** —— 清单失真,「先查清单」就废了。
