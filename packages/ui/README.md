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
| `Pill` | 圆角小徽章;`subtle` = 15% 底色染色字,否则实底白字 |
| `StatusDot` | 8px 语义色状态点(`live/living` 粉+呼吸、`ok` 绿、`warn` 橙、`err` 红、`pending` 灰) |
| `Toggle` | 开关(粉=开),`sm`/`md`;`ariaLabel` 给读屏器命名 |
| `Input` | 带可选前置 icon 的单行输入框 |
| `CheckRow` | 多选列表的选项行:粉勾选方块 + 文本,checkbox 本体 sr-only |
| `ErrorNote` | 「XX 失败:…」红字提示盒的唯一写法;外边距走 `className` |
| `Spinner` | 品牌色圆环加载指示(淡粉底环 + 粉顶弧) |
| `PlatformIcon` / `platformLabel` | 推送平台图标与显示名(onebot / qq-official / webhook) |
| `StatsBar` | 迷你堆叠柱状图(live/dyn/sc/guard 四色) |
| `Section` / `Row` | 抽屉与面板里的「小节标题 + 行列表」骨架 |

### 玻璃卡

| 组件 | 干什么 / 长什么样 |
| --- | --- |
| `GlassPanel` | 轻玻璃面板:标题/副标题/右槽/accent 渐变角光 + icon 方块。`accent` 必须是**十六进制字面量**(要拼 alpha 后缀,传 `var()` 会整条失效) |
| `GlassStatCard` | 数字大卡:label + 等宽大数字 + 可选呼吸点/footer;`color` 同样必须十六进制 |
| `GlassBox` | 重玻璃分区卡(Rules/Cards/AI 页那种):icon 芯片 + badge + 右侧动作槽 + 分隔线 |
| `CollapseBlock` | GlassBox 内的「开关折叠块」:关=灰、开=accent 染色并展开 children |

### 弹窗

| 组件 | 干什么 / 长什么样 |
| --- | --- |
| `ModalShell` | 弹窗骨架:portal 到 body、遮罩 + 居中卡、ESC/点遮罩关闭;body padding 可覆盖 |
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

- **`data-bn` 皮肤挂点是公开 API**:皮肤自定义 CSS 只能瞄准 `SKIN_CSS_HOOK_MAP`(contract skin.ts)里的挂点。映射到 `[data-bn~=…]` 的 hook 由组件真实背着属性(Btn=`btn`/`btn-primary`、Input 外框=`input`、Avatar 根=`avatar`、ModalShell 卡=`modal`、TabBarShell 与 SectionNav 双形态=`nav`、web 顶栏=`header`),`packages/ui/src/__tests__/skin-hooks.test.tsx` 拦挂点脱落。重构组件**不许丢属性**;换真实选择器改映射表,hook 名只增不改。

- **页级卡片容器一律玻璃底**:直接坐在页面背景上的卡片/容器,必须用玻璃件(`GlassPanel`/`GlassBox`/`GlassStatCard`)或裸 `.bn-glass` 类,**禁止**写实底(`bg-bn-surface`、`bg-white`)或「只有边框全透明」的容器——皮肤壁纸一开就穿帮。实底(`bg-bn-surface` 系)只许出现在玻璃容器**内部**的行/芯片上。自绘染色渐变要**叠**在玻璃底上(`background: <渐变>, var(--bn-glass-bg)`),别让渐变「渐到」玻璃底。
- **默认装玻璃卡无描边(卡片风)**:`.bn-glass`/`.bn-glass-strong` 的描边位默认透明(`var(--bn-glass-border, transparent)`),立体感靠阴影——玻璃件(`GlassPanel`/`GlassBox`/`GlassStatCard`)自带 `shadow-bn-card`,裸用 `.bn-glass` 类要自配 `shadow-bn-card`/`shadow-bn-elev`。别在默认装给玻璃卡手画边框;阴影写工具类不写进 `.bn-glass`(无层 CSS 会压死 utilities 层的阴影梯度,如 UpCard 的 hover 加深)。描边变量只由皮肤注入——皮肤 `glass.border`/`strongBorder` 是刻意描边风格(如霓虹边)的口子,这条路保留。
- 新组件先问一句:**它零业务依赖吗?** 不是就放 `apps/web`,别为了「进库」把 api/store 拖进来。
- 组件里的颜色类必须是已定义 token(`apps/web/src/__tests__/color-token-conformance.test.ts` 会拦未定义的);theme.css 里不许写无层 `position`(`css-layer-conformance.test.ts` 拦)。
- 加了组件**同步更新本清单** —— 清单失真,「先查清单」就废了。
