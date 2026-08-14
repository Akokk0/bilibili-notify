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

`@theme` 品牌调色板(`--color-bn-*` → `bg-bn-pink` 等 utilities)、明暗双套玻璃/页面变量(`--bn-glass-*` / `--bn-page-bg`,暗色走 `[data-theme="dark"]`)、`html/body` 基础皮肤、`.bn-glass` / `.bn-glass-strong` 玻璃面、`bn-pulse|spin|fade-in` 动效、`.bn-no-scrollbar`。品牌色的另一份正本在 `packages/image/src/styles.ts`(SSR 渲染器),改色要两边同步。

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

- 新组件先问一句:**它零业务依赖吗?** 不是就放 `apps/web`,别为了「进库」把 api/store 拖进来。
- 组件里的颜色类必须是已定义 token(`apps/web/src/__tests__/color-token-conformance.test.ts` 会拦未定义的);theme.css 里不许写无层 `position`(`css-layer-conformance.test.ts` 拦)。
- 加了组件**同步更新本清单** —— 清单失真,「先查清单」就废了。
