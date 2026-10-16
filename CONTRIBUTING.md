# 参与贡献

感谢你愿意改进 Lumina。这份文档说明如何把项目跑起来、改完之后怎么自测。

## 技术栈

- **纯前端**：原生 JavaScript（IIFE + 全局 `HSP` 命名空间），**没有构建步骤**——改完直接刷新即可生效
- **桌面外壳**：Electron 31 + electron-builder（NSIS 安装包）
- **PWA**：`manifest.webmanifest` + `sw.js`，同一套代码跑浏览器/手机
- **测试**：`tools/full-test.js`，在 Electron 里逐项断言（当前 **174/174**）

## 环境要求

- Node.js ≥ 18（推荐 20+）
- pnpm（或 npm）
- Windows 打包需要联网下载 electron-builder 的二进制

## 运行

```bash
pnpm install      # 或 npm install
pnpm start        # 启动桌面版
```

浏览器里调试（无需 Electron）：

```bash
python -m http.server 8000
# 打开 http://localhost:8000
```

## 测试

```bash
# 在 Electron 里跑全部断言，结果写入 tools/full-result.txt
npx electron tools/full-test.js
```

> **Windows 提示**：如果你的环境设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node，程序会"静默秒退"。
> 运行前先清除：`Remove-Item Env:ELECTRON_RUN_AS_NODE`（或 `set ELECTRON_RUN_AS_NODE=`）。

**改代码请一并跑测试**：项目里每个功能都有对应断言，新增能力时请补一条（见 `tools/full-test.js` 的 `check(...)` 写法）。

## 打包

```bash
pnpm run dist     # 产物在 release/
```

打包前建议先关掉正在运行的 `Lumina.exe`，否则 electron-builder 的 rcedit 可能失败、导致安装包没有更新。

## 代码结构

| 目录/文件 | 说明 |
|---|---|
| `index.html` | 主界面（工具栏、欢迎页、编辑侧栏、属性面板、演讲者控制台、设置） |
| `css/app.css` | 全部样式 |
| `js/sync.js` | 跨窗口同步（Electron IPC 中继 / BroadcastChannel） |
| `js/player.js` | 播放核心：分页识别、翻页、滚动同步、全屏 |
| `js/annotate.js` | 画笔 / 荧光笔 / 激光笔 / 橡皮 |
| `js/editor.js` | 元素级编辑（选中、拖动、缩放手柄、参考线、分类型属性面板） |
| `js/presenter.js` | 演讲者模式（控制台 + 投影窗口） |
| `js/ai.js` | AI 调用（提示词、三种模式、截断续写） |
| `js/main.js` | 应用主控（打开/保存、AI 面板、设置、首启引导） |
| `electron/` | 桌面封装（主进程 / preload） |
| `sample/` | 内置示例（物理 / 数学 / 商务 / 使用指引） |
| `tools/` | 开发工具与自动化测试 |

## 关于示例幻灯片

`sample/*.html` 每一份都是**自包含单文件**（内联 CSS/JS，无外部依赖），既是演示也是"HTML 能做到什么"的样例。
如果你要新增示例，请保持同样的约定：`<section class="slide" data-title data-notes>`、脚本失败时内容仍可见、尊重 `prefers-reduced-motion`。

## 提交

- 一次提交聚焦一件事，说明里写清「改了什么 / 为什么」
- 涉及 UI 的改动请附截图
- 不要提交 `node_modules/`、`release/`（已在 `.gitignore` 中）

## 许可

贡献的代码将以 [MIT License](LICENSE) 发布。
