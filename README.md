# 二值掩膜工坊 Binary Mask StudioZZZZZZZZZ

浏览器端的二值掩膜编辑工具。保留绘图、文本、光栅、图层、选区、矩阵编辑、工程保存与 PNG/CSV/TXT 导出；评论功能及其后台已移除。

## 安装与构建

需要 Node.js 22.13 或以上，以及 pnpm。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

构建使用 Next.js 的 `output: 'export'`，可发布的静态文件位于 **`out/`**。网站运行时不需要 Node.js 服务器、Cloudflare Worker、数据库或附件存储。`.next/` 仅为构建中间产物，不能作为静态发布内容。

## 本地预览

```sh
pnpm preview
```

通过终端显示的 HTTP 地址访问。请通过静态 HTTP 服务预览，不要直接双击 HTML 文件。

## GitHub Pages 自动部署

网站地址：**https://sumu2he.github.io/binary-mask/**

`.github/workflows/pages.yml` 会在每次提交到 `main` 分支后，自动安装依赖、构建静态网站并发布到 GitHub Pages。也可以在仓库的 **Actions → Deploy GitHub Pages → Run workflow** 手动发布。构建和发布进度可在 [Actions](https://github.com/SuMu2he/binary-mask/actions/workflows/pages.yml) 查看。

在 GitHub 中修改 **`public/about.txt`** 或 **`public/help.txt`** 并提交到 `main` 后，网站会在部署成功后同步更新。发布需要一些时间；完成后刷新页面，再打开对应弹窗即可看到新内容。修改 `README.md` 会更新仓库自述文件。

仓库的 **Settings → Pages → Build and deployment → Source** 使用 **GitHub Actions**。工作流读取 Pages 的实际网址和路径，因此 GitHub Pages 的 `/binary-mask` 路径已自动配置。

### 手动构建

默认构建适用于网站根目录或自定义域名。如果之后部署到 `https://用户名.github.io/仓库名/`，构建前将 `NEXT_PUBLIC_BASE_PATH` 设置为 `/仓库名`。

同时将 `NEXT_PUBLIC_SITE_URL` 设置为最终站点的来源地址，例如 `https://用户名.github.io`。这个值用于生成社交预览图片的绝对链接；未设置时沿用原网站的图片来源地址。

```sh
NEXT_PUBLIC_BASE_PATH=/仓库名 NEXT_PUBLIC_SITE_URL=https://用户名.github.io pnpm build
```

PowerShell 中使用：

```powershell
$env:NEXT_PUBLIC_BASE_PATH = '/仓库名'
$env:NEXT_PUBLIC_SITE_URL = 'https://用户名.github.io'
pnpm build
Remove-Item Env:NEXT_PUBLIC_BASE_PATH
Remove-Item Env:NEXT_PUBLIC_SITE_URL
```

仅发布 `out/` 的全部内容，包括 `.nojekyll`、HTML、RSC 数据和静态资源。GitHub Actions 会自动完成这些操作，无需手动上传构建文件。

“帮助”和“应用信息”中的随机诗句仍会在浏览器中请求公开接口；接口不可用时自动使用内置诗句，掩膜编辑不依赖该接口。

## 修改帮助文案

帮助文案单独保存在 **`public/help.txt`**，可用记事本等文本编辑器修改，并保存为 UTF-8 编码。页面代码中的 `app/help-dialog.tsx` 负责读取和排版，不需要在这里修改文案。

TXT 中的 `#` 表示文档标题，`>` 表示副标题，`##` 表示章节标题。第一个章节为快速上手；每个操作步骤单独一行，以 `1.`、`2.` 等开头。后续章节用空行分隔段落。章节标题中的 `|` 后面是导航名称，快捷键行中的 `|` 两边分别是按键和说明。修改文字时保留这些标记。

构建时该文件会原样复制到 **`out/help.txt`**，两个文件包均包含它。网站每次打开帮助时读取这个静态 TXT 文件，无需后台服务。只修改帮助文案时，可以单独替换已发布网站根目录中的 `help.txt`，也可以修改源码中的 `public/help.txt` 后重新构建、发布。若托管服务缓存了文件，发布后需要刷新或清除对应缓存。

## 修改应用信息

APPLICATION INFORMATION 弹窗中的标题、应用名称、版本、更新时间、作者和技术来源等文案保存在 **`public/about.txt`**。可用记事本修改并保存为 UTF-8 编码，保留 `#`、`>`、`##` 和 `|` 标记。每项信息单独一行，`|` 左边为项目名称，右边为显示内容，例如 `Version | Ver.1.0`；可以修改、添加或删除项目。`#` 后是弹窗标题，`>` 后是副标题，`##` 后是标志下面的应用名称。

构建时会原样生成 **`out/about.txt`**。网站每次打开应用信息时读取它；只修改这些文案时，可以单独替换发布目录中的 `about.txt`，无需重新构建。随机诗句继续沿用网站原有逻辑。两个文件包均包含 `help.txt` 和 `about.txt` 对应文件。
