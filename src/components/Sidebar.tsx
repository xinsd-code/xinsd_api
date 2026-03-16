'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Sidebar() {
  const pathname = usePathname();

  const navItems = [
    {
      name: 'Mock 接口',
      path: '/',
      icon: '📡',
    },
    {
      name: 'API 接入',
      path: '/api-client',
      icon: '⚡',
    },
    {
      name: 'API 转发',
      path: '/api-forward',
      icon: '🔄',
    },
  ];

  return (
    <aside className="app-sidebar">
      <nav className="sidebar-nav">
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
      </nav>
    </aside>
  );
}
