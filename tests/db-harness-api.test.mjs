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

function pickSchemaField(schema) {
  const collections = Array.isArray(schema?.collections) ? schema.collections : [];
  for (const collection of collections) {
    if (!collection || typeof collection !== 'object' || collection.category !== 'table') continue;
    const columns = Array.isArray(collection.columns) ? collection.columns : [];
    const firstColumn = columns.find((column) => column && typeof column === 'object' && typeof column.name === 'string');
    if (firstColumn?.name) {
      return {
        table: collection.name,
        column: firstColumn.name,
      };
    }
  }
  return null;
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
  const templateCandidatesBeforeDelete = runCandidateSet.filter((candidate) => candidate?.source === 'template');
  assert.ok(
    templateCandidatesBeforeDelete.length > 0,
    '删除前应存在 template 候选'
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
    const recreatedTemplateCandidates = recreatedCandidateSet.filter((candidate) => candidate?.source === 'template');
    assert.ok(
      recreatedTemplateCandidates.length === 0,
      '删除 workspace 后重建同 ID，不应继承旧 workspace 的模板候选'
    );
  } finally {
    const cleanupWorkspace = request(`/api/db-harness/workspaces/${workspaceId}`, {
      method: 'DELETE',
    });
    assert.equal(cleanupWorkspace.status, 200, '测试结束后应清理重建 workspace');
  }
});

test('workspace upgrades API supports extract/evaluate/reject flow', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];
  const workspace = workspaces.find((item) => item && typeof item === 'object' && item.databaseId);
  if (!workspace) {
    t.skip('当前环境没有可用于 workspace 升级测试的 workspace');
    return;
  }

  const extractResponse = request(`/api/db-harness/workspaces/${workspace.id}/upgrades/extract`, {
    method: 'POST',
    body: {},
  });
  assert.equal(extractResponse.status, 200, 'workspace 升级抽取应返回 200');
  const extracted = Array.isArray(extractResponse.body?.upgrades) ? extractResponse.body.upgrades : [];

  const listResponse = request(`/api/db-harness/workspaces/${workspace.id}/upgrades`);
  assert.equal(listResponse.status, 200, 'workspace 升级列表应返回 200');
  const upgrades = Array.isArray(listResponse.body?.upgrades) ? listResponse.body.upgrades : [];
  const targetUpgrade = extracted[0] || upgrades.find((item) => item?.status === 'pending_review' || item?.status === 'draft');
  if (!targetUpgrade?.id) {
    t.skip('当前样本不足，未生成可评估的 workspace 升级候选');
    return;
  }

  const evaluateResponse = request(`/api/db-harness/workspaces/${workspace.id}/upgrades/evaluate`, {
    method: 'POST',
    body: { upgradeId: targetUpgrade.id },
  });
  assert.equal(evaluateResponse.status, 200, 'workspace 升级评估应返回 200');
  assert.ok(
    typeof evaluateResponse.body?.upgrade?.evaluation?.score === 'number',
    'workspace 升级评估结果应包含 evaluation.score'
  );

  const rejectResponse = request(`/api/db-harness/workspaces/${workspace.id}/upgrades/${targetUpgrade.id}/reject`, {
    method: 'POST',
    body: { reason: 'test-reject' },
  });
  assert.equal(rejectResponse.status, 200, 'workspace 升级拒绝应返回 200');
  assert.equal(rejectResponse.body?.upgrade?.status, 'rejected', 'workspace 升级状态应变为 rejected');
});

test('semantic upgrades API validates required fields and supports extract/evaluate/reject flow', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];
  const workspace = workspaces.find((item) => item && typeof item === 'object' && item.databaseId);
  if (!workspace) {
    t.skip('当前环境没有可用于语义升级测试的 workspace');
    return;
  }

  const missingSource = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/extract`, {
    method: 'POST',
    body: {},
  });
  assert.equal(missingSource.status, 400, '语义升级抽取缺少 sourceWorkspaceId 应返回 400');

  const extractResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/extract`, {
    method: 'POST',
    body: {
      sourceWorkspaceId: workspace.id,
      limit: 2,
    },
  });
  assert.equal(extractResponse.status, 200, '语义升级抽取应返回 200');
  const extracted = Array.isArray(extractResponse.body?.upgrades) ? extractResponse.body.upgrades : [];

  const listResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades`);
  assert.equal(listResponse.status, 200, '语义升级列表应返回 200');
  const upgrades = Array.isArray(listResponse.body?.upgrades) ? listResponse.body.upgrades : [];
  const targetUpgrade = extracted[0] || upgrades.find((item) => item?.status === 'pending_review' || item?.status === 'draft');
  if (!targetUpgrade?.id) {
    t.skip('当前样本不足，未生成可评估的语义升级候选');
    return;
  }

  const evaluateResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/evaluate`, {
    method: 'POST',
    body: { upgradeId: targetUpgrade.id },
  });
  assert.equal(evaluateResponse.status, 200, '语义升级评估应返回 200');
  assert.ok(
    typeof evaluateResponse.body?.upgrade?.evaluation?.score === 'number',
    '语义升级评估应包含 evaluation.score'
  );

  const rejectResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/${targetUpgrade.id}/reject`, {
    method: 'POST',
    body: { reason: 'test-reject' },
  });
  assert.equal(rejectResponse.status, 200, '语义升级拒绝应返回 200');
  assert.equal(rejectResponse.body?.upgrade?.status, 'rejected', '语义升级状态应变为 rejected');
});

test('semantic upgrades list API should include governance metadata', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];
  const workspace = workspaces.find((item) => item && typeof item === 'object' && item.databaseId);
  if (!workspace) {
    t.skip('当前环境没有可用于语义治理测试的 workspace');
    return;
  }

  const extractResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/extract`, {
    method: 'POST',
    body: {
      sourceWorkspaceId: workspace.id,
      limit: 2,
    },
  });
  assert.equal(extractResponse.status, 200, '语义升级抽取应返回 200');

  const listResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades`);
  assert.equal(listResponse.status, 200, '语义升级列表应返回 200');
  assert.ok(Array.isArray(listResponse.body?.upgrades), '语义升级列表应包含 upgrades 数组');
  assert.ok(Array.isArray(listResponse.body?.governance), '语义升级列表应包含 governance 数组');

  const upgrades = listResponse.body?.upgrades || [];
  const governance = listResponse.body?.governance || [];
  assert.equal(governance.length, upgrades.length, 'governance 数量应与 upgrades 数量保持一致');

  const first = governance[0];
  if (first) {
    assert.ok(typeof first.upgradeId === 'string' && first.upgradeId, 'governance.upgradeId 应为字符串');
    assert.ok(first.impact && typeof first.impact === 'object', 'governance.impact 应存在');
    assert.ok(Array.isArray(first.impact.impactedEntities), 'governance.impact.impactedEntities 应为数组');
    assert.ok(Array.isArray(first.impact.impactedFieldRefs), 'governance.impact.impactedFieldRefs 应为数组');
    assert.ok(Array.isArray(first.impact.impactedWorkspaceIds), 'governance.impact.impactedWorkspaceIds 应为数组');
    assert.ok(Array.isArray(first.impact.rolloutWorkspaceIds), 'governance.impact.rolloutWorkspaceIds 应为数组');
    assert.ok(Array.isArray(first.rolloutTimeline), 'governance.rolloutTimeline 应为数组');
  }
});

test('workspace upgrades API supports apply flow and updates workspace runtime config', (t) => {
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
    t.skip('当前环境没有可用于 workspace 升级应用测试的数据源');
    return;
  }

  const marker = `workspace-upgrade-apply-${Date.now()}`;
  const workspaceCreate = request('/api/db-harness/workspaces', {
    method: 'POST',
    body: {
      name: `升级应用测试-${marker}`,
      databaseId: database.id,
      rules: '',
    },
  });
  assert.equal(workspaceCreate.status, 201, '创建测试 workspace 应返回 201');
  const workspaceId = workspaceCreate.body?.id;
  assert.ok(workspaceId, '创建测试 workspace 应返回 id');

  try {
    const seedMetric = request('/api/db-harness/metrics', {
      method: 'POST',
      body: {
        turnId: `${marker}-metric`,
        workspaceId,
        databaseId: database.id,
        engine: database.type,
        question: `触发 workspace 升级候选 ${marker}`,
        queryFingerprint: `${marker}-fp`,
        outcome: 'error',
        confidence: 0.42,
        rowCount: 0,
        fromCache: false,
        labels: ['validation-fail', marker],
      },
    });
    assert.equal(seedMetric.status, 200, '写入触发升级候选的指标应返回 200');

    const extractResponse = request(`/api/db-harness/workspaces/${workspaceId}/upgrades/extract`, {
      method: 'POST',
      body: {},
    });
    assert.equal(extractResponse.status, 200, 'workspace 升级抽取应返回 200');
    const extracted = Array.isArray(extractResponse.body?.upgrades) ? extractResponse.body.upgrades : [];
    const promptUpgrade = extracted.find((item) => item?.artifactType === 'prompt_patch') || extracted[0];
    if (!promptUpgrade?.id) {
      t.skip('当前样本不足，未生成可应用的 workspace 升级候选');
      return;
    }

    const applyResponse = request(`/api/db-harness/workspaces/${workspaceId}/upgrades/${promptUpgrade.id}/apply`, {
      method: 'POST',
      body: {},
    });
    assert.equal(applyResponse.status, 200, 'workspace 升级应用应返回 200');
    assert.equal(applyResponse.body?.upgrade?.status, 'applied', 'workspace 升级应用后状态应为 applied');

    const listWorkspaces = request('/api/db-harness/workspaces');
    assert.equal(listWorkspaces.status, 200, 'workspace 列表应返回 200');
    const workspaces = Array.isArray(listWorkspaces.body) ? listWorkspaces.body : [];
    const currentWorkspace = workspaces.find((item) => item?.id === workspaceId);
    assert.ok(currentWorkspace, '应能查到测试 workspace');
    const promptStrategy = currentWorkspace?.runtimeConfig?.promptStrategy || '';
    const expectedPatch = (applyResponse.body?.upgrade?.artifact?.promptPatch || '').trim();
    if (expectedPatch) {
      assert.ok(promptStrategy.includes(expectedPatch), '应用后的 runtimeConfig.promptStrategy 应包含升级补丁内容');
    }
  } finally {
    const deleteWorkspace = request(`/api/db-harness/workspaces/${workspaceId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteWorkspace.status, 200, '测试结束后应删除临时 workspace');
  }
});

test('semantic upgrades API supports rollout and finalize flow', (t) => {
  if (!isServerReachable()) {
    t.skip(`本地服务不可达：${BASE_URL}`);
    return;
  }
  const session = ensureSession();
  assert.equal(session.status, 200, '会话握手后 DB Harness 接口应可访问');

  const workspaceResponse = request('/api/db-harness/workspaces');
  assert.equal(workspaceResponse.status, 200, 'workspace 列表应返回 200');
  const workspaces = Array.isArray(workspaceResponse.body) ? workspaceResponse.body : [];
  const workspace = workspaces.find((item) => item && typeof item === 'object' && item.databaseId);
  if (!workspace) {
    t.skip('当前环境没有可用于语义升级灰度测试的 workspace');
    return;
  }

  const schemaResponse = request(`/api/database-instances/${workspace.databaseId}/schema`);
  assert.equal(schemaResponse.status, 200, '读取 schema 应返回 200');
  const field = pickSchemaField(schemaResponse.body);
  if (!field) {
    t.skip('当前数据源 schema 不含可用于语义升级测试的字段');
    return;
  }

  const semanticModelBefore = request(`/api/database-instances/${workspace.databaseId}/semantic-model`);
  assert.equal(semanticModelBefore.status, 200, '读取语义模型应返回 200');
  const originalSemanticModel = semanticModelBefore.body;
  const beforeSemanticUpdatedAt = typeof originalSemanticModel?.updatedAt === 'string'
    ? originalSemanticModel.updatedAt
    : '';

  const aliasMarker = `语义别名回归-${Date.now()}`;
  try {
    const feedbackResponse = request('/api/db-harness/feedback', {
      method: 'POST',
      body: {
        workspaceId: workspace.id,
        messageId: `semantic-rollout-${Date.now()}`,
        databaseInstanceId: workspace.databaseId,
        question: `语义升级灰度测试 ${field.table}.${field.column}`,
        reply: '记录纠错反馈用于抽取语义候选',
        feedbackType: 'corrective',
        note: aliasMarker,
        artifacts: {
          queryPlan: {
            intent: 'aggregate',
            strategy: 'semantic-upgrade-test',
            targetTable: field.table,
            summary: `纠错到 ${field.table}.${field.column}`,
            metrics: [
              {
                label: `${field.table}.${field.column}`,
                table: field.table,
                column: field.column,
              },
            ],
            dimensions: [],
            filters: [],
            orderBy: [],
            limit: 20,
            notes: [],
            compiled: {
              text: '{}',
              values: [],
              previewSql: '{}',
            },
          },
        },
      },
    });
    assert.equal(feedbackResponse.status, 200, '写入纠错反馈应返回 200');

    const extractResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/extract`, {
      method: 'POST',
      body: {
        sourceWorkspaceId: workspace.id,
        limit: 24,
      },
    });
    assert.equal(extractResponse.status, 200, '语义升级抽取应返回 200');
    const extracted = Array.isArray(extractResponse.body?.upgrades) ? extractResponse.body.upgrades : [];
    const targetUpgrade = extracted.find((item) =>
      Array.isArray(item?.diffs)
      && item.diffs.some((diff) =>
        diff?.fieldRef?.table === field.table
        && diff?.fieldRef?.column === field.column
        && diff?.after === aliasMarker
      )
    );
    if (!targetUpgrade?.id) {
      t.skip('当前样本不足，未生成命中测试字段的语义升级候选');
      return;
    }

    const evaluateResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/evaluate`, {
      method: 'POST',
      body: { upgradeId: targetUpgrade.id },
    });
    assert.equal(evaluateResponse.status, 200, '语义升级评估应返回 200');
    assert.ok(
      typeof evaluateResponse.body?.upgrade?.evaluation?.score === 'number',
      '语义升级评估应包含 evaluation.score'
    );

    const rolloutResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/${targetUpgrade.id}/start-rollout`, {
      method: 'POST',
      body: { workspaceIds: [workspace.id] },
    });
    assert.equal(rolloutResponse.status, 200, '语义升级灰度应返回 200');
    assert.equal(rolloutResponse.body?.upgrade?.status, 'rollout', '语义升级进入灰度后状态应为 rollout');
    assert.ok(
      Array.isArray(rolloutResponse.body?.rollouts) && rolloutResponse.body.rollouts.some((item) => item?.workspaceId === workspace.id),
      '灰度记录应包含指定 workspace'
    );

    const finalizeResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-upgrades/${targetUpgrade.id}/finalize`, {
      method: 'POST',
      body: {},
    });
    assert.equal(finalizeResponse.status, 200, '语义升级 finalize 应返回 200');
    assert.equal(finalizeResponse.body?.upgrade?.status, 'finalized', '语义升级 finalize 后状态应为 finalized');
    assert.equal(finalizeResponse.body?.databaseUpdated, true, '语义升级 finalize 后应写入正式语义配置');

    const semanticModelAfter = request(`/api/database-instances/${workspace.databaseId}/semantic-model`);
    assert.equal(semanticModelAfter.status, 200, 'finalize 后读取语义模型应返回 200');
    assert.equal(semanticModelAfter.body?.source, 'manual', 'finalize 后语义模型 source 应为 manual');
    const afterUpdatedAt = typeof semanticModelAfter.body?.updatedAt === 'string'
      ? semanticModelAfter.body.updatedAt
      : '';
    if (beforeSemanticUpdatedAt && afterUpdatedAt) {
      assert.notEqual(afterUpdatedAt, beforeSemanticUpdatedAt, 'finalize 后语义模型 updatedAt 应更新');
    }
  } finally {
    if (originalSemanticModel && typeof originalSemanticModel === 'object') {
      const restoreResponse = request(`/api/database-instances/${workspace.databaseId}/semantic-model`, {
        method: 'PUT',
        body: { semanticModel: originalSemanticModel },
      });
      assert.equal(restoreResponse.status, 200, '测试结束后应恢复原语义模型');
    }
  }
});
