'use client';

import { useState, useEffect, useCallback } from 'react';
import { MockAPI } from '@/lib/types';
import MockEditor from '@/components/MockEditor';
import GroupVarsModal from '@/components/GroupVarsModal';

export default function Home() {
  const [mocks, setMocks] = useState<MockAPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingMock, setEditingMock] = useState<MockAPI | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState<string>('ALL');
  const [groupFilter, setGroupFilter] = useState<string>('ALL');
  const [showGroupVars, setShowGroupVars] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const fetchMocks = useCallback(async () => {
    try {
      const res = await fetch('/api/mocks');
      const data = await res.json();
      setMocks(data);
    } catch (error) {
      console.error('Failed to fetch mocks:', error);
      showToast('获取接口列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchMocks();
  }, [fetchMocks]);

  const handleCreate = () => {
    setEditingMock(null);
    setShowEditor(true);
  };

  const handleEdit = (mock: MockAPI) => {
    setEditingMock(mock);
    setShowEditor(true);
  };

  const handleSave = async (data: Partial<MockAPI>) => {
    try {
      if (editingMock) {
        const res = await fetch(`/api/mocks/${editingMock.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Update failed');
        showToast('接口更新成功');
      } else {
        const res = await fetch('/api/mocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Create failed');
        showToast('接口创建成功');
      }
      setShowEditor(false);
      setEditingMock(null);
      fetchMocks();
    } catch (error) {
      console.error('Save failed:', error);
      showToast('保存失败', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个接口吗？')) return;
    try {
      const res = await fetch(`/api/mocks/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      showToast('接口已删除');
      fetchMocks();
    } catch (error) {
      console.error('Delete failed:', error);
      showToast('删除失败', 'error');
    }
  };

  const handleToggle = async (id: string) => {
    try {
      const res = await fetch('/api/mocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id }),
      });
      if (!res.ok) throw new Error('Toggle failed');
      fetchMocks();
    } catch (error) {
      console.error('Toggle failed:', error);
      showToast('切换状态失败', 'error');
    }
  };

  const filteredMocks = mocks.filter((mock) => {
    const matchesSearch =
      !searchQuery ||
      mock.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      mock.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
      mock.description.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesMethod = methodFilter === 'ALL' || mock.method === methodFilter;
    const matchesGroup = groupFilter === 'ALL' || mock.apiGroup === groupFilter || (!mock.apiGroup && groupFilter === '未分组');

    return matchesSearch && matchesMethod && matchesGroup;
  });

  const getMethodClass = (method: string) => {
    return `method-badge method-${method.toLowerCase()}`;
  };

  const allGroups = Array.from(new Set(mocks.map(m => m.apiGroup || '未分组'))).sort();

  const stats = {
    total: mocks.length,
    enabled: mocks.filter((m) => m.enabled).length,
    stream: mocks.filter((m) => m.isStream).length,
    methods: [...new Set(mocks.map((m) => m.method))].length,
  };

  const hasRestful = (path: string) => path.includes(':');

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⏳</div>
        <p className="empty-state-title">加载中...</p>
      </div>
    );
  }

  return (
    <>
      {/* Stats Cards */}
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card-value">{stats.total}</div>
          <div className="stat-card-label">接口总数</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value" style={{ color: 'var(--color-success)' }}>{stats.enabled}</div>
          <div className="stat-card-label">已启用</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value" style={{ color: '#a21caf' }}>{stats.stream}</div>
          <div className="stat-card-label">流式接口</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-value" style={{ color: 'var(--color-primary)' }}>{stats.methods}</div>
          <div className="stat-card-label">请求方法</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-bar">
            <span className="search-bar-icon">🔍</span>
            <input
              className="form-input"
              placeholder="搜索接口名称或路径..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ paddingLeft: 38 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              className="form-select"
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              style={{ minWidth: 120, height: 32, padding: '0 32px 0 12px', fontSize: 13 }}
            >
              <option value="ALL">所有分组</option>
              {allGroups.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            {groupFilter !== 'ALL' && (
              <button 
                className="btn btn-icon btn-ghost" 
                onClick={() => setShowGroupVars(true)}
                style={{ padding: 4, height: 32, width: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: -2 }}
                title="配置该分组环境变量"
              >
                ⚙️
              </button>
            )}
            <div style={{ width: 1, height: 20, background: 'var(--color-border)', margin: '0 4px' }} />
            {['ALL', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => (
              <button
                key={m}
                className={`filter-chip ${methodFilter === m ? 'active' : ''}`}
                onClick={() => setMethodFilter(m)}
              >
                {m === 'ALL' ? '全部' : m}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-primary" onClick={handleCreate}>
            + 新建接口
          </button>
        </div>
      </div>

      {/* Mock List */}
      {filteredMocks.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📡</div>
            <p className="empty-state-title">
              {mocks.length === 0 ? '还没有 Mock 接口' : '没有匹配的接口'}
            </p>
            <p className="empty-state-text">
              {mocks.length === 0
                ? '创建你的第一个 Mock 接口，开始模拟 API 数据吧'
                : '尝试调整搜索条件或筛选器'}
            </p>
            {mocks.length === 0 && (
              <button className="btn btn-primary" onClick={handleCreate}>
                + 创建第一个接口
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          {filteredMocks.map((mock) => (
            <div key={mock.id} className="mock-item">
              <button
                className={`status-toggle ${mock.enabled ? 'active' : 'inactive'}`}
                onClick={() => handleToggle(mock.id)}
                title={mock.enabled ? '点击禁用' : '点击启用'}
              />
              <span className={getMethodClass(mock.method)}>{mock.method}</span>
              <div className="mock-item-info">
                <div className="mock-item-name">{mock.name}</div>
                <div className="mock-item-path">
                  <span>/mock{mock.path}</span>
                  <div className="mock-item-tags">
                    {mock.apiGroup && mock.apiGroup !== '未分组' && <span className="tag" style={{ background: 'var(--color-bg-hover)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>{mock.apiGroup}</span>}
                    {hasRestful(mock.path) && <span className="tag tag-restful">RESTful</span>}
                    {mock.isStream && <span className="tag tag-stream">流式</span>}
                    {mock.responseDelay > 0 && (
                      <span className="tag tag-delay">{mock.responseDelay}ms</span>
                    )}
                  </div>
                </div>
                {mock.description && (
                  <div className="mock-item-desc">{mock.description}</div>
                )}
              </div>
              <div className="mock-item-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => handleEdit(mock)}>
                  编辑
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: 'var(--color-danger)' }}
                  onClick={() => handleDelete(mock.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor Modal */}
      {showEditor && (
        <MockEditor
          mock={editingMock}
          onSave={handleSave}
          onClose={() => {
            setShowEditor(false);
            setEditingMock(null);
          }}
        />
      )}

      {/* Group Variables Modal */}
      {showGroupVars && groupFilter !== 'ALL' && (
        <GroupVarsModal
          groupName={groupFilter}
          onClose={() => setShowGroupVars(false)}
          onSaveToast={showToast}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.type === 'success' ? 'toast-success' : 'toast-error'}`}>
          {toast.message}
        </div>
      )}
    </>
  );
}
