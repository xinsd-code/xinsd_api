'use client';

import { useState, useEffect } from 'react';
import { MockAPI, KeyValuePair, StreamConfig } from '@/lib/types';
import KeyValueEditor from './KeyValueEditor';
import StreamConfigEditor from './StreamConfigEditor';
import JsonEditor from './JsonEditor';

interface MockEditorProps {
  mock?: MockAPI | null;
  onSave: (data: Partial<MockAPI>) => void;
  onClose: () => void;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

const DEFAULT_RESPONSE_BODY = JSON.stringify(
  {
    code: 200,
    message: 'success',
    data: {},
  },
  null,
  2
);

type TabKey = 'basic' | 'request' | 'response' | 'stream';

export default function MockEditor({ mock, onSave, onClose }: MockEditorProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('basic');

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [method, setMethod] = useState('GET');
  const [description, setDescription] = useState('');
  const [apiGroup, setApiGroup] = useState('未分组');
  const [enabled, setEnabled] = useState(true);

  const [requestHeaders, setRequestHeaders] = useState<KeyValuePair[]>([]);
  const [requestParams, setRequestParams] = useState<KeyValuePair[]>([]);

  const [responseStatus, setResponseStatus] = useState(200);
  const [responseHeaders, setResponseHeaders] = useState<KeyValuePair[]>([]);
  const [responseBody, setResponseBody] = useState(DEFAULT_RESPONSE_BODY);
  const [responseDelay, setResponseDelay] = useState(0);

  const [isStream, setIsStream] = useState(false);
  const [streamConfig, setStreamConfig] = useState<StreamConfig>({
    chunkDelay: 100,
    chunks: [],
  });

  // Load existing mock data
  useEffect(() => {
    if (mock) {
      setName(mock.name);
      setPath(mock.path);
      setMethod(mock.method);
      setDescription(mock.description);
      setApiGroup(mock.apiGroup || '未分组');
      setEnabled(mock.enabled);
      setRequestHeaders(mock.requestHeaders);
      setRequestParams(mock.requestParams);
      setResponseStatus(mock.responseStatus);
      setResponseHeaders(mock.responseHeaders);
      setResponseBody(mock.responseBody);
      setResponseDelay(mock.responseDelay);
      setIsStream(mock.isStream);
      setStreamConfig(mock.streamConfig);
    }
  }, [mock]);

  const handleSubmit = () => {
    if (!name.trim()) {
      alert('请输入接口名称');
      return;
    }
    if (!path.trim()) {
      alert('请输入接口路径');
      return;
    }

    onSave({
      name: name.trim(),
      path: path.trim().startsWith('/') ? path.trim() : '/' + path.trim(),
      method,
      description: description.trim(),
      apiGroup: apiGroup.trim() || '未分组',
      enabled,
      requestHeaders: requestHeaders.filter((h) => h.key),
      requestParams: requestParams.filter((p) => p.key),
      responseStatus,
      responseHeaders: responseHeaders.filter((h) => h.key),
      responseBody,
      responseDelay,
      isStream,
      streamConfig,
    });
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'basic', label: '基本信息' },
    { key: 'request', label: '请求配置' },
    { key: 'response', label: '响应配置' },
    { key: 'stream', label: '流式响应' },
  ];

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content">
        <div className="modal-header">
          <h2 className="modal-title">{mock ? '编辑 Mock 接口' : '创建 Mock 接口'}</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                className={`tab ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'basic' && (
            <div>
              <div className="form-group">
                <label className="form-label">接口名称 *</label>
                <input
                  className="form-input"
                  placeholder="例如: 获取用户信息"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">请求方法 *</label>
                  <select
                    className="form-select"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    {HTTP_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">响应状态码</label>
                  <input
                    type="number"
                    className="form-input"
                    value={responseStatus}
                    onChange={(e) => setResponseStatus(parseInt(e.target.value) || 200)}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">
                  接口路径 * <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>
                    (支持 RESTful 参数，如 /users/:id)
                  </span>
                </label>
                <input
                  className="form-input form-input-mono"
                  placeholder="例如: /api/users/:id"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">描述</label>
                <input
                  className="form-input"
                  placeholder="接口用途描述"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">所属分组</label>
                <input
                  className="form-input"
                  placeholder="自定义分组名称，如: 用户模块、订单服务 (默认: 未分组)"
                  value={apiGroup}
                  onChange={(e) => setApiGroup(e.target.value)}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">响应延迟 (ms)</label>
                  <input
                    type="number"
                    className="form-input"
                    value={responseDelay}
                    onChange={(e) => setResponseDelay(parseInt(e.target.value) || 0)}
                    min={0}
                  />
                </div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                    />
                    启用接口
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'request' && (
            <div>
              <div className="form-group">
                <div className="section-header">
                  <label className="form-label" style={{ marginBottom: 0 }}>请求头匹配</label>
                </div>
                <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                  配置需要匹配的请求头，所有配置的头部必须在请求中存在才能匹配
                </p>
                <KeyValueEditor
                  items={requestHeaders}
                  onChange={setRequestHeaders}
                  keyPlaceholder="Header Name"
                  valuePlaceholder="Header Value (可选)"
                />
              </div>

              <div className="form-group" style={{ marginTop: 24 }}>
                <div className="section-header">
                  <label className="form-label" style={{ marginBottom: 0 }}>请求参数匹配</label>
                </div>
                <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                  配置需要匹配的查询参数或请求体参数
                </p>
                <KeyValueEditor
                  items={requestParams}
                  onChange={setRequestParams}
                  keyPlaceholder="参数名"
                  valuePlaceholder="参数值 (可选)"
                />
              </div>
            </div>
          )}

          {activeTab === 'response' && (
            <div>
              <div className="form-group">
                <label className="form-label">响应头</label>
                <KeyValueEditor
                  items={responseHeaders}
                  onChange={setResponseHeaders}
                  keyPlaceholder="Header Name"
                  valuePlaceholder="Header Value"
                />
              </div>

              <div className="form-group" style={{ marginTop: 20 }}>
                <label className="form-label">
                  响应体 <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>
                    (可使用 :param 或 {'{param}'} 引用路径参数)
                  </span>
                </label>
                <JsonEditor
                  value={responseBody}
                  onChange={setResponseBody}
                  height={240}
                />
              </div>
            </div>
          )}

          {activeTab === 'stream' && (
            <div>
              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={isStream}
                    onChange={(e) => setIsStream(e.target.checked)}
                  />
                  启用流式响应 (SSE)
                </label>
                <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
                  启用后，接口将以 Server-Sent Events 方式逐块返回数据
                </p>
              </div>

              {isStream && (
                <StreamConfigEditor
                  config={streamConfig}
                  onChange={setStreamConfig}
                />
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {mock ? '保存修改' : '创建接口'}
          </button>
        </div>
      </div>
    </div>
  );
}
