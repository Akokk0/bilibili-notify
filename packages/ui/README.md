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
| `Btn` | 按钮,5 变体(`primary` 粉实底 / `blue` / `ghost` / `outline` / `danger` 红字)× 3 尺寸 |
| `Pill` | 圆角小徽章(**不可点**的 `<span>`);`subtle` = 12% 底色染色字,否则实底白字 |
| `IconButton` | 只装一枚图标的方钮/圆钮(关闭 / 移除 / 箭头)。五档 `size`(xs 16 → xl 36)、四档 `tone`(**只管 hover 语义**,静态字色一律 tertiary)、`shape=pill`、`filled` 加描边面底。`label` 必填(图标没文字),tooltip 要另写才给 `title`。`className` **只收定位这类不冲突的**工具类(`absolute`/`opacity-0 group-hover:*`),覆盖本体是覆盖不住的 —— 要改本体就加档 |
| `AddButton` / `AddCard` | 「这里还能再加一个」的虚线语汇(虚线=空位,指上去变粉=点我)。`AddButton` 行内走药丸、`block` 占整行走卡片圆角;`AddCard` 是网格里的一格,＋/标题/副标题**由组件出**,调用方只给文字。两者共用一份 `ADD_LANGUAGE`,底色/最小高度/焦点环走 `className` |
| `MenuItem` | 弹层(下拉 / 右键菜单 / 附件菜单)里的一整行:图标槽 + 内容,`active` 染粉加粗、`danger` 整行连图标转红。行内有副标题时**必须给 `ariaLabel`**,否则读屏器把标题和小字连起来念。**刻意不挂 `data-bn`** —— 皮肤给按钮写的实底落到每行菜单上很难看,而词表里没有 `menu-item` 这一档;浮层本体自己挂了 `glass-strong` |
| `ToneChip` | 「一排里选一个/开一个」的**可点**胶囊:选中 = 12% `tone` 底 + **实色 `tone` 边** + 正文色字,未选中退中性描边 + 悬停变正文色。**`tone` 不承担可读性**(当字色时字底同色相,亮色下 warn 只有 1.90:1),色彩识别交给实色边框。自带 `data-bn="btn"`;`tone` 收 hex **或** `var()`(内部 `color-mix`),纯操作钮可不填。别拿 `Pill` 套 `onClick` 顶替它 |
| `Toast` | 一句话瞬时提示(「已复制」「已保存失败」)。自己**不计时**,挂上撤下由调用方管。三条取值不许改:① 字色恒 `text-bn-text-primary`,**不写死白字** —— 底能被皮肤重绘、写死的字色不能,两者一起就是白底白字;② 语义走**描边**不走实心底(同 `ToneChip` 的道理);③ 钉**底部居中**,右下角是推送 toast 那一摞的地盘。自带 `data-bn="glass-strong"`。通知中心那种带图标/时间的富卡片不归它管 |
| `StatusDot` | 8px 语义色状态点(`live/living` 粉+呼吸、`ok` 绿、`warn` 橙、`err` 红、`pending` 灰) |
| `Toggle` | 开关(粉=开),`sm`/`md`;`ariaLabel` 给读屏器命名 |
| `Input` | 带可选前置 icon 的单行输入框 |
| `CheckRow` | 多选列表的选项行:粉勾选方块 + 文本,checkbox 本体 sr-only |
| `ErrorNote` | 「XX 失败:…」红字提示盒的唯一写法;外边距走 `className` |
| `WarnNote` | 「做完了但有几处没照办」黄字提示盒的唯一写法;**行高与外边距走 `className`** |
| `EmptyNote` | 「这里还什么都没有」中性虚线框的唯一写法;`md`(默认)给整块面板的空态、`sm` 给表单小节里内嵌的一行。**只此两档** —— 收编前站内九份手写在四种圆角三种字号之间漂 |
| `Spinner` | 品牌色圆环加载指示(淡粉底环 + 粉顶弧) |
| `PlatformIcon` / `platformLabel` | 推送平台图标与显示名(onebot / qq-official / webhook) |
| `StatsBar` | 迷你堆叠柱状图(live/dyn/sc/guard 四色) |
| `Section` / `Row` | 抽屉与面板里的「小节标题 + 行列表」骨架 |

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

## 维护约定

- **别把皮肤挡在门外**(同一个模式已复发三回:tab 条那排、Subs/History 的筛选胶囊、Toggle):
  - **圆角走轴**。可点控件用 `rounded-bn-pill`(或 `rounded-bn-card`),**不写死 `rounded-full`** —— 写死的话皮肤把 `radius.pill` 调到 0 求一身硬直角也掰不直它。真正必须是**正圆**的(头像、状态点、光斑)照写 `rounded-full`,那是设计要求不是疏忽。
  - **颜色走 token**,`#d8d8d8` 这种字面值皮肤搬不动。
  - **圆角一律不许落在 `style={{…}}`**;颜色只有**逐项动态**的那一种可以(每个选项各异的语义色,如 `ToneChip` 的 `tone`、`GlassPanel` 的 `accent`、`Pill` 的 `color`)。**静态的、可换肤的颜色必须走 class** —— inline 压过一切 author 样式,皮肤连覆盖的机会都没有,而且 inline **没有 `:hover`**(`ToneChip` 初版把未选中态三色写进 inline,四颗胶囊当场集体丢了悬停反馈)。写死的动态值放 CSS 变量,`style` 里只留真正的运行时几何量(宽高、位移)。
  - **页面里手写的 `<button>` 记得挂 `data-bn`**。`skin-hooks.test.tsx` 只管库里那几个组件;两边全部手写按钮的覆盖由 `apps/web/src/__tests__/skin-hook-coverage.test.ts` 兜底 —— 它扫 `apps/web/src` 与 `packages/ui/src` 全 .tsx,不挂点就得进那份**写明理由**的豁免名单(下拉菜单行、列表行、透明覆盖层、纯文字链接、以及挂上会毁掉语义的开关类,才是合理的不挂)。
  - **手写的输入框同理**,由 `apps/web/src/__tests__/input-hook-coverage.test.ts` 兜底:除挂点外它还钉住**底色 token** —— 输入面走 `bg-bn-field`,不走 `bg-bn-surface`。这条只能静态扫:亮色下两个 token 都是 `#ffffff`,肉眼与截图都验不出来,暗色下才分开(`theme.css` 的 elevation 阶梯是 muted < **field(输入)** < surface(卡片) < strong(弹窗)),而且 `field` 在皮肤契约里是独立一键,写错 token 等于那一键够不着它。能直接用 `apps/web` 的 T 系列(`TInput` / `TArea` / `TNum` / `TSelect`)就别手写,它们四件都自带挂点与正确底色。
  - **Toggle 例外:不许挂 `btn`**。皮肤给按钮写的实底会盖掉轨道背景,开关的开/关当场看不出来。
- **文字挑档按名字语义,别按当下看到的深浅**:`text-primary`(标题/人名)> `text-secondary`(正文、说明、区块标签)> `text-tertiary`(UID、时间戳、协议行、图标字形)> `text-disabled`(禁用/轨道底),四档在亮暗两套里**同向**。亮色默认装曾从设计稿原样抄来一份**反的**(secondary #999 比 tertiary #666 还淡),于是同一个 className 在亮色下是最淡一档、在暗色和每一套皮肤里都是较重一档,`hover:text-bn-text-secondary` 这种「悬停变亮」的写法当场变淡。`apps/web/src/__tests__/theme-conformance.test.ts` 现在按对比度拦单调性、档距(≥1.25×)与 AA 底线。
- **`data-bn` 皮肤挂点是公开 API**:皮肤自定义 CSS 只能瞄准 `SKIN_CSS_HOOK_MAP`(contract skin.ts)里的挂点。映射到 `[data-bn~=…]` 的 hook 由组件真实背着属性(Btn=`btn`/`btn-primary`、Input 外框=`input`、Avatar 根=`avatar`、ModalShell 卡=`modal`、TabBarShell 与 SectionNav 双形态=`nav`、web 顶栏=`header`),`packages/ui/src/__tests__/skin-hooks.test.tsx` 拦挂点脱落。重构组件**不许丢属性**;换真实选择器改映射表,hook 名只增不改。

- **页级卡片容器一律玻璃底**:直接坐在页面背景上的卡片/容器,必须用玻璃件(`GlassPanel`/`GlassBox`/`GlassStatCard`)或裸 `.bn-glass` 类,**禁止**写实底(`bg-bn-surface`、`bg-white`)或「只有边框全透明」的容器——皮肤壁纸一开就穿帮。实底(`bg-bn-surface` 系)只许出现在玻璃容器**内部**的行/芯片上。自绘染色渐变要**叠**在玻璃底上(`background: <渐变>, var(--bn-glass-bg)`),别让渐变「渐到」玻璃底。
- **默认装玻璃卡无描边(卡片风)**:`.bn-glass`/`.bn-glass-strong` 的描边位默认透明(`var(--bn-glass-border, transparent)`),立体感靠阴影——玻璃件(`GlassPanel`/`GlassBox`/`GlassStatCard`)自带 `shadow-bn-card`,裸用 `.bn-glass` 类要自配 `shadow-bn-card`/`shadow-bn-elev`。别在默认装给玻璃卡手画边框;阴影写工具类不写进 `.bn-glass`(无层 CSS 会压死 utilities 层的阴影梯度,如 UpCard 的 hover 加深)。描边变量只由皮肤注入——皮肤 `glass.border`/`strongBorder` 是刻意描边风格(如霓虹边)的口子,这条路保留。
- 新组件先问一句:**它零业务依赖吗?** 不是就放 `apps/web`,别为了「进库」把 api/store 拖进来。
- 组件里的颜色类必须是已定义 token(`apps/web/src/__tests__/color-token-conformance.test.ts` 会拦未定义的);theme.css 里不许写无层 `position`(`css-layer-conformance.test.ts` 拦)。
- 加了组件**同步更新本清单** —— 清单失真,「先查清单」就废了。
