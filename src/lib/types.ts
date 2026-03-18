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

export interface CustomParamDef {
  key: string;
  type: 'string' | 'integer' | 'boolean' | 'number' | 'array';
  description?: string;
  defaultValue?: string;
}

export interface ParamBinding {
  targetParamKey: string;     // The param key expected by the underlying API
  customParamKey?: string;    // The param key defined by the forward's customParams
  staticValue?: string;       // Or a static value if mapped statically instead of passing from custom param
}

export interface ApiForwardConfig {
  id: string;
  name: string;
  apiGroup?: string;
  description: string;
  method: string;             // GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD
  path: string;               // Virtual exposed endpoint, e.g. /forward/submit-order
  
  customParams: CustomParamDef[];

  targetType: 'mock' | 'api-client';
  targetId: string;
  
  paramBindings: ParamBinding[];  // Map how customParams/static values bind to target endpoint params

  orchestration?: OrchestrationConfig;  // Advanced response orchestration

  createdAt: string;
  updatedAt: string;
}

export type CreateApiForwardConfig = Omit<ApiForwardConfig, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateApiForwardConfig = Partial<CreateApiForwardConfig>;

export type AIModelAuthType = 'none' | 'bearer' | 'custom-header';

export interface AIModelProfile {
  id: string;
  name: string;
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

export interface AIModelSelection {
  profileId: string;
  profileName: string;
  baseUrl: string;
  authType: AIModelAuthType;
  authToken?: string;
  authHeaderName?: string;
  modelId: string;
  isDefault?: boolean;
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
