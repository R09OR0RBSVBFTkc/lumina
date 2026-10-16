# 发布到 GitHub

这份目录已按开源仓库规范整理好：`README.md`（含功能表与截图）、`LICENSE`（MIT）、`CONTRIBUTING.md`、`.gitignore`、`docs/screenshots/`。

下面三种方式任选其一。

---

## 方式 A：网页上传（最简单，不用装 git）

1. 打开 <https://github.com/new>
   - **Repository name**：`lumina`（或你喜欢的名字）
   - **Description**：`AI HTML 幻灯片播放器：播放 / 元素级编辑 / 演讲者模式 / 手写标注，Windows 桌面版 + PWA`
   - 选 **Public**；**不要**勾选 Add a README（我们已经有 README）
   - 点 **Create repository**
2. 解压 `Lumina-1.0.0-source.zip`，得到 `lumina/` 目录
3. 在刚建好的空仓库页面点 **uploading an existing file**
4. 打开 `lumina/` 目录，**全选里面的内容**（不是 `lumina` 文件夹本身）拖进上传区
   - ⚠️ `.gitignore` 是隐藏文件，Windows 资源管理器需先勾选「查看 → 显示 → 隐藏的项目」，否则会漏掉它
5. 填提交信息 → **Commit changes**

---

## 方式 B：GitHub Desktop（适合长期维护）

1. 安装 <https://desktop.github.com/>
2. **File → Add local repository** → 选择解压后的 `lumina` 目录
   （若提示不是仓库，选择 *create a repository*）
3. 左侧确认变更列表里**没有** `node_modules/`、`release/`、`dist-src/`（`.gitignore` 已自动排除）
4. 点 **Publish repository** → 取消勾选 *Keep this code private* → **Publish**

---

## 方式 C：命令行

```bash
cd lumina
git init
git add .
git commit -m "feat: Lumina 1.0.0 —— AI HTML 幻灯片播放器"
git branch -M main
git remote add origin https://github.com/<你的用户名>/lumina.git
git push -u origin main
```

> 推送需要凭据，GitHub 现在**不接受账号密码**：
> - **HTTPS**：用 Personal Access Token（Settings → Developer settings → Personal access tokens → Tokens (classic) → 勾选 `repo`），在提示密码时粘贴 token
> - **SSH**：先 `ssh-keygen` 并把公钥加到 GitHub → Settings → SSH keys

---

## 建议的仓库设置

| 项目 | 建议 |
|---|---|
| **About → Topics** | `electron` `html` `presentation` `slides` `ai` `pwa` `canvas` `revealjs` |
| **Releases** | 把打包好的 `Lumina Setup 1.0.0.exe` 作为 `v1.0.0` 的资源上传（安装包 75 MB，**不要**直接提交进仓库） |
| **不要提交** | `node_modules/`、`release/`、`dist-src/`（`.gitignore` 已排除） |

---

## 开源前检查（已完成）

- [x] 无硬编码 API Key —— Key 只保存在用户本机 `localStorage`
- [x] 无真实业务数据 —— 示例里的数字均为虚构
- [x] 许可证为 MIT（`LICENSE` 与 `package.json` 的 `license` 字段一致）
- [x] 不含 `node_modules/`、构建产物
- [x] 测试可复现：`npx electron tools/full-test.js` → 174/174
