# @jojo/editorial-preset

红色杂志设计系统 — Tailwind CSS v4 theme。

## 使用

```css
/* 在 app 的入口 CSS 中 */
@import "@jojo/editorial-preset";
```

## 提供的 Token

| Token | 值 | 用途 |
|-------|---|------|
| `--color-red` | `#8b1a1a` | 主色 |
| `--color-red-dark` | `#651212` | 主色深 |
| `--color-ink` | `#202020` | 正文色 |
| `--color-muted` | `#666` | 辅助文字 |
| `--color-paper` | `#fff` | 背景 |
| `--color-paper-soft` | `#fffaf2` | 暖背景 |
| `--color-cream` | `#f5efe6` | 按钮文字 |
| `--font-serif` | Noto Serif SC... | 衬线字体 |

## 组件类

- `.btn` / `.btn-outline` — 按钮
- `.tag` — 标签
- `.kicker` — 栏目标题装饰

## 非 Tailwind 项目

使用 `base.css`（纯 CSS 变量，不依赖 Tailwind）：

```css
@import "@jojo/editorial-preset/base";
```
