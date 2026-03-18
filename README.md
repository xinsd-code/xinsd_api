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
  - 适用于构建统一网关入口或适配已有接口体系。

- **🧠 高级编排工作流（测试转发）**
  - 在 API 转发配置页新增“高级编排”工作流编辑器，支持 `数据筛选 / 字段映射 / 字段新增 / 排序限制` 节点串联。
  - 支持节点拖拽排序、单节点调试、整条编排试运行，并在页面内实时预览工作流配置 JSON。
  - 字段新增支持模板表达式：`{{字段}}`、`{{入参key}}`、`{{$param.key}}`（如 `{{bbb}} * 0.1`）。
  - 针对对象数组（如 `data[]`）支持父子层级树展示与选择，父节点勾选自动联动子节点，部分勾选显示中间态。
  - 字段映射支持数组项属性重命名（如 `data[].age -> userAge`），直接改写数组对象字段，不会额外生成冗余数组。
  - 编排输入支持填写真实 API 入参并触发实际转发调用，基于真实返回数据继续后续编排。
  - 工作流支持一键保存，配置持久化到 API 转发表（`orchestration` 字段）。

- **📦 环境变量与分组**
  - 支持接口按分组管理。
  - 分组级别**环境变量**支持 (`{{VAR}}`)，在 URL、Headers、Body 中自动替换。

- **🎨 极致视觉体验**
  - 全站升级为 Studio 风格 Light Theme，采用 Plus Jakarta Sans + JetBrains Mono 字体体系。
  - 统一图标系统、反馈 Toast、标签、按钮和卡片设计语言，提升整体一致性。
  - Mock / API Client / API Forward 三大工作台拥有一致的导航结构与更清晰的结果面板。

## ✨ 本次更新亮点

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

> 说明：当前开发脚本使用 `next dev --webpack`，用于提升 App Router + API Route 在本地联调时的稳定性。

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
- `/.agents/skills`: 本地设计/开发辅助技能配置

## 📝 许可证
MIT License
