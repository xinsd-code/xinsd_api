'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ApiClientConfig, ApiClientSummary, KeyValuePair } from '@/lib/types';
import { resolveVariables } from '@/lib/utils';
import KeyValueEditor from '@/components/KeyValueEditor';
import ApiParamEditor from '@/components/ApiParamEditor';
import JsonEditor from '@/components/JsonEditor';
import GroupVarsModal from '@/components/GroupVarsModal';
import { Icons } from '@/components/Icons';
import styles from './page.module.css';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

type TabKey = 'params' | 'headers' | 'body';

export default function ApiClientPage() {
  const [clients, setClients] = useState<ApiClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  
  // 当前编辑器状态
  const [activeClient, setActiveClient] = useState<ApiClientConfig | null>(null);
  const [isEditingNew, setIsEditingNew] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('params');
  const [viewMode, setViewMode] = useState<'design' | 'run'>('design');
  
  // 表单状态
  const [name, setName] = useState('');
  const [apiGroup, setApiGroup] = useState('未分组');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [description, setDescription] = useState('');
  const [requestHeaders, setRequestHeaders] = useState<KeyValuePair[]>([]);
  const [requestParams, setRequestParams] = useState<KeyValuePair[]>([]);
  const [requestBody, setRequestBody] = useState('{\n  \n}');

  // 运行模式状态
  const [runParams, setRunParams] = useState<Record<string, string>>({});

  // 环境变量弹窗状态
  const [showGroupVars, setShowGroupVars] = useState(false);
  const [editingGroup, setEditingGroup] = useState('');

  // 响应状态
  const [isSending, setIsSending] = useState(false);
  const [response, setResponse] = useState<{
    status: number;
    statusText: string;
    time: number;
    headers: Record<string, string>;
    data: unknown;
    error?: string;
  } | null>(null);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch('/api/api-client');
      const data = await res.json();
      setClients(data);
    } catch (error) {
      console.error('Failed to fetch api clients:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  const handleCreateNew = () => {
    setActiveClient(null);
    setIsEditingNew(true);
    setName('未命名接口');
    setApiGroup('未分组');
    setUrl('https://api.example.com/data');
    setMethod('GET');
    setDescription('');
    setRequestHeaders([]);
    setRequestParams([]);
    setRequestBody('{\n  \n}');
    setResponse(null);
    setRunParams({});
    setViewMode('design');
  };

  const handleSelectClient = async (client: ApiClientSummary) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/api-client/${client.id}`);
      if (!res.ok) throw new Error('Failed to load detail');
      const detail: ApiClientConfig = await res.json();
      setActiveClient(detail);
      setIsEditingNew(false);
      setName(detail.name);
      setApiGroup(detail.apiGroup || '未分组');
      setUrl(detail.url);
      setMethod(detail.method);
      setDescription(detail.description || '');
      setRequestHeaders(detail.requestHeaders || []);
      setRequestParams(detail.requestParams || []);
      setRequestBody(detail.requestBody || '{\n  \n}');
      setResponse(null);
      // 初始化运行参数
      const initialRunParams: Record<string, string> = {};
      (detail.requestParams || []).forEach(p => {
        if (p.key) initialRunParams[p.key] = p.value || '';
      });
      setRunParams(initialRunParams);
      setViewMode('run');
    } catch (error) {
      console.error('Failed to load api-client detail:', error);
      showToast('加载接口详情失败', 'error');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !url.trim()) {
      showToast('接口名称和 URL 不能为空', 'error');
      return;
    }

    const payload = {
      name,
      apiGroup,
      url,
      method,
      description,
      requestHeaders: requestHeaders.filter(h => h.key),
      requestParams: requestParams.filter(p => p.key),
      requestBody
    };

    try {
      if (activeClient && !isEditingNew) {
        const res = await fetch(`/api/api-client/${activeClient.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Update failed');
        showToast('配置保存成功');
      } else {
        const res = await fetch('/api/api-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Create failed');
        const newClient = await res.json();
        setActiveClient(newClient);
        setIsEditingNew(false);
        showToast('接口创建成功');
      }
      fetchClients();
    } catch (error) {
      console.error(error);
      showToast('保存失败', 'error');
    }
  };

  const handleDelete = async () => {
    if (!activeClient) return;
    if (!confirm('确定要删除这个接口配置吗？')) return;
    try {
      const res = await fetch(`/api/api-client/${activeClient.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      showToast('接口已删除');
      setActiveClient(null);
      fetchClients();
    } catch (error) {
      console.error(error);
      showToast('删除失败', 'error');
    }
  };

  const handleOpenGroupVars = (groupName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingGroup(groupName);
    setShowGroupVars(true);
  };

  const handleSend = async () => {
    if (!url.trim()) {
      showToast('请输入有效的 URL', 'error');
      return;
    }

    setIsSending(true);
    setResponse(null);

    // 获取当前分组的环境变量
    const groupName = activeClient?.apiGroup || apiGroup || '未分组';
    let vars: KeyValuePair[] = [];
    try {
      const gRes = await fetch(`/api/groups/${encodeURIComponent(groupName)}/variables`);
      const data = await gRes.json();
      if (Array.isArray(data)) vars = data;
    } catch {}

    // 解析 URL 和查询参数
    let finalUrl = resolveVariables(url, vars);
    const validParams = requestParams.filter(p => p.key);
    if (validParams.length > 0) {
      try {
        const urlObj = new URL(finalUrl);
        validParams.forEach(p => {
          const val = viewMode === 'run' ? (runParams[p.key] ?? p.value) : p.value;
          const resolvedVal = resolveVariables(val || '', vars);
          urlObj.searchParams.append(p.key, resolvedVal);
        });
        finalUrl = urlObj.toString();
      } catch {
        const query = validParams.map(p => {
          const val = viewMode === 'run' ? (runParams[p.key] ?? p.value) : p.value;
          const resolvedVal = resolveVariables(val || '', vars);
          return `${encodeURIComponent(p.key)}=${encodeURIComponent(resolvedVal)}`;
        }).join('&');
        finalUrl += (finalUrl.includes('?') ? '&' : '?') + query;
      }
    }

    // 解析请求头
    const headersConfig: Record<string, string> = {};
    requestHeaders.filter(h => h.key).forEach(h => {
      headersConfig[h.key] = resolveVariables(h.value, vars);
    });

    let finalBody = requestBody;
    if (method !== 'GET' && method !== 'HEAD') {
      finalBody = resolveVariables(requestBody || '', vars);
    }

    try {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: finalUrl,
          method,
          headers: headersConfig,
          requestBody: (method !== 'GET' && method !== 'HEAD') ? finalBody : undefined,
        }),
      });
      
      const data = await res.json();
      setResponse(data);
    } catch (error) {
      setResponse({
        status: 0,
        statusText: '网络错误',
        time: 0,
        headers: {},
        data: null,
        error: error instanceof Error ? error.message : '请求执行失败'
      });
    } finally {
      setIsSending(false);
    }
  };

  const filteredClients = clients.filter(c => 
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    c.url.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const groupedClients = useMemo(() => {
    const groups: Record<string, ApiClientSummary[]> = {};
    filteredClients.forEach(c => {
      const g = c.apiGroup || '未分组';
      if (!groups[g]) groups[g] = [];
      groups[g].push(c);
    });
    return groups;
  }, [filteredClients]);

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (searchQuery) {
      const allExpanded: Record<string, boolean> = {};
      Object.keys(groupedClients).forEach(g => allExpanded[g] = true);
      setExpandedGroups(allExpanded);
    }
  }, [searchQuery, groupedClients]);

  const toggleGroup = (g: string) => setExpandedGroups(prev => ({...prev, [g]: !prev[g]}));

  const getMethodClass = (m: string) => {
    return `method-badge method-${m.toLowerCase()}`;
  };

  return (
    <div className={styles.workspace}>
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTitle}>
            <span>接口收藏夹</span>
            <button className="btn btn-icon btn-ghost" onClick={handleCreateNew} title="新建接口接入">
              <Icons.Plus size={18} />
            </button>
          </div>
          <div className="search-bar" style={{ maxWidth: '100%' }}>
            <Icons.Search className="search-bar-icon" size={14} />
            <input
              className="search-bar-input"
              style={{ height: '36px' }}
              placeholder="搜索接口..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.apiList}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>加载中...</div>
          ) : filteredClients.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>暂无匹配接口</div>
          ) : (
            Object.keys(groupedClients).sort().map(g => (
              <div key={g} className={styles.apiGroupContainer}>
                <div 
                  className={styles.apiGroupHeader} 
                  onClick={() => toggleGroup(g)}
                  style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    padding: '8px 12px', 
                    cursor: 'pointer', 
                    background: 'var(--color-bg-subtle)', 
                    borderRadius: 'var(--radius-md)',
                    margin: '2px 4px',
                    fontSize: 12, 
                    fontWeight: 700, 
                    color: 'var(--color-text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.02em'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icons.ChevronRight 
                      size={12} 
                      style={{ 
                        transform: expandedGroups[g] !== false ? 'rotate(90deg)' : 'rotate(0deg)', 
                        transition: 'transform 0.2s' 
                      }} 
                    />
                    {g}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button 
                      className="btn btn-icon btn-ghost" 
                      onClick={(e) => handleOpenGroupVars(g, e)} 
                      style={{ padding: 4, height: 24, width: 24 }}
                    >
                      <Icons.Settings size={14} />
                    </button>
                    <span style={{ fontSize: 10, background: 'var(--color-bg-hover)', padding: '2px 6px', borderRadius: 4 }}>{groupedClients[g].length}</span>
                  </div>
                </div>
                {expandedGroups[g] !== false && (
                  <div className="stagger-in">
                    {groupedClients[g].map(client => (
                      <div 
                        key={client.id} 
                        className={`${styles.apiItem} ${activeClient?.id === client.id ? styles.active : ''}`}
                        onClick={() => handleSelectClient(client)}
                        style={{ padding: '10px 16px 10px 36px', cursor: 'pointer', borderBottom: '1px solid var(--color-bg-subtle)' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <span className={getMethodClass(client.method)} style={{ transform: 'scale(0.8)', transformOrigin: 'left' }}>
                            {client.method}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{client.name}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--font-mono)' }}>{client.url}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className={styles.mainPanel}>
        {(!activeClient && !isEditingNew) ? (
          <div className={styles.emptyCenter}>
            <div style={{ 
              width: 80, 
              height: 80, 
              background: 'var(--color-bg-subtle)', 
              borderRadius: 'var(--radius-xl)', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center', 
              marginBottom: 24,
              color: 'var(--color-text-muted)'
            }}>
              <Icons.Zap size={40} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>准备好开始接入了吗？</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 14, marginBottom: 24 }}>在侧边栏选择一个接口，或点击下方按钮新建配置。</p>
            <button className="btn btn-primary" onClick={handleCreateNew}>
              <Icons.Plus size={18} />
              新建接口接入
            </button>
          </div>
        ) : (
          <div className={styles.editorBody}>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'white' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <input 
                    className="form-input" 
                    style={{ border: 'none', background: 'transparent', fontSize: 18, fontWeight: 800, padding: 0, height: 'auto', marginBottom: 2 }}
                    placeholder="请输入接口名称"
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icons.Layers size={12} style={{ color: 'var(--color-text-muted)' }} />
                    <input 
                      className="form-input" 
                      style={{ width: 140, height: 'auto', fontSize: 12, padding: 0, border: 'none', background: 'transparent', fontWeight: 600, color: 'var(--color-text-secondary)' }}
                      placeholder="分组名称..."
                      value={apiGroup}
                      onChange={e => setApiGroup(e.target.value)}
                    />
                  </div>
                </div>
                
                <div className="tabs" style={{ margin: 0, height: 40, width: 240 }}>
                  <button 
                    className={`tab ${viewMode === 'design' ? 'active' : ''}`} 
                    onClick={() => setViewMode('design')}
                  >
                    配置设计
                  </button>
                  <button 
                    className={`tab ${viewMode === 'run' ? 'active' : ''}`} 
                    onClick={() => setViewMode('run')}
                  >
                    运行调试
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                {activeClient && (
                  <button className="btn btn-ghost btn-icon" onClick={handleDelete} title="删除">
                    <Icons.Trash size={18} style={{ color: 'var(--color-danger)' }} />
                  </button>
                )}
                <button className="btn btn-primary" onClick={handleSave}>
                  保存配置
                </button>
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '24px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-subtle)' }}>
                <div style={{ display: 'flex', gap: 12, maxWidth: 1000 }}>
                  <div style={{ display: 'flex', flex: 1, background: 'white', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
                    <select 
                      className="form-select" 
                      value={method} 
                      onChange={e => setMethod(e.target.value)}
                      style={{ width: '110px', border: 'none', borderRight: '1px solid var(--color-border)', borderRadius: 0, fontWeight: 700, fontSize: 13, height: '42px' }}
                    >

                      {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input 
                      className="form-input" 
                      style={{ flex: 1, border: 'none', fontFamily: 'var(--font-mono)', fontSize: 13 }}
                      placeholder="https://api.example.com/v1/resource"
                      value={url}
                      onChange={e => setUrl(e.target.value)}
                    />
                  </div>
                  <button 
                    className="btn btn-primary" 
                    onClick={handleSend}
                    disabled={isSending}
                    style={{ width: 120, height: 42 }}
                  >
                    {isSending ? <div style={{ width: 16, height: 16, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div> : <Icons.Zap size={18} />}
                    {isSending ? '' : '发送请求'}
                  </button>
                </div>
              </div>

              <div className={styles.panels} style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--color-border)', overflowY: 'auto' }}>
                  {viewMode === 'run' ? (
                    <div style={{ padding: 24 }} className="stagger-in">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                        <Icons.Settings size={16} />
                        <h3 style={{ fontSize: 15, fontWeight: 800 }}>运行参数</h3>
                      </div>
                      
                      {requestParams.filter(p => p.key).length === 0 ? (
                        <div style={{ padding: '32px', textAlign: 'center', background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-lg)', color: 'var(--color-text-muted)', fontSize: 13, border: '1px dashed var(--color-border)' }}>
                          当前接口未定义自定义参数。
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                          {requestParams.filter(p => p.key).map((p, idx) => (
                            <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <label style={{ fontSize: 13, fontWeight: 700 }}>{p.key}</label>
                                <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--color-bg-hover)', padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{p.type || 'string'}</span>
                              </div>
                              <input
                                className="form-input"
                                style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                                placeholder={p.value || `请输入 ${p.key} 的值`}
                                value={runParams[p.key] !== undefined ? runParams[p.key] : p.value}
                                onChange={e => setRunParams(prev => ({ ...prev, [p.key]: e.target.value }))}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', height: '100%' }} className="stagger-in">
                    <div className="tabs" style={{ marginBottom: 24, background: 'var(--color-bg-subtle)', width: 'max-content', padding: 4 }}>
                      <button className={`tab ${activeTab === 'params' ? 'active' : ''}`} onClick={() => setActiveTab('params')} style={{ padding: '0 20px', minWidth: '100px' }}>查询参数</button>
                      <button className={`tab ${activeTab === 'headers' ? 'active' : ''}`} onClick={() => setActiveTab('headers')} style={{ padding: '0 20px', minWidth: '100px' }}>请求头</button>
                      <button className={`tab ${activeTab === 'body' ? 'active' : ''}`} onClick={() => setActiveTab('body')} style={{ padding: '0 20px', minWidth: '100px' }}>请求体</button>
                    </div>
                      
                      <div style={{ flex: 1 }}>
                        {activeTab === 'params' && (
                          <ApiParamEditor
                            items={requestParams}
                            onChange={setRequestParams}
                          />
                        )}
                        {activeTab === 'headers' && (
                          <KeyValueEditor
                            items={requestHeaders}
                            onChange={setRequestHeaders}
                            keyPlaceholder="Header 名称"
                            valuePlaceholder="对应的值"
                          />
                        )}
                        {activeTab === 'body' && (
                          <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                              {method === 'GET' ? 'GET 请求通常不需要请求体。' : '在下方定义您的 JSON 请求体。'}
                            </p>
                            <div className="editor-container" style={{ flex: 1, minHeight: 300 }}>
                              <JsonEditor
                                value={requestBody}
                                onChange={setRequestBody}
                                height={300}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ flex: 1, background: 'var(--color-bg-subtle)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  {response ? (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'white' }}>
                        <div style={{ display: 'flex', gap: 16 }}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>响应状态</span>
                            <span style={{ 
                              fontSize: 14, 
                              fontWeight: 800, 
                              color: response.status >= 200 && response.status < 300 ? 'var(--color-success)' : 'var(--color-danger)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6
                            }}>
                              {response.status >= 200 && response.status < 300 ? <Icons.Check size={14} /> : <Icons.Info size={14} />}
                              {response.status} {response.statusText}
                            </span>
                          </div>
                          <div style={{ width: 1, height: 24, background: 'var(--color-border)', alignSelf: 'center' }}></div>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>耗时</span>
                            <span style={{ fontSize: 14, fontWeight: 800 }}>{response.time} ms</span>
                          </div>
                        </div>
                        
                        <button className="btn btn-secondary btn-sm" onClick={() => setResponse(null)}>
                          清除结果
                        </button>
                      </div>
                      
                      <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
                        {response.error ? (
                          <div style={{ padding: 20, background: 'var(--color-danger-soft)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-danger)', color: 'var(--color-danger)', fontSize: 13 }}>
                            <div style={{ fontWeight: 800, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Icons.Info size={16} />
                              请求执行失败
                            </div>
                            {response.error}
                          </div>
                        ) : (
                          <div className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                            <div style={{ padding: '8px 16px', background: 'var(--color-bg-subtle)', borderBottom: '1px solid var(--color-border)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
                              响应内容
                            </div>
                            <JsonEditor
                              value={typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2)}
                              onChange={() => {}}
                              height={400}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className={styles.emptyCenter}>
                      <div style={{ color: 'var(--color-text-muted)', marginBottom: 16 }}>
                        <Icons.Monitor size={48} strokeWidth={1} />
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-muted)' }}>响应结果将在此处显示</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.type === 'success' ? <Icons.Check size={18} /> : <Icons.Info size={18} />}
          {toast.message}
        </div>
      )}

      {showGroupVars && (
        <GroupVarsModal
          groupName={editingGroup}
          onClose={() => setShowGroupVars(false)}
          onSaveToast={showToast}
        />
      )}
      
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes spin { to { transform: rotate(360deg); } }
      `}} />
    </div>
  );
}
