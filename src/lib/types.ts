export interface KeyValuePair {
  key: string;
  value: string;
  type?: 'string' | 'integer' | 'boolean' | 'number' | 'array';
}

export interface StreamConfig {
  chunkDelay: number;   // ms between chunks
  chunks: string[];     // data chunks to send
}

export interface MockAPI {
  id: string;
  name: string;
  path: string;           // e.g. /users/:id
  method: string;         // GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD
  description: string;
  enabled: boolean;
  requestHeaders: KeyValuePair[];
  requestParams: KeyValuePair[];
  requestBody?: string;    // Optional JSON body matcher for mock request matching
  responseStatus: number;
  responseHeaders: KeyValuePair[];
  responseBody: string;   // JSON string
  responseDelay: number;  // ms
  isStream: boolean;
  streamConfig: StreamConfig;
  apiGroup?: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateMockAPI = Omit<MockAPI, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateMockAPI = Partial<CreateMockAPI>;

/** 列表接口轻量类型（不含大字段） */
export interface MockAPISummary {
  id: string;
  name: string;
  path: string;
  method: string;
  description: string;
  enabled: boolean;
  isStream: boolean;
  responseDelay: number;
  apiGroup?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiClientConfig {
  id: string;
  name: string;
  url: string;            // The full URL
  method: string;         // GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD
  description: string;
  requestHeaders: KeyValuePair[];
  requestParams: KeyValuePair[];
  requestBody: string;    // JSON string or other raw text
  apiGroup?: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateApiClientConfig = Omit<ApiClientConfig, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateApiClientConfig = Partial<CreateApiClientConfig>;

/** 列表接口轻量类型（不含大字段） */
export interface ApiClientSummary {
  id: string;
  name: string;
  url: string;
  method: string;
  description: string;
  apiGroup?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomParamDef {
  key: string;
  type: 'string' | 'integer' | 'boolean' | 'number' | 'array';
  description?: string;
  defaultValue?: string;
}

export interface ParamBinding {
  targetParamKey: string;     // The param key expected by the underlying API
  targetLocation?: 'query' | 'body' | 'path' | 'header';
  customParamKey?: string;    // The param key defined by the forward's customParams
  staticValue?: string;       // Or a static value if mapped statically instead of passing from custom param
}

export interface ForwardTargetParamOption {
  key: string;
  value: unknown;
  location: 'query' | 'body';
  valueType: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
}

export interface RedisCacheConfig {
  enabled: boolean;
  instanceId?: string;
  keyRule?: string;
  expireSeconds?: number;
}

export type ApiForwardTargetType = 'mock' | 'api-client' | 'db-api';

export interface ApiForwardConfig {
  id: string;
  name: string;
  apiGroup?: string;
  description: string;
  method: string;             // GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD
  path: string;               // Virtual exposed endpoint, e.g. /forward/submit-order

  customParams: CustomParamDef[];

  targetType: ApiForwardTargetType;
  targetId: string;

  paramBindings: ParamBinding[];  // Map how customParams/static values bind to target endpoint params

  orchestration?: OrchestrationConfig;  // Advanced response orchestration
  redisConfig?: RedisCacheConfig;

  createdAt: string;
  updatedAt: string;
}

export type CreateApiForwardConfig = Omit<ApiForwardConfig, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateApiForwardConfig = Partial<CreateApiForwardConfig>;

/** 列表接口轻量类型（不含大字段） */
export interface ApiForwardSummary {
  id: string;
  name: string;
  method: string;
  path: string;
  apiGroup?: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type AIModelAuthType = 'none' | 'bearer' | 'custom-header';
export type AIModelType = 'chat' | 'embedding';

export interface AIModelProfile {
  id: string;
  name: string;
  modelType: AIModelType;
  baseUrl: string;
  authType: AIModelAuthType;
  authToken?: string;
  authHeaderName?: string;
  modelIds: string[];
  defaultModelId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CreateAIModelProfile = Omit<AIModelProfile, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateAIModelProfile = Partial<CreateAIModelProfile>;

export type AIModelProfileSummary = Omit<AIModelProfile, 'authToken' | 'authHeaderName'>;

export interface AIModelSelection {
  profileId: string;
  profileName: string;
  modelType: AIModelType;
  baseUrl: string;
  authType: AIModelAuthType;
  authToken?: string;
  authHeaderName?: string;
  modelId: string;
  isDefault?: boolean;
}

export type DatabaseInstanceType = 'mysql' | 'pgsql' | 'redis' | 'mongo';

export type DatabaseSemanticRole = 'metric' | 'dimension' | 'time' | 'identifier' | 'attribute';
export type DatabaseSemanticFieldSource = 'mapping' | 'schema' | 'manual';

export interface DatabaseSemanticModelField {
  table: string;
  column: string;
  metricName: string;
  description?: string;
  metricType?: string;
  calcMode?: string;
  enableForNer: boolean;
  aliases: string[];
  semanticRole: DatabaseSemanticRole;
  derivedFrom: DatabaseSemanticFieldSource;
}

export interface DatabaseSemanticModelEntity {
  table: string;
  description?: string;
  metrics: string[];
  dimensions: string[];
  timeFields: string[];
  identifierFields: string[];
  nerEnabledFields: string[];
  fields: DatabaseSemanticModelField[];
}

export interface DatabaseSemanticModel {
  entityCount: number;
  configuredFieldCount: number;
  inferredFieldCount: number;
  glossary: string[];
  entities: DatabaseSemanticModelEntity[];
  source?: 'generated' | 'manual';
  updatedAt?: string;
}

export interface DatabaseInstance {
  id: string;
  name: string;
  type: DatabaseInstanceType;
  connectionUri: string;
  username?: string;
  password?: string;
  ownerId?: string;
  workspaceId?: string;
  metricMappings?: DatabaseMetricMappings;
  semanticModel?: DatabaseSemanticModel;
  createdAt: string;
  updatedAt: string;
}

export type DatabaseInstanceSummary = Omit<DatabaseInstance, 'username' | 'password'>;

export type CreateDatabaseInstance = Omit<DatabaseInstance, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateDatabaseInstance = Partial<CreateDatabaseInstance>;

export interface DatabaseCollectionInfo {
  name: string;
  category: 'table' | 'key';
  detail?: string;
  columns?: Array<{
    name: string;
    type: string;
    nullable?: boolean;
    defaultValue?: string | null;
    isPrimary?: boolean;
    extra?: string;
    comment?: string;
    referencesTable?: string;
    referencesColumn?: string;
  }>;
}

export interface DatabaseSchemaPayload {
  engine: DatabaseInstanceType;
  collections: DatabaseCollectionInfo[];
}

export interface DatabasePreviewPayload {
  engine: DatabaseInstanceType;
  name: string;
  category: 'table' | 'key';
  columns: string[];
  rows: Record<string, unknown>[];
  summary?: string;
}

export interface DatabaseQueryPayload {
  engine: DatabaseInstanceType;
  columns: string[];
  rows: Record<string, unknown>[];
  summary?: string;
}

// --- Orchestration Types ---

export interface FilterNodeConfig {
  mode: 'include' | 'exclude';
  fields: string[];
}

export interface MapNodeConfig {
  mappings: { from: string; to: string }[];
}

export interface ComputeNodeConfig {
  computations: {
    field: string;           // New field name
    expression: string;      // Expression like "fieldA + fieldB", "fieldA * 2", or a static value
    sourceField?: string;    // Optional: copy from existing field
  }[];
}

export interface SortNodeConfig {
  arrayPath: string;         // JSONPath to the array, e.g. "data.items" or "" for root
  sortField: string;         // Field to sort by
  order: 'asc' | 'desc';
  limit?: number;            // Optional limit on the number of results
}

export type OrchestrationNodeType = 'filter' | 'map' | 'compute' | 'sort';

export interface OrchestrationNode {
  id: string;
  type: OrchestrationNodeType;
  label?: string;            // Optional custom label
  config: FilterNodeConfig | MapNodeConfig | ComputeNodeConfig | SortNodeConfig;
  order: number;
}

export interface OrchestrationConfig {
  nodes: OrchestrationNode[];
}

export interface DatabaseFieldMetricMapping {
  metricName?: string;
  description?: string;
  metricType?: string;
  calcMode?: string;
  enableForNer?: boolean;
  aliases?: string[];
}

export interface DatabaseTableMetricMapping {
  description?: string;
  fields: Record<string, DatabaseFieldMetricMapping>;
}

export type DatabaseMetricMappings = Record<string, DatabaseTableMetricMapping>;

export interface SqlVariableBinding {
  variableKey: string;
  customParamKey?: string;
  staticValue?: string;
}

export interface DbApiConfig {
  id: string;
  name: string;
  apiGroup?: string;
  description: string;
  method: string;
  path: string;
  customParams: CustomParamDef[];
  databaseInstanceId: string;
  sqlTemplate: string;
  paramBindings: SqlVariableBinding[];
  redisConfig?: RedisCacheConfig;
  createdAt: string;
  updatedAt: string;
}

export type CreateDbApiConfig = Omit<DbApiConfig, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateDbApiConfig = Partial<CreateDbApiConfig>;

export interface DbApiSummary {
  id: string;
  name: string;
  method: string;
  path: string;
  apiGroup?: string;
  description: string;
  databaseInstanceId: string;
  createdAt: string;
  updatedAt: string;
}
