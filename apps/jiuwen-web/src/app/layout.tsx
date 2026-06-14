import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JOJO旧闻",
  description: "看完新闻，自动生成合订本",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
