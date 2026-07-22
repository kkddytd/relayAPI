# relayAPI：AI 模型质量检测与本地化监测平台

> 面向 Claude、GPT、Gemini 及兼容接口的开源 AI 模型质量检测、协议分析和可审计评测工具。

项目地址：[github.com/kkddytd/relayAPI](https://github.com/kkddytd/relayAPI)

[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![TypeScript](https://img.shields.io/badge/TypeScript-React-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/license-to%20be%20declared-lightgrey)](#许可证)

关键词：AI 模型质量检测、LLM 评测、Claude 检测、GPT 质量测试、Gemini 兼容性、自定义模型 ID、模型中转接口检测、API 兼容性、API 质量监测、本地化部署、Docker Compose、SQLite、开源 AI 工具。

## 目录

- [项目简介](#项目简介)
- [二次开发来源](#二次开发来源)
- [为什么做这个项目](#为什么做这个项目)
- [界面示例](#界面示例)
- [禾维模型检测算法逆向实现](#禾维模型检测算法逆向实现)
- [误差目标与评分算法](#误差目标与评分算法)
- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [Docker 一键部署](#docker-一键部署)
- [本地 Node.js 一键部署](#本地-nodejs-一键部署)
- [访问地址与端口](#访问地址与端口)
- [API Key 生成与查看](#api-key-生成与查看)
- [API 调用](#api-调用)
- [自定义模型名](#自定义模型名)
- [本地化部署](#本地化部署)
- [结果解释](#结果解释)
- [测试](#测试)
- [贡献与问题反馈](#贡献与问题反馈)
- [许可证](#许可证)
- [免责声明](#免责声明)

## 项目简介

relayAPI 用于检测不同模型、协议和中转接口的实际响应质量。项目把一次检测拆成题目执行、协议请求、响应证据、行为探针和评分聚合等阶段，返回结构化报告，方便开发者在本地复现、比较和审计结果。

项目不依赖第三方评测页面，检测请求、评分逻辑和数据存储均可自行检查与部署。它适合模型接入调试、API 网关验收、模型版本回归和私有环境质量监测。

## 二次开发来源

relayAPI 基于 [zzsting88/relayAPI](https://github.com/zzsting88/relayAPI) 进行二次开发。在保留基础检测页面和 API 结构的基础上，本仓库继续扩展了协议探针、模型评测档案、自定义模型 ID、附件识别、历史复测、安装统计、SEO、Docker Compose 和本地化部署流程。

使用、分发或继续修改本项目时，请同时遵守上游仓库的许可证、第三方依赖许可证以及相关服务条款。

## 为什么做这个项目

现有同类工具常见问题包括题集停留在旧模型版本、项目长期不维护、结果难以复现，或要求把 API Key 与检测数据交给别人搭建的服务。relayAPI 将检测过程放回使用者自己的环境，便于查看代码、替换题集、限制网络出口和持续回归。

## 界面示例

检测页面支持自定义上游地址、API Key、模型 ID、协议和评测档案：

![relayAPI 检测配置页](docs/screenshots/detection-config.png)

填写任意上游模型名后，页面会保留原始模型 ID，并提示当前使用的评测档案：

![relayAPI 自定义模型 ID 示例](docs/screenshots/custom-model-config.png)

网页 API 文档页提供可复制的 JSON、multipart 和自定义模型调用示例：

![relayAPI API 文档页](docs/screenshots/api-docs.png)

## 禾维模型检测算法逆向实现

本项目的核心模型检测算法，来自对 [hvoy.ai（禾维）](https://hvoy.ai/) 公开检测流程的逆向分析与重新实现。分析范围覆盖题目批次编排、模型档案识别、协议请求构造、响应证据提取、行为探针、评分聚合、稳定性修正和报告字段映射。

```text
检测请求
  -> 请求规范化与模型档案解析
  -> 按档案选择题目批次和协议探针
  -> 调用目标模型 API 并保存可观察证据
  -> 分离质量、行为、渠道和能力结果
  -> 聚合主分与诊断字段
  -> 返回可审计的 JSON 报告
```

逆向目标是复现公开可观察的检测与评分工程流程，不代表拥有禾维的私有源码、密钥或内部服务实现。使用者应遵守适用法律、上游服务条款和目标站点授权范围。

## 误差目标与评分算法

在固定题集、固定模型版本、固定协议、固定随机种子和同口径公开基准条件下，项目的工程目标是把评测误差控制在 **5% 以内**。这是可复现基准下的工程指标，不是对所有模型、网络条件、题库变化和未来版本的无条件保证。

报告中的主分、质量分、行为分、兼容分和公开可观察分彼此独立。网络错误、限流或无效响应会标记为 `incomplete` 或 `unavailable`，不会被伪装成模型质量低分。评分结果也不等于模型身份的密码学证明。

## 核心能力

- 支持 Claude、GPT、Gemini、GLM 及自定义模型 ID。
- 支持 Anthropic、OpenAI Chat、OpenAI Responses、OpenAI Images 和 Google Generative 等协议。
- 支持官方 API、企业网关和兼容中转接口的自定义 `base_url`。
- 支持任意附件上传与独立可识别性检查；PDF 原生路线不可用时由 [`pdf-image`](https://github.com/mooz/node-pdf-image) 生成页面预览送模，不影响主评分。
- 支持单轮与多轮稳定性检测，并按配置聚合平均值或中位数。
- 提供可供脚本、CI、桌面客户端和其他服务调用的 REST API。
- 返回机器可读的 JSON 报告、主分、诊断分、检查项、警告和引擎版本。
- 支持 OpenAPI 3.1 文档，便于快速接入和二次开发。

## 快速开始

### Docker 一键部署

环境要求：Docker Engine 24+ 与 Docker Compose Plugin。

一条命令获取源码、生成检测 API Key、构建并启动：

```bash
git clone https://github.com/kkddytd/relayAPI.git && cd relayAPI && bash scripts/deploy.sh
```

也可以在已克隆的仓库根目录执行 `bash scripts/deploy.sh`，或使用 npm 命令 `npm run deploy:docker`（兼容别名：`npm run deploy`）。宿主机只需要 Docker，不需要安装 Node.js；脚本会自动创建并保护项目根目录 `.env`。

脚本会创建 `data/` 持久化目录、构建镜像并启动服务。也可以直接使用 Compose：

```bash
docker compose up -d --build
docker compose logs -f relayapi
```

默认地址：

- 检测网页和 API：`http://127.0.0.1:6722`
- API 文档：`http://127.0.0.1:6722/api-docs`

常用维护命令：

```bash
docker compose restart
docker compose down
docker compose pull && docker compose up -d --build
```

Compose 默认将网页绑定到 `0.0.0.0:6722`，网页本身允许直接通过公网地址打开；检测 API 和旧版附件 API 的公网调用仍需要 Bearer Key。公网部署时请将 `ALLOW_LAN_WEB_WITHOUT_TURNSTILE=false`，并使用 HTTPS 反向代理。所有历史、附件和安装统计数据都保存在 `data/`，升级时不要删除该目录。

需要更换端口或数据目录时：

```bash
RELAYAPI_PORT=8080 RELAYAPI_DATA_DIR=/srv/relayapi-data bash scripts/deploy.sh
```

### 本地 Node.js 一键部署

环境要求：Node.js 22 LTS（22.12+），或满足 Vite 8 要求的 Node.js 20.19+。

一条命令获取源码、安装依赖、构建并启动：

```bash
git clone https://github.com/kkddytd/relayAPI.git && cd relayAPI && bash scripts/deploy-local.sh
```

也可以在已克隆的仓库根目录执行 `bash scripts/deploy-local.sh`，或使用 `npm run deploy:local`。

脚本会安装依赖、生成前端构建产物，并将检测网页/API 与本机安装统计服务作为独立后台进程启动；健康检查通过后命令会自动结束，退出 SSH 不会停止服务。脚本不会覆盖已有 `.env`，首次运行会从 `.env.example` 创建基础配置。

```bash
# 查看日志
tail -f data/relayapi.log

# 停止后台服务
kill "$(cat data/relayapi.pid)"

# 需要前台调试时使用
FOREGROUND=true bash scripts/deploy-local.sh
```

手动执行等价命令：

```bash
npm ci --no-audit --no-fund
cp .env.example .env
npm run api-key:generate
npm run build
npm run start
```

只启动检测网页/API 而不启动本机统计服务时使用 `npm run start:web`；开发模式使用 `npm run dev`。

## API Key 生成与查看

检测 API Key 保存在项目根目录的 `.env` 中，对应字段是 `DETECTOR_API_KEYS`。`.env` 已被 Git 忽略，不会提交到仓库。

生成或轮换一个新的检测 API Key：

```bash
npm run api-key:generate
```

查看当前 API Key：

```bash
npm run api-key:show
```

Docker-only 主机没有 Node.js 时，直接查看项目根目录 `.env` 中的值：

```bash
sed -n 's/^DETECTOR_API_KEYS=//p' .env
```

两个一键部署脚本第一次运行时会自动生成 Key，并在终端打印完整 Key 和保存位置；已有 Key 不会被覆盖。轮换 Key 后需要重启本地进程或执行 `docker compose restart`。调用检测 API 时使用：

```bash
curl -X POST 'http://127.0.0.1:6722/api/v1/detections' \
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"base_url":"https://api.example.com","upstream_api_key":"sk-target-key","model":"gpt-5.5"}'
```

## 访问地址与端口

| 部署方式 | 检测网页/API | API 文档 | 安装统计服务 |
| --- | --- | --- | --- |
| 本地 Node.js 默认配置 | `http://127.0.0.1:6722` | `http://127.0.0.1:6722/api-docs` | `127.0.0.1:6723`，仅供本机网页/API 转发，不建议直接访问 |
| Docker Compose 默认配置 | `http://127.0.0.1:6722` | `http://127.0.0.1:6722/api-docs` | 容器内部 `127.0.0.1:6723`，宿主机不发布该端口 |
| 局域网或服务器访问 | `http://服务器IP:6722` | `http://服务器IP:6722/api-docs` | 仍通过 6722 的安装统计路径访问 |

本地 Node.js 一键部署默认监听 `0.0.0.0`，因此服务器或局域网可直接打开网页；Docker Compose 也默认监听容器内的 `0.0.0.0`。更换对外端口时，Docker 使用 `RELAYAPI_PORT=8080 bash scripts/deploy.sh`，本地 Node.js 使用 `PORT=8080 bash scripts/deploy-local.sh`。安装统计服务仍使用内部端口 `6723`。

如果使用仓库内的 Nginx 配置，默认路由是：`https://你的域名/` 为安装统计面板，`https://你的域名:8443/` 为模型检测网页/API。打开网页不会自动计为一次安装。Docker 和本地一键部署脚本每次成功执行后都会向默认统计地址发送一次空 POST，并在 `data/.installation-reported` 更新最近一次成功上报时间。其他客户端安装器可以直接调用：

```bash
curl -X POST 'https://你的域名/api/v1/installations/report'
```

成功返回 `204` 后，统计面板会通过 SSE 实时增加累计数量。`GET /api/v1/installations/stats` 可用于核对当前总数。

## API 调用

检测接口支持 JSON 请求，调用方可以指定模型、协议、上游地址和检测选项。公网调用必须携带 `Authorization: Bearer <DETECTOR_API_KEY>`；检测 API Key 与上游模型 Key 分离，响应不会返回上游 Key。

```bash
curl -X POST 'http://127.0.0.1:6722/api/v1/detections' \
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \
  -H 'Content-Type: application/json' \
  --data '{
    "base_url": "https://api.example.com",
    "upstream_api_key": "sk-target-key",
    "model": "claude-opus-4-8",
    "protocol": "anthropic",
    "rounds": 1
  }'
```

常用接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/v1/detections` | 运行模型检测并返回 JSON 报告 |
| GET | `/api/v1/health` | 检测服务健康状态 |
| GET | `/api/v1/models` | 查看模型档案与协议 |
| GET | `/api/v1/openapi.json` | 获取 OpenAPI 3.1 文档 |

## 自定义模型名

自定义模型名分为两个概念，调用时不要混淆：

- `model`：原样发送给上游的模型 ID，可以是 `vendor/pro-2026`、`my-private-model` 等任意字符串。
- `profile_model`：本地评测档案，用来选择题集、协议探针和评分规则，必须使用项目支持的档案 ID，例如 `claude-fable-5`、`claude-opus-4-8` 或 `gpt-5.5`。

### 网页使用步骤

1. 在“评测档案”中选择最接近目标模型能力的档案。
2. 在“上游模型 ID（可选）”输入框填写中转站实际要求的模型名，例如 `vendor/pro-2026`。
3. 填写上游地址和 API Key，协议可先使用“自动识别”；中转站协议固定时建议手动选择。
4. 开始检测。请求会把自定义 ID 发给上游，评测仍按选中的档案执行。

页面提示“未匹配内置别名”是正常现象，表示模型名没有被自动归类，并不表示不能检测。检测报告会同时保留 `request.model`、`request.profile_model` 和 `request.profile_resolution`，便于复测和排查。

### API 使用示例

未知的中转模型名建议显式指定最接近的评测档案：

```bash
curl -X POST 'http://127.0.0.1:6722/api/v1/detections' \
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \
  -H 'Content-Type: application/json' \
  --data '{
    "base_url": "https://gateway.example.com/v1",
    "upstream_api_key": "sk-test-only",
    "model": "vendor/pro-2026",
    "profile_model": "gpt-5.5",
    "protocol": "openai-chat",
    "rounds": 1
  }'
```

如果自定义名是项目已知别名，可以省略 `profile_model`；如果无法确定模型家族，仍可选择一个质量档案运行基础检测，但不要把结果解释为该模型的专用兼容性证明。

## 本地化部署

relayAPI 采用本地优先设计：检测数据和运行记录保存在自行部署的环境中，只有主动发起的检测请求会发送到调用方指定的上游模型 API。代码、数据库和网络出口均可由使用者自行审计与控制。

实际安全性取决于服务器操作系统、文件权限、反向代理、HTTPS、网络访问控制和备份策略。公网部署时应使用 HTTPS、限制管理端口、保护配置文件，并避免把凭据写入前端代码或公开日志。

## 结果解释

- `score` 与 `scores.primary` 是模型质量主分。
- `scores.primary_basis` 说明主分采用的评分依据。
- `checks`、`metrics` 和 `warnings` 用于解释主分之外的行为证据。
- 满分不代表完成了模型身份的密码学验真。
- 官方域名或云渠道只代表可观察的传输路径证据。

## 测试

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run test:e2e
```

## 贡献与问题反馈

欢迎提交 Issue、测试样例、协议差异、模型版本变化和可复现的错误报告。提交日志或请求示例前，请删除 API Key、Cookie、个人 IP、附件内容和其他敏感信息。

## 许可证

当前仓库尚未预设具体许可证。公开发布前请添加 LICENSE 文件并明确选择 MIT、Apache-2.0 或其他适合的开源许可证；在添加许可证之前，默认不授予他人复制、修改和再发布的许可。

## 免责声明

本项目仅用于授权范围内的模型质量评测、接口调试和本地化监测。使用者应自行确认上游 API、目标站点和逆向分析行为符合适用法律、服务条款和组织政策。本项目不对第三方模型服务的可用性、输出正确性、模型身份或部署环境安全承担保证责任。
