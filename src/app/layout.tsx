import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "API Forge - Refined API Management",
  description: "A professional studio-grade platform for API mocking, orchestration, and testing.",
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <div className="app-logo">F</div>
              <div>
                <div className="app-title">Forge</div>
                <div className="app-subtitle">API STUDIO</div>
              </div>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ 
                height: '32px', 
                padding: '0 12px', 
                background: 'var(--color-bg-subtle)', 
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-full)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                fontWeight: 600
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent)' }}></span>
                PROD-ENV
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
