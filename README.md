# relayAPI：AI 模型质量检测与本地化监测平台

> 面向 Claude、GPT、Gemini 及兼容接口的开源 AI 模型质量检测、协议分析和可审计评测工具。

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-React-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/license-to%20be%20declared-lightgrey)](#许可证)

关键词：AI 模型质量检测、LLM 评测、Claude 检测、GPT 质量测试、Gemini 兼容性、模型中转接口检测、API 质量监测、本地化部署、SQLite、开源 AI 工具。

## 项目简介

relayAPI 用于检测不同模型、协议和中转接口的实际响应质量。项目把一次检测拆成题目执行、协议请求、响应证据、行为探针和评分聚合等阶段，返回结构化报告，方便开发者在本地复现、比较和审计结果。

项目不依赖第三方评测页面，检测请求、评分逻辑和数据存储均可自行检查与部署。它适合模型接入调试、API 网关验收、模型版本回归和私有环境质量监测。

## 为什么做这个项目

现有同类工具常见问题包括题集停留在旧模型版本、项目长期不维护、结果难以复现，或要求把 API Key 与检测数据交给别人搭建的服务。relayAPI 将检测过程放回使用者自己的环境，便于查看代码、替换题集、限制网络出口和持续回归。

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
- 支持单轮与多轮稳定性检测，并按配置聚合平均值或中位数。
- 提供可供脚本、CI、桌面客户端和其他服务调用的 REST API。
- 返回机器可读的 JSON 报告、主分、诊断分、检查项、警告和引擎版本。
- 支持 OpenAPI 3.1 文档，便于快速接入和二次开发。

## 快速开始

环境要求：Node.js 20 或更高版本。

```bash
git clone https://github.com/<owner>/<repository>.git
cd relayAPI
npm install
npm run build
npm run start
```

默认地址：

- 检测网页和 API：`http://127.0.0.1:6722`
- API 文档：`http://127.0.0.1:6722/api-docs`

开发模式：

```bash
npm run dev
```

生产环境可以使用 PM2：

```bash
npm run build
npm run pm2:start
```

## API 调用

检测接口支持 JSON 请求，调用方可以指定模型、协议、上游地址和检测选项。检测 API Key 与上游模型 Key 分离，响应不会返回上游 Key。

```bash
curl -X POST 'http://127.0.0.1:6722/api/v1/detections' \
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
