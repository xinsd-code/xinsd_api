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

  createdAt: string;
  updatedAt: string;
}

export type CreateApiForwardConfig = Omit<ApiForwardConfig, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateApiForwardConfig = Partial<CreateApiForwardConfig>;
