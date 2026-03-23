# API Forge - API 接口管理与研发辅助平台

API Forge 是一款专为开发者打造的全栈式 API 研发辅助平台。它不仅提供了强大的 **Mock API** 能力，还集成了类似 Postman 的 **API 接入 (Client)** 功能，以及极具特色的 **API 转发 (Forwarding)** 与**参数绑定**逻辑，旨在解决前后端并行开发中的联调痛点。

![Aesthetics](https://img.shields.io/badge/Aesthetics-Premium-blueviolet)
![Next.js](https://img.shields.io/badge/Next.js-15+-black)
![React](https://img.shields.io/badge/React-19-blue)
![SQLite](https://img.shields.io/badge/Database-SQLite-003B57)

## 🌟 核心特性

- **🚀 Mock API 管理**
  - 支持 RESTful 接口全量配置：Method, Path, Headers, Query, Body。
  - 支持**流式响应 (Streaming)**，模拟大文件或实时数据传输。
  - 智能匹配算法，精准识别动态路径参数 (`/api/user/:id`)。
  
- **🛠 API 接入 (API Client)**
  - **配置模式 (Design)**：定义接口结构、参数类型。
  - **调试模式 (Run)**：基于配置自动生成表单，快速进行 proxy 请求。
  - 内置代理服务，彻底解决浏览器跨域 (CORS) 困扰。

- **🔄 API 转发与参数映射 (Forwarding)**
  - 允许建立“虚拟路径”并将其映射至已有的 Mock 或真实接口。
  - **参数绑定**：支持将虚拟接口的自定义入参映射到目标接口的指定字段。
  - **Redis 结果缓存**：默认关闭；开启后需选择已接入的 Redis 数据源，并配置缓存 Key 规则与过期时间。
  - 缓存 Key 按 `接口ID:输入规则` 拼接，规则支持 `{{param}}`、`{{user.id}}`、`{{$.user.id}}`、`{{items[0].sku}}` 等从接口入参中取值。
  - 适用于构建统一网关入口或适配已有接口体系。

- **🧠 高级编排工作流（测试转发）**
  - 在 API 转发配置页新增“高级编排”工作流编辑器，支持 `数据筛选 / 字段映射 / 字段新增 / 排序限制` 节点串联。
  - 支持节点拖拽排序、单节点调试、整条编排试运行，并在页面内实时预览工作流配置 JSON。
  - 字段新增支持模板表达式：`{{字段}}`、`{{入参key}}`、`{{$param.key}}`（如 `{{bbb}} * 0.1`）。
  - 针对对象数组（如 `data[]`）支持父子层级树展示与选择，父节点勾选自动联动子节点，部分勾选显示中间态。
  - 字段映射支持数组项属性重命名（如 `data[].age -> userAge`），直接改写数组对象字段，不会额外生成冗余数组。
  - 编排输入支持填写真实 API 入参并触发实际转发调用，基于真实返回数据继续后续编排。
  - 工作流支持一键保存，配置持久化到 API 转发表（`orchestration` 字段）。

- **🤖 AI Chat 编排助手**
  - 在“高级编排工作流”的“添加处理节点”栏最右侧新增 `AI Chat` 入口，可通过自然语言直接生成或修改工作流。
  - AI 会自动结合当前编排 scheme、节点格式、参数定义、参数绑定、接口 output 与体检问题生成最终配置。
  - 支持流式输出、自动应用到画布、改动摘要展示，以及“只修复体检报错”专项模式。
  - Prompt 已抽离到独立文件 `src/prompts/orchestration-ai-chat.md`，后端在调用时动态读取并注入上下文，便于后续单独维护和迭代。

- **🧩 模型管理（OpenAI Compatible）**
  - 左侧导航新增“模型管理”页，可集中维护 AI Chat 使用的模型来源。
  - 支持配置模型名称、`Base URL`、鉴权方式（无鉴权 / Bearer Token / 自定义 Header）、多个 `Model ID` 与默认 `Model ID`。
  - 新增 `Model ID` 时会立即发起真实可用性校验，校验失败不会加入列表；保存时不再要求额外做一次前置连接测试。
  - AI Chat 会自动读取默认模型来源；若配置了多个模型，也支持在对话页内临时切换。

- **🗄 数据库实例管理**
  - 左侧导航新增“数据库实例”页，统一管理 `MySQL / PostgreSQL / Redis` 实例。
  - 新增或编辑实例时，必须先通过真实连接验证后才能保存。
  - 支持进入实例详情页浏览结构对象，并在页面内执行只读 SQL / Redis 查询。
  - 详情页已按引擎区分展示：`MySQL / PostgreSQL` 保留结构浏览与表结构属性；`Redis` 仅保留只读查询控制台，不再展示结构浏览模块。

- **📦 环境变量与分组**
  - 支持接口按分组管理。
  - 分组级别**环境变量**支持 (`{{VAR}}`)，在 URL、Headers、Body 中自动替换。

- **🎨 极致视觉体验**
  - 全站升级为 Studio 风格 Light Theme，采用 Plus Jakarta Sans + JetBrains Mono 字体体系。
  - 统一图标系统、反馈 Toast、标签、按钮和卡片设计语言，提升整体一致性。
  - Mock / API Client / API Forward 三大工作台拥有一致的导航结构与更清晰的结果面板。

## ✨ 本次更新亮点

- **数据库实例管理与详情页修复**
  - 新增数据库实例管理工作台，支持 MySQL / PostgreSQL / Redis 的连接配置、验证、保存与详情查看。
  - 连接信息支持脱敏显示，编辑页支持密码显隐切换。
  - 详情页已按引擎进一步收敛：MySQL / PostgreSQL 保留“结构浏览 + 表结构属性 + 查询控制台”，Redis 仅保留只读查询控制台，移除结构浏览模块。
  - 修复了查询控制台在空结果场景下的字段展示问题，SQL 空结果也会正确显示列头。
  - 修复了 PostgreSQL 结构读取逻辑，现支持读取非系统 schema 的真实表，并正确识别主键字段。
  - 修复了“第一次连接数据源成功、第二次进入详情读取结构失败”的问题；本地开发脚本已调整为 `next dev`，降低热更新导致的接口抖动。

- **API 转发 Redis 缓存上线**
  - API 转发编辑页新增 Redis 缓存配置区，默认关闭；无 Redis 数据源时禁止开启，并在页内直接提示先完成接入。
  - 开启后可选择 Redis 数据源、填写缓存 Key 规则、设置过期时间，并在编辑页实时预览最终 Key 前缀。
  - 调试执行链路已接入真实 Redis 写入，执行结果会在 `_meta.cache` 中返回本次写入的 Key、过期时间与成功状态。
  - 修复了 Redis 缓存写入失败问题，并补齐 `{{param}}` / JSONPath 风格入参解析。

- **模型管理与 AI Chat 模型切换上线**
  - AI Chat 已从“启动时写死 DeepSeek Key / Model”升级为“页面可配置 OpenAI Compatible 模型”。
  - 左侧菜单底部新增“模型管理”，默认先展示总览；可从右上角 `+` 新建模型来源，也可点左侧卡片进入编辑。
  - 新增模型时，`Model ID` 会在添加时立即校验可用性，通过后才加入列表；模型保存仅保留结构校验，不再重复做保存前连接测试。
  - 模型卡片信息层级已优化为左上对齐，模型名称与 `Base URL` 更易于快速浏览和比对。

- **AI 编排助手与 Prompt 独立管理**
  - 高级编排工作区新增 `AI Chat` 对话页，支持流式生成工作流配置、自动落画布、输出改动摘要。
  - 支持“只修复体检报错”模式，AI 会优先针对页面当前 error 问题进行最小改动修复。
  - AI Prompt 已从路由逻辑中抽离为独立模板文件 `src/prompts/orchestration-ai-chat.md`，通过占位符注入模式说明与动态上下文，后续可单独维护。

- **编排规则与体检系统增强**
  - `compute` 节点新增数组项字段写入支持，例如 `userlist[].sex` 可逐项生效。
  - `sort` 节点统一标准写法，明确拆分为 `arrayPath + sortField`，保存前自动规范化歧义路径。
  - 工作区顶部新增体检问题提示，支持点击问题直接定位对应节点。
  - AI Chat 生成配置后也会先经过同一套规范化与体检流程，再渲染到工作流画布中。

- **字段映射父子联动体验升级**
  - `map` 节点支持父级字段改名后，后续子级映射规则自动跟随新的路径空间。
  - 若先将 `datas -> userlist`，后续子级规则会优先基于 `userlist[].*` 继续配置，避免旧路径空间与新路径空间混用。
  - 调整父级目标字段后，后续子级规则可联动更新，减少手工同步成本。

- **Studio 级界面重构**
  - 重做全局 Header、Sidebar 与页面容器，统一色彩变量、圆角、阴影、动效和滚动条样式。
  - 新增 `src/components/Icons.tsx` 作为统一 SVG 图标入口，替换原先分散的 Emoji 图标。
  - 整体视觉从“工具页”升级为“工作台”，更适合日常联调与演示场景。

- **Mock 接口管理台升级**
  - 新增统计卡片、方法筛选、分组筛选、搜索栏与更清晰的空状态/加载态。
  - 列表项强化标签展示，支持更直观地识别分组、RESTful 路径、流式响应与延迟配置。
  - Mock 编辑弹窗补充字段校验与更清晰的分栏配置体验。

- **API 接入工作台升级**
  - 重构为“接口收藏夹 + 编辑/运行双模式 + 响应结果面板”的工作区布局。
  - 优化分组折叠、环境变量入口、运行参数填写区与响应状态展示。
  - 保存、创建、删除、请求执行等操作统一为页内反馈，不再依赖粗糙提示方式。

- **API 转发与编排体验升级**
  - API Forward 页面采用与 Client 一致的工作台布局，新增更清晰的目标接口绑定与参数映射样式。
  - 运行调试面板与执行结果面板重做，方便直接验证转发链路。
  - 高级编排工作区补充统一图标、状态标签、底部数据预览 Tab 与更明确的节点编辑操作。

- **基础编辑器与弹窗组件统一**
  - `JsonEditor` 新增 JSON 有效性提示、格式化/压缩入口与更稳定的编辑容器。
  - `KeyValueEditor`、`ApiParamEditor`、`GroupVarsModal` 等组件同步完成视觉与交互统一。

## 🖥 功能演示区

### 1. Mock 接口工作台
- 适合快速创建本地联调接口、模拟 RESTful 路径、配置延迟与流式响应。
- 首页提供统计卡片、方法筛选、分组筛选、搜索与批量浏览能力。
- 进入编辑器后可分别配置基本信息、请求参数、响应数据与流式分片。

### 2. API 接入工作台
- 适合接入第三方 API、保存常用请求配置，并在页内直接运行调试。
- 左侧为接口收藏夹与分组入口，右侧为配置设计 / 运行调试双模式工作区。
- 响应面板会展示状态码、耗时与完整响应内容，适合接口验证与问题定位。

### 3. API 转发与编排工作台
- 适合搭建统一虚拟接口层，把入参映射到真实接口或 Mock 接口。
- 支持自定义入参定义、目标接口绑定、参数映射、固定值注入与结果回放。
- 支持按转发接口配置 Redis 结果缓存，并根据接口入参动态拼接缓存 Key。
- 高级编排支持筛选、字段映射、字段新增、排序限制，并可在工作区实时预览执行结果。
- AI Chat 支持直接通过自然语言生成/修改编排，并可专项修复页面体检报错。

### 4. 模型管理工作台
- 适合统一维护 AI Chat 所依赖的 OpenAI Compatible 模型来源。
- 支持多来源、多 `Model ID`、默认模型切换，以及 Bearer / 自定义 Header 鉴权方式。
- 新增 `Model ID` 时会立即做可用性校验，确保真正能被 AI Chat 调用。

### 5. 推荐演示路径
```text
Mock 接口定义 -> API 接入调试 -> API 转发绑定 -> 高级编排处理 -> 模型管理配置默认模型 -> AI Chat 自然语言改编排 -> 数据库实例查询验证 -> 输出最终响应
```

### 6. 适合在 README 中补充的截图位置
- 首页 Mock 接口总览页
- API Client 的运行调试界面
- API Forward 的参数映射面板
- 高级编排工作流画布与底部输出预览区
- 模型管理总览页 / 模型来源编辑页

## 📸 截图素材清单

如果你准备把项目作为作品集或 GitHub 展示页，建议优先补这几张图：

| 截图名称 | 建议页面 | 建议展示内容 |
| --- | --- | --- |
| `mock-dashboard.png` | Mock 首页 | 统计卡片、搜索筛选、接口列表标签 |
| `mock-editor.png` | Mock 编辑弹窗 | 基本信息 + 请求配置 + 响应配置 |
| `api-client-runner.png` | API Client | 左侧收藏夹、顶部请求栏、右侧响应结果 |
| `api-forward-binding.png` | API Forward | 自定义入参、目标接口绑定、参数映射 |
| `orchestration-workspace.png` | 高级编排工作区 | 节点画布、右侧节点配置、底部数据预览 |
| `orchestration-output.png` | 编排调试结果 | 输入数据 / 配置 JSON / 输出结果的联动展示 |
| `model-management-overview.png` | 模型管理 | 总览卡片、默认模型、模型来源列表 |
| `model-management-editor.png` | 模型管理编辑页 | Base URL、鉴权、Model ID 校验与默认模型配置 |
| `database-instances-overview.png` | 数据库实例 | 实例列表、统计卡片、空态 / 总览 |
| `database-instance-detail.png` | 数据库实例详情 | SQL 结构浏览 + 表结构属性 / Redis 只读查询控制台 |

建议截图规范：
- 统一使用浅色主题与相同浏览器窗口尺寸。
- 截图时尽量保留完整 Header 和 Sidebar，强化“工作台”感。
- 示例数据尽量使用真实字段名，例如 `userId`、`price`、`status`、`data[].age`。

## 🛠 技术栈

### Frontend
- **Framework**: Next.js 16 (App Router)
- **Library**: React 19
- **Language**: TypeScript
- **Editor**: Monaco Editor (`@monaco-editor/react`)
- **Styling**: CSS Modules + Modern CSS Variables

### Backend
- **Server**: Next.js API Routes (Serverless ready)
- **Database**: SQLite (powered by `better-sqlite3`)
- **Routing**: `path-to-regexp` (与 Express 路由规则一致)

## 🚀 快速开始

### 环境依赖
- Node.js 18.x 或更高版本
- npm 或 yarn

### 1. 安装依赖
```bash
npm install
```

### 2. 启动开发服务器
```bash
npm run dev
```
打开浏览器访问 [http://localhost:3000](http://localhost:3000) 即可开始使用。

> 说明：当前开发脚本使用 `next dev`，避免本地开发态下数据库相关动态接口在重复进入详情页时出现热更新抖动。

### 2.1 AI Chat 与模型配置
如需启用高级编排中的 AI Chat，请先准备一个兼容 OpenAI Chat Completions 的模型服务（例如 DeepSeek），然后：

```bash
cp .env.example .env.local
```

启动项目后进入左侧菜单的“模型管理”页面完成配置：

- 填写模型名称与 `Base URL`
- 选择鉴权方式并填写 Token / Header
- 添加至少一个 `Model ID`（添加时会立即校验可用性）
- 选择默认 `Model ID`
- 如需让 AI Chat 默认使用该来源，可勾选“设为默认”

当前示例可参考 DeepSeek OpenAI Compatible 接口：

```bash
Base URL: https://api.deepseek.com
Model ID: deepseek-chat
```

### 3. 项目打包与部署
```bash
npm run build
npm start
```

## 📂 项目结构
- `/src/app`: 页面路由与主逻辑
- `/src/app/api`: 服务端 API Routes
- `/src/components`: 可复用的 UI 组件（编辑器、弹窗等）
- `/src/lib`: 核心逻辑（数据库操作、变量解析、匹配引擎）
- `/src/prompts`: AI Prompt 模板文件（支持独立维护与动态上下文注入）
- `/.agents/skills`: 本地设计/开发辅助技能配置

## 🧪 编排示例

下面是一段适合放在 README 或演示文档里的高级编排示例配置：

```json
{
  "nodes": [
    {
      "id": "filter_1",
      "type": "filter",
      "label": "保留核心字段",
      "order": 0,
      "config": {
        "mode": "include",
        "fields": [
          "code",
          "message",
          "data[].id",
          "data[].name",
          "data[].age",
          "data[].price"
        ]
      }
    },
    {
      "id": "map_1",
      "type": "map",
      "label": "字段重命名",
      "order": 1,
      "config": {
        "mappings": [
          { "from": "data[].age", "to": "userAge" },
          { "from": "data[].price", "to": "amount" }
        ]
      }
    },
    {
      "id": "compute_1",
      "type": "compute",
      "label": "新增折后价",
      "order": 2,
      "config": {
        "computations": [
          {
            "field": "data[].discountPrice",
            "expression": "{{amount}} * 0.9"
          }
        ]
      }
    },
    {
      "id": "sort_1",
      "type": "sort",
      "label": "按年龄排序并限制数量",
      "order": 3,
      "config": {
        "arrayPath": "data",
        "sortField": "userAge",
        "order": "desc",
        "limit": 10
      }
    }
  ]
}
```

这个示例展示了完整链路：
- 先保留需要的字段
- 再重命名数组对象属性
- 然后用表达式生成计算字段
- 最后对结果集排序并限制输出条数

## 📝 许可证
MIT License
