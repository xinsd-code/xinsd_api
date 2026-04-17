import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.DB_HARNESS_TEST_BASE_URL || 'http://127.0.0.1:3000';
const STATUS_SEPARATOR = '\n__STATUS__:';
const COOKIE_JAR = path.join(os.tmpdir(), `db-harness-test-cookie-${process.pid}.txt`);

function request(path, options = {}) {
  const args = ['-sS', '-X', options.method || 'GET', '-w', `${STATUS_SEPARATOR}%{http_code}`];
  if (options.withCookies !== false) {
    args.push('-b', COOKIE_JAR, '-c', COOKIE_JAR);
  }
  if (options.headers && typeof options.headers === 'object') {
    for (const [header, value] of Object.entries(options.headers)) {
      if (typeof value === 'string' && header.trim()) {
        args.push('-H', `${header}: ${value}`);
      }
    }
  }
  if (options.body !== undefined) {
    if (!options.headers || !Object.keys(options.headers).some((header) => header.toLowerCase() === 'content-type')) {
      args.push('-H', 'Content-Type: application/json');
    }
    args.push('-d', JSON.stringify(options.body));
  }
  args.push(`${BASE_URL}${path}`);
  const output = execFileSync('curl', args, { encoding: 'utf8' });
  const [bodyText, statusText] = output.split(STATUS_SEPARATOR);
  const status = Number.parseInt(statusText || '0', 10);
  let body = null;
  if (bodyText && bodyText.trim()) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  return {
    status,
    body,
  };
}

function parseSseFrames(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) {
    return [];
  }
  return bodyText
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines
        .filter((line) => line.startsWith('event:'))
        .map((line) => line.slice('event:'.length).trim())[0] || '';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      return { event, data };
    })
    .filter((frame) => frame.event);
}

function isServerReachable() {
  try {
    execFileSync('curl', ['-sS', '-I', BASE_URL], { encoding: 'utf8', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureSession() {
  // 第一次请求让中间件下发 cookie，第二次请求带 cookie 命中 requireSession
  request('/api/db-harness/metrics', { withCookies: true });
  const second = request('/api/db-harness/metrics', { withCookies: true });
  return second;
}

function findOnlineTriggeredRun(runs, workspaceId, databaseId) {
  return runs.find((run) =>
    run?.workspaceId === workspaceId
    && run?.databaseId === databaseId
    && run?.report
    && typeof run.report === 'object'
    && !Array.isArray(run.report)
    && run.report.trigger
    && typeof run.report.trigger === 'object'
    && !Array.isArray(run.report.trigger)
    && run.report.trigger.kind === 'online-regression'
  ) || null;
}

function listOnlineTriggeredRuns(runs, workspaceId, databaseId) {
  return runs.filter((run) =>
    run?.workspaceId === workspaceId
    && run?.databaseId === databaseId
    && run?.report
    && typeof run.report === 'object'
    && !Array.isArray(run.report)
    && run.report.trigger
    && typeof run.report.trigger === 'object'
    && !Array.isArray(run.report.trigger)
    && run.report.trigger.kind === 'online-regression'
  );
}

function pickSupportedDatabase(databases) {
  return databases.find((item) =>
    item && typeof item === 'object' && (item.type === 'mysql' || item.type === 'pgsql' || item.type === 'mongo')
  ) || null;
}

function pickWorkspaceWithDatabaseEngine(workspaces, databases, engine) {
  const targetDatabase = databases.find((database) => database?.type === engine);
  if (!targetDatabase) {
    return null;
  }
  const targetWorkspace = workspaces.find((workspace) => workspace?.databaseId === targetDatabase.id);
  if (!targetWorkspace) {
    return null;
  }
  return {
    workspace: targetWorkspace,
    database: targetDatabase,
  };
}

test('DB Harness workspace list returns array', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const response = request('/api/db-harness/workspaces');
  assert.equal(response.status, 200, 'workspace 接口应返回 200');
  assert.ok(Array.isArray(response.body), 'workspace payload 应为数组');
});

test('DB Harness metrics endpoint returns array after session handshake', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const response = ensureSession();
  assert.equal(response.status, 200, 'metrics 接口应在会话握手后返回 200');
  assert.ok(response.body && Array.isArray(response.body.metrics), 'metrics payload 应包含 metrics 数组');
});

test('GEPA run list returns runs array', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const response = request('/api/db-harness/gepa/runs?limit=5');
  assert.equal(response.status, 200, 'GEPA run 列表接口应返回 200');
  assert.ok(response.body && Array.isArray(response.body.runs), 'GEPA run payload 应包含 runs 数组');
});

test('DB Harness feedback validates required fields and feedback type', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const missingFields = request('/api/db-harness/feedback', {
    method: 'POST',
    body: {},
  });
  assert.equal(missingFields.status, 400, '缺少必填字段时应返回 400');

  const invalidType = request('/api/db-harness/feedback', {
    method: 'POST',
    body: {
      messageId: 'msg-test',
      databaseInstanceId: 'db-test',
      question: '测试问题',
      reply: '测试回答',
      feedbackType: 'invalid-feedback-type',
    },
  });
  assert.equal(invalidType.status, 400, '反馈类型非法时应返回 400');
});

test('GEPA create validates required fields', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const missingWorkspace = request('/api/db-harness/gepa/runs', {
    method: 'POST',
    body: { databaseId: 'demo-db' },
  });
  assert.equal(missingWorkspace.status, 400, '缺失 workspaceId 应返回 400');

  const missingDatabase = request('/api/db-harness/gepa/runs', {
    method: 'POST',
    body: { workspaceId: 'demo-workspace' },
  });
  assert.equal(missingDatabase.status, 400, '缺失 databaseId 应返回 400');
});

test('GEPA run can be created and deleted through API', async (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];
  const workspace = workspaces.find((item) => item && typeof item === 'object' && item.databaseId);
  if (!workspace) {
    t.skip('当前环境没有可用于 GEPA 的 workspace + database 组合');
    return;
  }

  const createResponse = request('/api/db-harness/gepa/runs', {
    method: 'POST',
    body: {
      workspaceId: workspace.id,
      databaseId: workspace.databaseId,
      sampleLimit: 2,
      promptCandidateCount: 1,
      policyCandidateCount: 1,
    },
  });

  assert.equal(createResponse.status, 200, '创建 GEPA run 应返回 200');
  const createPayload = createResponse.body;
  assert.ok(createPayload?.run?.id, '创建 GEPA run 后应返回 run.id');
  assert.equal(createPayload?.run?.report?.mode, 'execution-backed', 'GEPA run 应为 execution-backed 模式');
  assert.ok(
    Array.isArray(createPayload?.run?.scoreCard?.notes)
      && createPayload.run.scoreCard.notes.some((note) => typeof note === 'string' && note.includes('真实执行回放')),
    'scoreCard 备注应体现真实执行回放'
  );
  const createdId = createPayload.run.id;

  const detailResponse = request(`/api/db-harness/gepa/runs/${createdId}`);
  assert.equal(detailResponse.status, 200, 'GEPA run 查询应返回 200');
  assert.equal(detailResponse?.body?.run?.id, createdId, '新建的 GEPA run 应可被查询');

  const listResponse = request('/api/db-harness/gepa/runs?limit=20');
  assert.equal(listResponse.status, 200, 'GEPA run 列表查询应返回 200');
  assert.ok(
    Array.isArray(listResponse.body?.runs) && listResponse.body.runs.some((run) => run?.id === createdId),
    '新建 run 应出现在列表中'
  );

  const deleteResponse = request(`/api/db-harness/gepa/runs/${createdId}`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 200, '删除 GEPA run 应返回 200');
  assert.equal(deleteResponse?.body?.success, true, 'GEPA run 应可被删除');

  const deleteMissingResponse = request(`/api/db-harness/gepa/runs/${createdId}`, {
    method: 'DELETE',
  });
  assert.equal(deleteMissingResponse.status, 404, '重复删除不存在 run 应返回 404');
});

test('degrading metrics can trigger online GEPA evaluation', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 metrics 接口应可访问');

  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];
  const workspace = workspaces.find((item) => item && typeof item === 'object' && item.databaseId);
  if (!workspace) {
    t.skip('当前环境没有可用于在线 GEPA 触发的 workspace + database 组合');
    return;
  }

  const baselineRunList = request('/api/db-harness/gepa/runs?limit=30');
  assert.equal(baselineRunList.status, 200, 'GEPA run 列表应返回 200');
  const beforeRuns = Array.isArray(baselineRunList.body?.runs) ? baselineRunList.body.runs : [];
  const beforeOnline = findOnlineTriggeredRun(beforeRuns, workspace.id, workspace.databaseId);

  const base = Date.now();
  const failingMetrics = Array.from({ length: 4 }).map((_, index) => ({
    turnId: `online-trigger-${base}-${index}`,
    workspaceId: workspace.id,
    databaseId: workspace.databaseId,
    question: `在线触发测试问题 ${base}-${index}`,
    queryFingerprint: `fp-${base}-${index}`,
    outcome: index % 2 === 0 ? 'error' : 'empty',
    confidence: 0.45,
    rowCount: 0,
    fromCache: false,
    labels: ['validation-fail', 'test-online-trigger'],
  }));

  for (const metric of failingMetrics) {
    const postMetric = request('/api/db-harness/metrics', {
      method: 'POST',
      body: metric,
    });
    assert.equal(postMetric.status, 200, '写入退化指标应返回 200');
  }

  const triggeredRunList = request('/api/db-harness/gepa/runs?limit=40');
  assert.equal(triggeredRunList.status, 200, '触发后 GEPA run 列表应返回 200');
  const afterRuns = Array.isArray(triggeredRunList.body?.runs) ? triggeredRunList.body.runs : [];
  const afterOnline = findOnlineTriggeredRun(afterRuns, workspace.id, workspace.databaseId);

  assert.ok(afterOnline, '退化指标后应存在 online-regression 触发记录');
  assert.equal(afterOnline.report.trigger.kind, 'online-regression', '触发类型应为 online-regression');
  assert.ok(
    typeof afterOnline.report.trigger.metricCount === 'number' && afterOnline.report.trigger.metricCount >= 4,
    'trigger.metricCount 应记录足够的指标样本'
  );
  if (beforeOnline) {
    assert.ok(
      Date.parse(afterOnline.updatedAt || afterOnline.createdAt || '')
        >= Date.parse(beforeOnline.updatedAt || beforeOnline.createdAt || ''),
      '在线触发记录应保持最新'
    );
  }
});

test('online GEPA trigger should respect cooldown and avoid duplicate runs', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 metrics 接口应可访问');

  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];
  const workspace = workspaces.find((item) => item && typeof item === 'object' && item.databaseId);
  if (!workspace) {
    t.skip('当前环境没有可用于在线 GEPA 触发的 workspace + database 组合');
    return;
  }

  const beforeList = request('/api/db-harness/gepa/runs?limit=50');
  assert.equal(beforeList.status, 200, 'GEPA run 列表应返回 200');
  const beforeRuns = Array.isArray(beforeList.body?.runs) ? beforeList.body.runs : [];
  const beforeOnlineRuns = listOnlineTriggeredRuns(beforeRuns, workspace.id, workspace.databaseId);
  const base = Date.now();

  const firstBatch = Array.from({ length: 4 }).map((_, index) => ({
    turnId: `online-cooldown-a-${base}-${index}`,
    workspaceId: workspace.id,
    databaseId: workspace.databaseId,
    question: `在线冷却测试A-${base}-${index}`,
    queryFingerprint: `cooldown-a-fp-${base}-${index}`,
    outcome: 'error',
    confidence: 0.42,
    rowCount: 0,
    fromCache: false,
    labels: ['validation-fail', 'test-online-cooldown'],
  }));

  for (const metric of firstBatch) {
    const postMetric = request('/api/db-harness/metrics', {
      method: 'POST',
      body: metric,
    });
    assert.equal(postMetric.status, 200, '首批退化指标写入应返回 200');
  }

  const firstAfterList = request('/api/db-harness/gepa/runs?limit=50');
  assert.equal(firstAfterList.status, 200, '首批写入后 GEPA 列表应返回 200');
  const firstAfterRuns = Array.isArray(firstAfterList.body?.runs) ? firstAfterList.body.runs : [];
  const firstAfterOnlineRuns = listOnlineTriggeredRuns(firstAfterRuns, workspace.id, workspace.databaseId);
  const firstOnline = firstAfterOnlineRuns[0] || null;
  assert.ok(firstOnline, '首批退化指标后应有 online-regression 记录');

  const secondBatch = Array.from({ length: 4 }).map((_, index) => ({
    turnId: `online-cooldown-b-${base}-${index}`,
    workspaceId: workspace.id,
    databaseId: workspace.databaseId,
    question: `在线冷却测试B-${base}-${index}`,
    queryFingerprint: `cooldown-b-fp-${base}-${index}`,
    outcome: index % 2 === 0 ? 'error' : 'empty',
    confidence: 0.4,
    rowCount: 0,
    fromCache: false,
    labels: ['validation-fail', 'test-online-cooldown'],
  }));

  for (const metric of secondBatch) {
    const postMetric = request('/api/db-harness/metrics', {
      method: 'POST',
      body: metric,
    });
    assert.equal(postMetric.status, 200, '第二批退化指标写入应返回 200');
  }

  const secondAfterList = request('/api/db-harness/gepa/runs?limit=50');
  assert.equal(secondAfterList.status, 200, '第二批写入后 GEPA 列表应返回 200');
  const secondAfterRuns = Array.isArray(secondAfterList.body?.runs) ? secondAfterList.body.runs : [];
  const secondAfterOnlineRuns = listOnlineTriggeredRuns(secondAfterRuns, workspace.id, workspace.databaseId);
  const secondOnline = secondAfterOnlineRuns[0] || null;
  assert.ok(secondOnline, '第二批退化指标后应仍有 online-regression 记录');

  assert.equal(
    secondOnline.id,
    firstOnline.id,
    '冷却期内重复触发应复用最近 online run，而不是新建重复 run'
  );

  if (beforeOnlineRuns.length > 0) {
    assert.ok(
      secondAfterOnlineRuns.length >= beforeOnlineRuns.length,
      '冷却防抖后 online run 数量不应异常回退'
    );
  }
});

test('GEPA create supports mongo datasource when workspace is bound to mongo', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];

  const databaseResponse = request('/api/database-instances');
  assert.equal(databaseResponse.status, 200, 'database 列表应返回 200');
  const databases = Array.isArray(databaseResponse.body) ? databaseResponse.body : [];

  const mongoPair = pickWorkspaceWithDatabaseEngine(workspaces, databases, 'mongo');
  if (!mongoPair) {
    t.skip('当前环境没有绑定 Mongo 数据源的 workspace，跳过 Mongo GEPA 回归测试');
    return;
  }

  const createResponse = request('/api/db-harness/gepa/runs', {
    method: 'POST',
    body: {
      workspaceId: mongoPair.workspace.id,
      databaseId: mongoPair.database.id,
      sampleLimit: 2,
      promptCandidateCount: 1,
      policyCandidateCount: 1,
    },
  });
  assert.equal(createResponse.status, 200, 'Mongo 数据源创建 GEPA run 应返回 200');
  const run = createResponse.body?.run;
  assert.ok(run?.id, 'Mongo GEPA run 应返回 id');
  assert.equal(run?.databaseId, mongoPair.database.id, 'Mongo GEPA run 的 databaseId 应正确');
  assert.equal(run?.report?.mode, 'execution-backed', 'Mongo GEPA run 应为 execution-backed');

  const removeResponse = request(`/api/db-harness/gepa/runs/${run.id}`, {
    method: 'DELETE',
  });
  assert.equal(removeResponse.status, 200, 'Mongo GEPA run 应可删除');
});

test('metrics API should accept and return mongo engine records', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 metrics 接口应可访问');

  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];

  const databaseResponse = request('/api/database-instances');
  assert.equal(databaseResponse.status, 200, 'database 列表应返回 200');
  const databases = Array.isArray(databaseResponse.body) ? databaseResponse.body : [];

  const mongoPair = pickWorkspaceWithDatabaseEngine(workspaces, databases, 'mongo');
  if (!mongoPair) {
    t.skip('当前环境没有绑定 Mongo 数据源的 workspace，跳过 Mongo metrics 回归测试');
    return;
  }

  const turnId = `mongo-metrics-${Date.now()}`;
  const createMetric = request('/api/db-harness/metrics', {
    method: 'POST',
    body: {
      turnId,
      workspaceId: mongoPair.workspace.id,
      databaseId: mongoPair.database.id,
      engine: 'mongo',
      question: 'Mongo 指标回归测试问题',
      queryFingerprint: `mongo-fingerprint-${turnId}`,
      outcome: 'success',
      confidence: 0.83,
      rowCount: 3,
      fromCache: false,
      labels: ['mongo-regression-test'],
    },
  });
  assert.equal(createMetric.status, 200, '写入 Mongo 指标应返回 200');
  assert.equal(createMetric.body?.metric?.engine, 'mongo', '写入结果应保留 mongo engine');

  const listMetrics = request(
    `/api/db-harness/metrics?workspaceId=${encodeURIComponent(mongoPair.workspace.id)}&databaseId=${encodeURIComponent(mongoPair.database.id)}&limit=20`
  );
  assert.equal(listMetrics.status, 200, '查询 Mongo 指标列表应返回 200');
  const metrics = Array.isArray(listMetrics.body?.metrics) ? listMetrics.body.metrics : [];
  const inserted = metrics.find((metric) => metric?.turnId === turnId);
  assert.ok(inserted, 'Mongo 指标应可在列表中检索到');
  assert.equal(inserted.engine, 'mongo', 'Mongo 指标的 engine 应保持为 mongo');
});

test('chat SSE should stream sub-agent completion progress events', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 DB Harness 接口应可访问');

  const databasesResponse = request('/api/database-instances');
  assert.equal(databasesResponse.status, 200, 'database 列表应返回 200');
  const databases = Array.isArray(databasesResponse.body) ? databasesResponse.body : [];
  const database = databases.find((item) =>
    item && typeof item === 'object' && (item.type === 'mysql' || item.type === 'pgsql' || item.type === 'mongo')
  );
  if (!database) {
    t.skip('当前环境没有可用于 DB Harness 对话的数据源');
    return;
  }

  const chatResponse = request('/api/db-harness/chat', {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
    },
    body: {
      databaseInstanceId: database.id,
      messages: [
        { role: 'user', content: '请返回一个最近7天可验证的统计示例。' },
      ],
      stream: true,
    },
  });

  if (chatResponse.status !== 200) {
    t.skip(`chat SSE 环境不可用（status=${chatResponse.status}），跳过流式链路回归`);
    return;
  }

  const frames = parseSseFrames(chatResponse.body);
  assert.ok(frames.length > 0, 'SSE 响应应包含至少一个事件帧');

  const progressFrames = frames.filter((frame) => frame.event === 'progress');
  const finalFrame = frames.find((frame) => frame.event === 'final');
  const errorFrame = frames.find((frame) => frame.event === 'error');

  if (errorFrame && !finalFrame) {
    t.skip('chat SSE 本轮返回 error 事件，跳过子 Agent 进度断言');
    return;
  }

  assert.ok(progressFrames.length > 0, 'SSE 应返回 progress 事件');
  assert.ok(finalFrame, 'SSE 应返回 final 事件');

  const progressEvents = progressFrames
    .map((frame) => {
      try {
        return JSON.parse(frame.data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const completeStages = new Set(
    progressEvents
      .filter((event) => event.status === 'complete' && typeof event.stage === 'string')
      .map((event) => event.stage)
  );

  assert.ok(completeStages.has('intent'), '应包含 Intent Agent 完成事件');
  assert.ok(completeStages.has('schema'), '应包含 Schema Agent 完成事件');
});

test('positive feedback with high confidence should enter template candidates', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 DB Harness 接口应可访问');

  const databaseResponse = request('/api/database-instances');
  assert.equal(databaseResponse.status, 200, 'database 列表应返回 200');
  const databases = Array.isArray(databaseResponse.body) ? databaseResponse.body : [];
  const database = pickSupportedDatabase(databases);
  if (!database) {
    t.skip('当前环境没有可用于测试的 MySQL / PostgreSQL / Mongo 数据源');
    return;
  }

  const marker = `template-gate-pass-${Date.now()}`;
  const workspaceCreate = request('/api/db-harness/workspaces', {
    method: 'POST',
    body: {
      name: `模板门槛通过-${marker}`,
      databaseId: database.id,
      rules: '',
    },
  });
  assert.equal(workspaceCreate.status, 201, '创建测试 workspace 应返回 201');
  const workspaceId = workspaceCreate.body?.id;
  assert.ok(workspaceId, '创建测试 workspace 应返回 id');

  try {
    const degradedMetrics = Array.from({ length: 4 }).map((_, index) => ({
      turnId: `${marker}-metric-${index}`,
      workspaceId,
      databaseId: database.id,
      engine: database.type,
      question: `模板门槛回归问题-${marker}-${index}`,
      queryFingerprint: `${marker}-fp-${index}`,
      outcome: index % 2 === 0 ? 'error' : 'empty',
      confidence: 0.48,
      rowCount: 0,
      fromCache: false,
      labels: ['validation-fail', 'template-gate-pass'],
    }));
    for (const metric of degradedMetrics) {
      const postMetric = request('/api/db-harness/metrics', {
        method: 'POST',
        body: metric,
      });
      assert.equal(postMetric.status, 200, '写入退化指标应返回 200');
    }

    const feedbackResponse = request('/api/db-harness/feedback', {
      method: 'POST',
      body: {
        workspaceId,
        messageId: `${marker}-message`,
        databaseInstanceId: database.id,
        question: `请按正确口径查询 ${marker}`,
        reply: '已返回测试结果',
        feedbackType: 'positive',
        confidence: 0.9,
        fromCache: false,
        note: marker,
      },
    });
    assert.equal(feedbackResponse.status, 200, '高置信正反馈写入应返回 200');

    const createRun = request('/api/db-harness/gepa/runs', {
      method: 'POST',
      body: {
        workspaceId,
        databaseId: database.id,
        sampleLimit: 2,
        promptCandidateCount: 1,
        policyCandidateCount: 1,
      },
    });
    assert.equal(createRun.status, 200, '创建 GEPA run 应返回 200');
    const run = createRun.body?.run;
    assert.ok(run?.id, 'GEPA run 应包含 id');

    const templateCandidates = Array.isArray(run?.candidateSet)
      ? run.candidateSet.filter((candidate) => candidate?.source === 'template')
      : [];
    assert.ok(templateCandidates.length > 0, '高置信正反馈后应出现 template 候选');
    assert.ok(
      templateCandidates.some((candidate) => typeof candidate.title === 'string' && candidate.title.includes(marker)),
      'template 候选标题应可定位到本轮反馈标记'
    );

    const deleteRun = request(`/api/db-harness/gepa/runs/${run.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteRun.status, 200, '测试结束后应可删除 GEPA run');
  } finally {
    const deleteWorkspace = request(`/api/db-harness/workspaces/${workspaceId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteWorkspace.status, 200, '测试结束后应可删除临时 workspace');
  }
});

test('positive feedback from cache below threshold should not enter template candidates', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 DB Harness 接口应可访问');

  const databaseResponse = request('/api/database-instances');
  assert.equal(databaseResponse.status, 200, 'database 列表应返回 200');
  const databases = Array.isArray(databaseResponse.body) ? databaseResponse.body : [];
  const database = pickSupportedDatabase(databases);
  if (!database) {
    t.skip('当前环境没有可用于测试的 MySQL / PostgreSQL / Mongo 数据源');
    return;
  }

  const marker = `template-gate-block-${Date.now()}`;
  const workspaceCreate = request('/api/db-harness/workspaces', {
    method: 'POST',
    body: {
      name: `模板门槛拦截-${marker}`,
      databaseId: database.id,
      rules: '',
    },
  });
  assert.equal(workspaceCreate.status, 201, '创建测试 workspace 应返回 201');
  const workspaceId = workspaceCreate.body?.id;
  assert.ok(workspaceId, '创建测试 workspace 应返回 id');

  try {
    const degradedMetrics = Array.from({ length: 4 }).map((_, index) => ({
      turnId: `${marker}-metric-${index}`,
      workspaceId,
      databaseId: database.id,
      engine: database.type,
      question: `模板门槛拦截问题-${marker}-${index}`,
      queryFingerprint: `${marker}-fp-${index}`,
      outcome: 'error',
      confidence: 0.46,
      rowCount: 0,
      fromCache: false,
      labels: ['validation-fail', 'template-gate-block'],
    }));
    for (const metric of degradedMetrics) {
      const postMetric = request('/api/db-harness/metrics', {
        method: 'POST',
        body: metric,
      });
      assert.equal(postMetric.status, 200, '写入退化指标应返回 200');
    }

    const feedbackResponse = request('/api/db-harness/feedback', {
      method: 'POST',
      body: {
        workspaceId,
        messageId: `${marker}-message`,
        databaseInstanceId: database.id,
        question: `请按正确口径查询 ${marker}`,
        reply: '已返回测试结果',
        feedbackType: 'positive',
        confidence: 0.79,
        fromCache: true,
        note: marker,
      },
    });
    assert.equal(feedbackResponse.status, 200, '缓存场景低置信正反馈写入应返回 200');

    const createRun = request('/api/db-harness/gepa/runs', {
      method: 'POST',
      body: {
        workspaceId,
        databaseId: database.id,
        sampleLimit: 2,
        promptCandidateCount: 1,
        policyCandidateCount: 1,
      },
    });
    assert.equal(createRun.status, 200, '创建 GEPA run 应返回 200');
    const run = createRun.body?.run;
    assert.ok(run?.id, 'GEPA run 应包含 id');

    const templateCandidates = Array.isArray(run?.candidateSet)
      ? run.candidateSet.filter((candidate) => candidate?.source === 'template')
      : [];
    assert.ok(
      !templateCandidates.some((candidate) => typeof candidate.title === 'string' && candidate.title.includes(marker)),
      '低于缓存场景门槛的反馈不应进入 template 候选'
    );

    const deleteRun = request(`/api/db-harness/gepa/runs/${run.id}`, {
      method: 'DELETE',
    });
    assert.equal(deleteRun.status, 200, '测试结束后应可删除 GEPA run');
  } finally {
    const deleteWorkspace = request(`/api/db-harness/workspaces/${workspaceId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteWorkspace.status, 200, '测试结束后应可删除临时 workspace');
  }
});

test('deleting workspace should cascade-remove associated GEPA runs, metrics and templates', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 DB Harness 接口应可访问');

  const databaseResponse = request('/api/database-instances');
  assert.equal(databaseResponse.status, 200, 'database 列表应返回 200');
  const databases = Array.isArray(databaseResponse.body) ? databaseResponse.body : [];
  const database = pickSupportedDatabase(databases);
  if (!database) {
    t.skip('当前环境没有可用于测试的 MySQL / PostgreSQL / Mongo 数据源');
    return;
  }

  const marker = `workspace-cascade-${Date.now()}`;
  const workspaceCreate = request('/api/db-harness/workspaces', {
    method: 'POST',
    body: {
      name: `级联清理测试-${marker}`,
      databaseId: database.id,
      rules: '',
    },
  });
  assert.equal(workspaceCreate.status, 201, '创建测试 workspace 应返回 201');
  const workspaceId = workspaceCreate.body?.id;
  assert.ok(workspaceId, '创建测试 workspace 应返回 id');

  const seededMetrics = Array.from({ length: 4 }).map((_, index) => ({
    turnId: `${marker}-metric-${index}`,
    workspaceId,
    databaseId: database.id,
    engine: database.type,
    question: `级联清理模板信号问题-${marker}-${index}`,
    queryFingerprint: `${marker}-fp-${index}`,
    outcome: index % 2 === 0 ? 'error' : 'empty',
    confidence: 0.44,
    rowCount: 0,
    fromCache: false,
    labels: ['validation-fail', 'workspace-cascade'],
  }));
  for (const metric of seededMetrics) {
    const postMetric = request('/api/db-harness/metrics', {
      method: 'POST',
      body: metric,
    });
    assert.equal(postMetric.status, 200, '写入级联清理测试指标应返回 200');
  }

  const feedbackResponse = request('/api/db-harness/feedback', {
    method: 'POST',
    body: {
      workspaceId,
      messageId: `${marker}-feedback-message`,
      databaseInstanceId: database.id,
      question: `模板级联清理验证问题 ${marker}`,
      reply: '模板门槛通过，等待级联清理验证',
      feedbackType: 'positive',
      confidence: 0.9,
      fromCache: false,
      note: marker,
    },
  });
  assert.equal(feedbackResponse.status, 200, '写入高置信正反馈应返回 200');

  const createRun = request('/api/db-harness/gepa/runs', {
    method: 'POST',
    body: {
      workspaceId,
      databaseId: database.id,
      sampleLimit: 2,
      promptCandidateCount: 1,
      policyCandidateCount: 1,
    },
  });
  assert.equal(createRun.status, 200, '创建 GEPA run 应返回 200');
  const runId = createRun.body?.run?.id;
  assert.ok(runId, 'GEPA run 应返回 id');
  const runCandidateSet = Array.isArray(createRun.body?.run?.candidateSet)
    ? createRun.body.run.candidateSet
    : [];
  assert.ok(
    runCandidateSet.some((candidate) =>
      candidate?.source === 'template'
      && typeof candidate.title === 'string'
      && candidate.title.includes(marker)
    ),
    '删除前应存在带本轮标记的 template 候选'
  );

  const deleteWorkspace = request(`/api/db-harness/workspaces/${workspaceId}`, {
    method: 'DELETE',
  });
  assert.equal(deleteWorkspace.status, 200, '删除 workspace 应返回 200');

  const getDeletedRun = request(`/api/db-harness/gepa/runs/${runId}`);
  assert.equal(getDeletedRun.status, 404, '删除 workspace 后关联 GEPA run 应不可再查询');

  const metricsAfterDelete = request(
    `/api/db-harness/metrics?workspaceId=${encodeURIComponent(workspaceId)}&databaseId=${encodeURIComponent(database.id)}&limit=60`
  );
  assert.equal(metricsAfterDelete.status, 200, '删除后查询 metrics 应返回 200');
  const remainingMetrics = Array.isArray(metricsAfterDelete.body?.metrics) ? metricsAfterDelete.body.metrics : [];
  assert.ok(
    !remainingMetrics.some((metric) => typeof metric?.turnId === 'string' && metric.turnId.startsWith(`${marker}-metric-`)),
    '删除 workspace 后，不应再能查到该 workspace 的指标记录'
  );

  const recreateWorkspace = request('/api/db-harness/workspaces', {
    method: 'POST',
    body: {
      id: workspaceId,
      name: `级联清理复用ID-${marker}`,
      databaseId: database.id,
      rules: '',
    },
  });
  assert.equal(recreateWorkspace.status, 201, '删除后复用同一 workspaceId 重建应返回 201');
  try {
    const reseedMetrics = Array.from({ length: 4 }).map((_, index) => ({
      turnId: `${marker}-reseed-metric-${index}`,
      workspaceId,
      databaseId: database.id,
      engine: database.type,
      question: `重建后模板验证问题-${marker}-${index}`,
      queryFingerprint: `${marker}-reseed-fp-${index}`,
      outcome: 'error',
      confidence: 0.43,
      rowCount: 0,
      fromCache: false,
      labels: ['validation-fail', 'workspace-cascade-reseed'],
    }));
    for (const metric of reseedMetrics) {
      const postMetric = request('/api/db-harness/metrics', {
        method: 'POST',
        body: metric,
      });
      assert.equal(postMetric.status, 200, '重建后写入指标应返回 200');
    }

    const runAfterRecreate = request('/api/db-harness/gepa/runs', {
      method: 'POST',
      body: {
        workspaceId,
        databaseId: database.id,
        sampleLimit: 2,
        promptCandidateCount: 1,
        policyCandidateCount: 1,
      },
    });
    assert.equal(runAfterRecreate.status, 200, '重建后创建 GEPA run 应返回 200');
    const recreatedRunId = runAfterRecreate.body?.run?.id;
    assert.ok(recreatedRunId, '重建后 GEPA run 应返回 id');
    const recreatedCandidateSet = Array.isArray(runAfterRecreate.body?.run?.candidateSet)
      ? runAfterRecreate.body.run.candidateSet
      : [];
    assert.ok(
      !recreatedCandidateSet.some((candidate) =>
        candidate?.source === 'template'
        && typeof candidate.title === 'string'
        && candidate.title.includes(marker)
      ),
      '删除 workspace 后重建同 ID，不应继承旧 workspace 的模板候选'
    );
  } finally {
    const cleanupWorkspace = request(`/api/db-harness/workspaces/${workspaceId}`, {
      method: 'DELETE',
    });
    assert.equal(cleanupWorkspace.status, 200, '测试结束后应清理重建 workspace');
  }
});
