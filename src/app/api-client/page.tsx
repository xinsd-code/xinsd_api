'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ApiClientConfig, KeyValuePair } from '@/lib/types';
import { resolveVariables } from '@/lib/utils';
import KeyValueEditor from '@/components/KeyValueEditor';
import ApiParamEditor from '@/components/ApiParamEditor';
import JsonEditor from '@/components/JsonEditor';
import GroupVarsModal from '@/components/GroupVarsModal';
import styles from './page.module.css';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

type TabKey = 'params' | 'headers' | 'body';

export default function ApiClientPage() {
  const [clients, setClients] = useState<ApiClientConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Current Editor State
  const [activeClient, setActiveClient] = useState<ApiClientConfig | null>(null);
  const [isEditingNew, setIsEditingNew] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('params');
  const [viewMode, setViewMode] = useState<'design' | 'run'>('design');
  
  // Form State
  const [name, setName] = useState('');
  const [apiGroup, setApiGroup] = useState('未分组');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [description, setDescription] = useState('');
  const [requestHeaders, setRequestHeaders] = useState<KeyValuePair[]>([]);
  const [requestParams, setRequestParams] = useState<KeyValuePair[]>([]);
  const [requestBody, setRequestBody] = useState('{\n  \n}');

  // Run Mode State
  const [runParams, setRunParams] = useState<Record<string, string>>({});

  // Group Variables Modal State
  const [showGroupVars, setShowGroupVars] = useState(false);
  const [editingGroup, setEditingGroup] = useState('');

  // Response State
  const [isSending, setIsSending] = useState(false);
  const [response, setResponse] = useState<{
    status: number;
    statusText: string;
    time: number;
    headers: Record<string, string>;
    data: any;
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

  const handleSelectClient = (client: ApiClientConfig) => {
    setActiveClient(client);
    setIsEditingNew(false);
    setName(client.name);
    setApiGroup(client.apiGroup || '未分组');
    setUrl(client.url);
    setMethod(client.method);
    setDescription(client.description || '');
    setRequestHeaders(client.requestHeaders || []);
    setRequestParams(client.requestParams || []);
    setRequestBody(client.requestBody || '{\n  \n}');
    setResponse(null);
    
    // Initialize run params
    const initialRunParams: Record<string, string> = {};
    (client.requestParams || []).forEach(p => {
      if (p.key) initialRunParams[p.key] = p.value || '';
    });
    setRunParams(initialRunParams);
    setViewMode('run');
  };

  const handleSave = async () => {
    if (!name.trim() || !url.trim()) {
      showToast('名称和 URL 不能为空', 'error');
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
        showToast('保存成功');
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
        showToast('创建成功');
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
      showToast('已删除');
      setActiveClient(null);
      fetchClients();
    } catch (error) {
      console.error(error);
      showToast('删除失败', 'error');
    }
  };

  const handleOpenGroupVars = (groupName: string, e: React.MouseEvent) => {
    e.stopPropagation(); // prevent toggling the group
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

    // Fetch variables for the active group
    const groupName = activeClient?.apiGroup || apiGroup || '未分组';
    let vars: KeyValuePair[] = [];
    try {
      const gRes = await fetch(`/api/groups/${encodeURIComponent(groupName)}/variables`);
      const data = await gRes.json();
      if (Array.isArray(data)) vars = data;
    } catch(e) {}

    // Build query params
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
      } catch (e) {
        // Fallback for invalid base URL
        const query = validParams.map(p => {
          const val = viewMode === 'run' ? (runParams[p.key] ?? p.value) : p.value;
          const resolvedVal = resolveVariables(val || '', vars);
          return `${encodeURIComponent(p.key)}=${encodeURIComponent(resolvedVal)}`;
        }).join('&');
        finalUrl += (finalUrl.includes('?') ? '&' : '?') + query;
      }
    }

    // Build headers
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
    } catch (error: any) {
      setResponse({
        status: 0,
        statusText: 'Network Error',
        time: 0,
        headers: {},
        data: null,
        error: error.message
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
    const groups: Record<string, ApiClientConfig[]> = {};
    filteredClients.forEach(c => {
      const g = c.apiGroup || '未分组';
      if (!groups[g]) groups[g] = [];
      groups[g].push(c);
    });
    return groups;
  }, [filteredClients]);

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Expand all groups by default when there is a search query
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

  const getStatusClass = (status: number) => {
    if (status >= 200 && status < 300) return styles.statusOk;
    return styles.statusErr;
  };

  return (
    <div className={styles.workspace}>
      {/* Sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTitle}>
            <span>接口列表</span>
            <button className="btn btn-icon btn-ghost" onClick={handleCreateNew} title="新建接口">
              +
            </button>
          </div>
          <div className="search-bar" style={{ maxWidth: '100%' }}>
            <span className="search-bar-icon">🔍</span>
            <input
              className="form-input"
              style={{ paddingLeft: 32, fontSize: 13, padding: '8px 12px 8px 32px' }}
              placeholder="搜索接口..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.apiList}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>加载中...</div>
          ) : filteredClients.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>暂无接口</div>
          ) : (
            Object.keys(groupedClients).sort().map(g => (
              <div key={g} className={styles.apiGroupContainer}>
                <div 
                  className={styles.apiGroupHeader} 
                  onClick={() => toggleGroup(g)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', cursor: 'pointer', background: 'var(--color-bg-hover)', borderBottom: '1px solid var(--color-border)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ display: 'inline-block', width: 16, transform: expandedGroups[g] !== false ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', fontSize: 10 }}>▶</span>
                    {g}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button 
                      className="btn btn-icon btn-ghost" 
                      onClick={(e) => handleOpenGroupVars(g, e)} 
                      style={{ padding: 4, height: 24, width: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      title="配置环境变量"
                    >
                      ⚙️
                    </button>
                    <span style={{ fontSize: 12, background: 'var(--color-bg-subtle)', padding: '2px 8px', borderRadius: 12 }}>{groupedClients[g].length}</span>
                  </div>
                </div>
                {expandedGroups[g] !== false && (
                  <div>
                    {groupedClients[g].map(client => (
                      <div 
                        key={client.id} 
                        className={`${styles.apiItem} ${activeClient?.id === client.id ? styles.active : ''}`}
                        onClick={() => handleSelectClient(client)}
                        style={{ paddingLeft: 24 }}
                      >
                        <div className={styles.apiItemHeader}>
                          <span className={getMethodClass(client.method)} style={{ transform: 'scale(0.85)', transformOrigin: 'left' }}>
                            {client.method}
                          </span>
                          <span className={styles.apiItemName}>{client.name}</span>
                        </div>
                        <div className={styles.apiItemUrl}>{client.url}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main Panel */}
      <div className={styles.mainPanel}>
        {(!activeClient && !isEditingNew) ? (
          <div className={styles.emptyCenter}>
            <div style={{ fontSize: 48 }}>⚡</div>
            <div>选择左侧接口或新建一个接口进行测试</div>
            <button className="btn btn-primary" onClick={handleCreateNew}>新建接口</button>
          </div>
        ) : (
          <div className={styles.editorBody}>
            {/* Toolbar */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <input 
                  className="form-input" 
                  style={{ width: 200, border: 'none', background: 'transparent', fontSize: 16, fontWeight: 600, padding: 0 }}
                  placeholder="接口名称"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-bg-subtle)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border)' }}>
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>📂</span>
                  <input 
                    className="form-input" 
                    style={{ width: 120, height: 20, fontSize: 12, padding: 0, border: 'none', background: 'transparent' }}
                    placeholder="所属分组..."
                    value={apiGroup}
                    onChange={e => setApiGroup(e.target.value)}
                  />
                </div>
                <div className="tabs" style={{ margin: 0 }}>
                  <button 
                    className={`tab ${viewMode === 'design' ? 'active' : ''}`} 
                    onClick={() => setViewMode('design')}
                    style={{ padding: '4px 12px', fontSize: 13 }}
                  >
                    配置模式 (Design)
                  </button>
                  <button 
                    className={`tab ${viewMode === 'run' ? 'active' : ''}`} 
                    onClick={() => setViewMode('run')}
                    style={{ padding: '4px 12px', fontSize: 13 }}
                  >
                    运行调试 (Run)
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {activeClient && (
                  <button className="btn btn-danger btn-sm" onClick={handleDelete}>删除</button>
                )}
                <button className="btn btn-secondary btn-sm" onClick={handleSave}>保存配置</button>
              </div>
            </div>

            {/* Request Bar */}
            <div className={styles.requestBar}>
              <div className={styles.urlInput}>
                <select 
                  className="form-select" 
                  value={method} 
                  onChange={e => setMethod(e.target.value)}
                >
                  {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <input 
                  className="form-input" 
                  placeholder="请输入真实的完整 API 地址，如 https://api.github.com/users/octocat"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                />
              </div>
              <button 
                className="btn btn-primary" 
                onClick={handleSend}
                disabled={isSending}
                style={{ width: 100, justifyContent: 'center' }}
              >
                {isSending ? '发送中...' : '发 送'}
              </button>
            </div>

            {/* Configuration Tabs */}
            <div className={styles.panels}>
              <div className={styles.configPanel}>
                {viewMode === 'run' ? (
                  <div style={{ padding: 16 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>运行参数 (Run Parameters)</h3>
                    {requestParams.filter(p => p.key).length === 0 ? (
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>此接口未定义参数。</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {requestParams.filter(p => p.key).map((p, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 120, fontSize: 13, fontWeight: 500, display: 'flex', justifyContent: 'space-between' }}>
                              <span>{p.key}</span>
                              <span style={{ color: 'var(--color-text-muted)', fontSize: 11, background: 'var(--color-bg-hover)', padding: '2px 6px', borderRadius: 4 }}>{p.type || 'string'}</span>
                            </div>
                            <input
                              className="form-input form-input-mono"
                              style={{ flex: 1 }}
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
                  <>
                    <div className="tabs" style={{ marginBottom: 16 }}>
                      <button className={`tab ${activeTab === 'params' ? 'active' : ''}`} onClick={() => setActiveTab('params')}>Params 定义</button>
                      <button className={`tab ${activeTab === 'headers' ? 'active' : ''}`} onClick={() => setActiveTab('headers')}>Headers 定义</button>
                      <button className={`tab ${activeTab === 'body' ? 'active' : ''}`} onClick={() => setActiveTab('body')}>Body 负载</button>
                    </div>
                    
                    <div className={styles.panelContent} style={{ flex: 1, padding: 0 }}>
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
                          keyPlaceholder="Header Name"
                          valuePlaceholder="Value"
                        />
                      )}
                      {activeTab === 'body' && (
                        <div style={{ height: 'calc(100% - 20px)' }}>
                          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                            {method === 'GET' ? 'GET 请求通常不携带 Body 内容。' : '填写自定义请求体（通常为 JSON）'}
                          </p>
                          <JsonEditor
                            value={requestBody}
                            onChange={setRequestBody}
                            height={200}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Response Panel */}
              <div className={styles.responsePanel}>
                {response ? (
                  <>
                    <div className={styles.responseHeader}>
                      <span>Status: <span className={getStatusClass(response.status)}>{response.status} {response.statusText}</span></span>
                      <span>Time: <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{response.time} ms</span></span>
                    </div>
                    {response.error ? (
                      <div style={{ color: 'var(--color-danger)', fontSize: 13, background: 'var(--color-danger-light)', padding: 12, borderRadius: 6 }}>
                        {response.error}
                      </div>
                    ) : (
                      <JsonEditor
                        value={typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2)}
                        onChange={() => {}}
                        height={250}
                      />
                    )}
                  </>
                ) : (
                  <div className={styles.emptyCenter}>
                    <span>Response output will appear here</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className={`toast ${toast.type === 'success' ? 'toast-success' : 'toast-error'}`}>
          {toast.message}
        </div>
      )}

      {/* Group Variables Modal */}
      {showGroupVars && (
        <GroupVarsModal
          groupName={editingGroup}
          onClose={() => setShowGroupVars(false)}
          onSaveToast={showToast}
        />
      )}
    </div>
  );
}
