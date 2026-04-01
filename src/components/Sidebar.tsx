'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icons } from './Icons';

export default function Sidebar() {
  const pathname = usePathname();

  const navItems = [
    {
      name: 'Mock 接口',
      path: '/',
      icon: <Icons.Server size={18} />,
    },
    {
      name: 'API 接入',
      path: '/api-client',
      icon: <Icons.Zap size={18} />,
    },
    {
      name: 'API 转发',
      path: '/api-forward',
      icon: <Icons.Refresh size={18} />,
    },
    {
      name: 'DB API',
      path: '/db-api',
      icon: <Icons.Database size={18} />,
    },
    {
      name: 'NL2DATA',
      path: '/nl2data',
      icon: <Icons.MessageSquare size={18} />,
    },
  ];
  const bottomNavItems = [
    {
      name: '模型管理',
      path: '/model-management',
      icon: <Icons.Sparkles size={18} />,
    },
    {
      name: '数据库实例',
      path: '/database-instances',
      icon: <Icons.Database size={18} />,
    },
  ];

  return (
    <aside className="app-sidebar">
      <div className="sidebar-nav">
        <div style={{ padding: '0 14px 12px', fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          主菜单
        </div>
        {navItems.map((item) => {
          const isActive = pathname === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`sidebar-link ${isActive ? 'active' : ''}`}
            >
              <span className="sidebar-link-icon">{item.icon}</span>
              <span className="sidebar-link-text">{item.name}</span>
            </Link>
          );
        })}
      </div>

      <div className="sidebar-bottom">
        <div className="sidebar-nav sidebar-nav-bottom">
          <div style={{ padding: '0 14px 12px', fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            系统配置
          </div>
          {bottomNavItems.map((item) => {
            const isActive = pathname === item.path;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`sidebar-link ${isActive ? 'active' : ''}`}
              >
                <span className="sidebar-link-icon">{item.icon}</span>
                <span className="sidebar-link-text">{item.name}</span>
              </Link>
            );
          })}
        </div>

        <div style={{ 
          marginTop: 16,
          padding: '16px', 
          background: 'white', 
          borderRadius: 'var(--radius-lg)', 
          border: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)' }}></div>
            <span style={{ fontSize: 12, fontWeight: 700 }}>系统状态</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
            所有服务运行正常。当前处于本地节点。
          </p>
        </div>
      </div>
    </aside>
  );
}
