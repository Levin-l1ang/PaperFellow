# PaperFellow

PaperFellow 是一个本地论文精读工作台。导入 PDF 后，可以逐段对照英文原文和中文伴读，提问、做理解题，并自动保存阅读进度与笔记。

## Windows 启动

1. 在项目文件夹双击 `Start-PaperFellow.cmd`。
2. 启动器会打开默认浏览器。也可以直接访问 [http://127.0.0.1:4317](http://127.0.0.1:4317)。

启动器可使用 PATH 上的 Node 和 Codex，也可查找 Windows Codex 桌面版自带的运行时。服务已在运行时，再次双击会打开同一个页面，启动提示窗口会等待按键。若本次双击启动了新服务，请保持该窗口打开，按 `Ctrl+C` 可停止服务。

### 首次安装或迁移

在新电脑上准备 Node.js 24 或更新版本、Python 3.11 或更新版本，并登录 Codex。把项目放到本机后，在项目目录执行一次依赖安装。

```powershell
# 已有 pnpm 时，按锁文件安装 JavaScript 依赖
pnpm install --frozen-lockfile

# 使用 npm 时，替换上面一行即可
# npm.cmd install

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

已有 `.venv` 时，直接运行最后一行更新 Python 依赖。Node.js 的 npm 随 Node 安装，Python 依赖通过 pip 安装。

安装后双击 `Start-PaperFellow.cmd`。在 Node.js 已加入 PATH 的终端，运行 `node scripts/start.mjs` 也能启动。macOS 或 Linux 可用 `python3 -m venv .venv` 和 `.venv/bin/python -m pip install -r requirements.txt` 安装 Python 依赖，再运行同一个 Node 启动命令。首次启动或前端文件更新后，应用会自动构建页面。

## 导入与阅读

- **后台伴读**。点击「导入 PDF」或拖入文件。索引完成后，新论文会出现在论文库，正文伴读立即加入后台队列。可在论文库查看进度、暂停或继续，也可在设置改为「仅摘要」或关闭。重复导入会沿用已有记录。单文件上限为 80 MB、400 页。
- **关闭与续读**。关闭浏览器标签页后，本机服务仍会处理后台队列。停止服务后，未完成任务会标记为中断。重启后可从已有内容继续生成，或点击「继续阅读」恢复位置。
- **阅读布局**。用左侧目录跳转，拖动中间分隔线调整栏宽，或切换同步和独立滚动。右上角的面板按钮可收起 AI 伴读栏，原文会切换为宽版。应用会记住右栏状态。
- **理解检测**。在阅读页点「理解检测」，为当前章节生成一组三道单选题。提交后显示解析和原文段落链接，下次打开会恢复已保存的题目与作答记录。
- **讨论与研究笔记**。选中原文即可引用提问、加高亮或写批注。研究笔记可按来源和分类查看，支持生成全文评价和导出 Markdown。当前论文的对话和出题优先于该论文的后台伴读。
- **原始 PDF**。点 `PDF p.` 可查看对应页面。复杂版式、公式、图表和扫描件可回到原始 PDF 校对，也可按页请求视觉分析。伴读支持 Markdown、LaTeX、表格、Mermaid 和经校验的交互图表。

## 模型与配置

默认采用官方 Codex app-server 和本机 ChatGPT 登录。可在设置查看连接状态、选择模型和修改阅读提示词。首次使用独立 Codex CLI 时，可运行 `codex login`。生成伴读、视觉分析、理解题或回答问题时，相关原文、图像或讨论上下文会发给所选模型。已保存的论文和伴读可离线阅读。

OpenAI API 是独立计费选项。启用时，在设置选择对应 Provider、填写模型 ID，并通过环境变量或 `.env` 提供 `OPENAI_API_KEY`。

将 [`.env.example`](.env.example) 复制为 `.env` 后可修改默认配置。系统环境变量优先。

| 变量 | 用途 |
| --- | --- |
| `PC_PORT` | 默认 `4317`，服务只监听 `127.0.0.1` |
| `PC_DATA_DIR` | 默认项目中的 `data/`，也可指定项目外的本地目录 |
| `PC_PYTHON` | 默认优先使用项目 `.venv`，也可指定已安装 PyMuPDF 的 Python |
| `PC_CODEX` | 指定官方 Codex 可执行文件。双击 Windows 启动脚本时，可提前设置同名环境变量覆盖自动查找 |
| `OPENAI_API_KEY` | 选择 OpenAI API Provider 后使用 |

[Codex app-server 官方文档](https://learn.chatgpt.com/docs/app-server) · [Codex 认证](https://learn.chatgpt.com/docs/auth)

## 数据、备份与恢复

`data/` 保存原始 PDF、页面裁图和 `papers.sqlite`。数据库记录章节索引、伴读缓存、阅读进度、对话、批注、笔记、题目和作答结果。需要续读时会尝试恢复对应的 Codex 线程，迁移后也可用保存的论文证据和讨论历史建立新线程。

停止服务后，在项目目录执行备份或恢复。请为新备份使用尚不存在的文件名。恢复成功后，程序会显示恢复前数据的保留位置。

```powershell
node scripts/backup.mjs backup paperfellow-backup.zip
node scripts/backup.mjs restore paperfellow-backup.zip
```

如果普通 PowerShell 找不到 `node`，可以先用下面的命令定位 Codex 桌面版自带的 Node，再用 `& $node` 代替上面命令开头的 `node`。

```powershell
$runtime = Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' | Select-Object -First 1
$node = Join-Path $runtime.InstallLocation 'dependencies\node\bin\node.exe'
# 例如：& $node scripts/backup.mjs backup paperfellow-backup.zip
```

备份包含论文和阅读资料。迁移时需要在新电脑重新配置登录、模型凭据及 `.env`。Git 会忽略默认论文库、恢复前的资料目录、本地配置、依赖和构建产物。

## 开发与测试

`src/` 是前端，`shared/` 定义客户端与服务端共用的数据结构，`server/` 提供本机 API、后台队列和 SQLite 存储，`scripts/` 包含启动、PDF 解析和备份入口。

```sh
npm run check
npm test
npm run build
```

端到端测试会在隔离目录使用当前 Codex 额度，验证真实的导入、流式生成、问答和恢复。第一篇测试用 Transformer 论文，第二篇用双栏 BERT 论文。

```sh
npm run test:live -- /path/to/attention.pdf /path/to/bert.pdf
```

[Attention Is All You Need](https://arxiv.org/abs/1706.03762) · [BERT](https://arxiv.org/abs/1810.04805)
