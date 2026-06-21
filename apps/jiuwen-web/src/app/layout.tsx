import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JOJO旧闻",
  description: "AI 辅助阅读新闻，自动生成旧闻对照和追问线索",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
