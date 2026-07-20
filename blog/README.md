# 博客内容

此目录可以直接作为 Obsidian 仓库打开。文章统一存放在 `articles/`，使用标准 Markdown（`.md`）。

## 新建文章

复制 `ARTICLE_TEMPLATE.md` 到 `articles/`，修改文件名、文章元数据和正文。`draft: true` 的文章不会发布。

## 媒体文件

由 Obsidian 上传插件将媒体文件上传到 Backblaze B2，并在文章中插入 `https://media.jojokanbao.cn` 的完整 URL。Git 仓库只保存 Markdown，不保存媒体文件。

```md
![图片说明](https://media.jojokanbao.cn/blog/2026/article-slug/image.jpg)

<audio controls src="https://media.jojokanbao.cn/blog/2026/article-slug/audio.mp3"></audio>

<video controls src="https://media.jojokanbao.cn/blog/2026/article-slug/video.mp4"></video>

[下载附件](https://media.jojokanbao.cn/blog/2026/article-slug/appendix.pdf)
```
