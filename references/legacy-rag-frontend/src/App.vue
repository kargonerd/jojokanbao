<template>
  <router-view />
</template>

<style>
:root {
  --primary-color: #9d161c;
  --primary-light: #b01b21;
  --primary-dark: #7f1015;
  --primary-soft: rgba(157, 22, 28, 0.06);
  --accent-red: #b01b21;
  --bg-color: #f8f1e7;
  --bg-card: #fbf6ee;
  --bg-card-strong: #fcf7ef;
  --bg-body: #f4ece1;
  --bg-muted: rgba(248, 241, 231, 0.8);
  --border-color: rgba(157, 22, 28, 0.28);
  --border-strong: rgba(157, 22, 28, 0.68);
  --text-primary: #251d1b;
  --text-secondary: #5e4b46;
  --text-tertiary: #8f786f;
  --success-color: #15803d;
  --danger-color: #b42318;
  --paper-shadow: 8px 8px 0 rgba(125, 16, 21, 0.08);
  --content-width: 1080px;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  background:
    radial-gradient(circle at center top, rgba(157, 22, 28, 0.05), transparent 18%),
    linear-gradient(180deg, #faf4ea 0%, #f8f0e5 100%);
  scrollbar-color: rgba(124, 92, 82, 0.55) rgba(248, 240, 229, 0.96);
}

body {
  margin: 0;
  font-family: 'Noto Serif SC', 'Songti SC', 'STSong', 'SimSun', 'Source Han Serif SC', serif;
  background: transparent;
  color: var(--text-primary);
  line-height: 1.7;
  min-height: 100vh;
  overflow-x: hidden;
}

html::-webkit-scrollbar {
  width: 10px;
}

html::-webkit-scrollbar-track {
  background: rgba(248, 240, 229, 0.96);
}

html::-webkit-scrollbar-thumb {
  background: rgba(124, 92, 82, 0.45);
  border-radius: 0;
  border: 2px solid transparent;
  background-clip: padding-box;
}

html::-webkit-scrollbar-thumb:hover {
  background: rgba(124, 92, 82, 0.6);
  background-clip: padding-box;
}

body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    180deg,
    transparent 0,
    transparent 118px,
    rgba(157, 22, 28, 0.08) 119px,
    transparent 120px
  );
  opacity: 0.18;
}

button,
input,
textarea,
select {
  font: inherit;
}

button {
  color: inherit;
}

button,
a {
  transition: color 0.18s ease, border-color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
}

a {
  color: inherit;
}

img {
  display: block;
}

::selection {
  background: rgba(143, 17, 24, 0.16);
}

#app {
  position: relative;
  z-index: 1;
}

.brand-mark {
  font-family: 'Noto Serif SC', 'Songti SC', 'STSong', 'SimSun', 'Source Han Serif SC', serif;
  font-size: 1em;
  letter-spacing: 0.01em;
  color: var(--primary-color);
}

.brand-sub {
  margin-left: 0;
  font-family: 'Noto Serif SC', 'Songti SC', 'STSong', 'SimSun', serif;
  font-size: 0.5em;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
}

.ui-card,
.ui-state-card {
  background: rgba(255, 252, 245, 0.78);
  border: 1px solid var(--border-color);
  box-shadow: none;
}

.ui-card {
  padding: 20px;
}

.ui-state-card {
  padding: 24px;
  color: var(--text-secondary);
}

.ui-state-card.error {
  color: var(--danger-color);
  border-color: rgba(180, 35, 24, 0.42);
  background: rgba(220, 38, 38, 0.06);
}

.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--primary-color);
  background: transparent;
  color: var(--primary-color);
  padding: 9px 15px;
  min-height: 40px;
  cursor: pointer;
  text-decoration: none;
}

.ui-btn:hover:not(:disabled) {
  background: rgba(157, 22, 28, 0.06);
}

.ui-btn:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.ui-btn-primary {
  background: var(--primary-color);
  color: #fbf6ee;
}

.ui-btn-primary:hover:not(:disabled) {
  background: var(--primary-dark);
  border-color: var(--primary-dark);
  box-shadow: var(--paper-shadow);
}

.ui-btn-secondary {
  background: rgba(255, 251, 245, 0.72);
}

.ui-btn-danger {
  border-color: var(--danger-color);
  color: var(--danger-color);
}

.ui-btn-danger:hover:not(:disabled) {
  background: rgba(180, 35, 24, 0.08);
}

.ui-btn-small {
  min-height: 32px;
  padding: 6px 10px;
  font-size: 13px;
}

.ui-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid rgba(157, 22, 28, 0.16);
  background: rgba(157, 22, 28, 0.05);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
}

.ui-badge.ok {
  border-color: rgba(21, 128, 61, 0.2);
  background: rgba(22, 163, 74, 0.08);
  color: var(--success-color);
}

.ui-form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ui-form-group input,
.ui-form-group textarea,
.ui-form-group select,
.ui-input {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  outline: none;
  background: rgba(255, 251, 245, 0.92);
  color: var(--text-primary);
}

.ui-form-group input:focus,
.ui-form-group textarea:focus,
.ui-form-group select:focus,
.ui-input:focus {
  border-color: var(--border-strong);
}

.ui-toast {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 30;
  padding: 12px 16px;
  color: #fff;
  background: rgba(26, 26, 26, 0.92);
}

.ui-toast.error {
  background: var(--danger-color);
}

.markdown-body {
  font-size: 15px;
  line-height: 1.9;
  color: var(--text-primary);
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  margin-top: 28px;
  margin-bottom: 14px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0.02em;
}

.markdown-body h1 { font-size: 2.1em; }
.markdown-body h2 { font-size: 1.62em; }
.markdown-body h3 { font-size: 1.28em; }

.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body table,
.markdown-body pre,
.markdown-body blockquote {
  margin-bottom: 18px;
}

.markdown-body ul,
.markdown-body ol {
  padding-left: 1.8em;
}

.markdown-body li {
  margin-bottom: 6px;
}

.markdown-body code {
  background: rgba(143, 17, 24, 0.08);
  padding: 0.18em 0.45em;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 85%;
}

.markdown-body pre {
  background: rgba(88, 56, 40, 0.06);
  padding: 18px;
  overflow-x: auto;
  border: 1px solid var(--border-strong);
}

.markdown-body pre code {
  background: none;
  padding: 0;
}

.markdown-body blockquote {
  border-left: 3px solid var(--primary-color);
  padding: 4px 0 4px 16px;
  color: var(--text-secondary);
}

.markdown-body img {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border-color);
}

.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  overflow: hidden;
}

.markdown-body th,
.markdown-body td {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
}

.markdown-body th {
  background: rgba(143, 17, 24, 0.06);
  font-weight: 700;
}
</style>
