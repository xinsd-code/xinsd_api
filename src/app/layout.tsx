import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "API Forge - API 接口管理平台",
  description: "可配置的 API接口管理平台，支持 RESTful、流式响应、自定义请求头和参数",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="app-layout">
          <header className="app-header">
            <div className="app-header-left">
              <div className="app-logo">M</div>
              <div>
                <div className="app-title">API Forge</div>
                <div className="app-subtitle">API 开发辅助平台</div>
              </div>
            </div>
          </header>
          <div className="app-body">
            <Sidebar />
            <main className="app-main">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
