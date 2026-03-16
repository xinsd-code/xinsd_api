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

- **📦 环境变量与分组**
  - 支持接口按分组管理。
  - 分组级别**环境变量**支持 (`{{VAR}}`)，在 URL、Headers、Body 中自动替换。

- **🎨 极致视觉体验**
  - 全新设计的 Light Theme，采用 Plus Jakarta Sans 字体。
  - 磨砂玻璃 (Glassmorphism) 效果，精致的投影与卡片布局。

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

### 3. 项目打包与部署
```bash
npm run build
npm start
```

## 📂 项目结构
- `/src/app`: 页面路由与主逻辑
- `/src/components`: 可复用的 UI 组件（编辑器、弹窗等）
- `/src/lib`: 核心逻辑（数据库操作、变量解析、匹配引擎）
- `/src/api`: 后端接口逻辑

## 📝 许可证
MIT License
