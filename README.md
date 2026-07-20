# kk：AI 模型质量检测与本地化监测平台

> 面向 Claude、GPT、Gemini 及兼容中转接口的开源 AI 模型质量检测、协议一致性分析、附件识别验证、历史复测和安装统计平台。

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-React-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/Storage-SQLite-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License](https://img.shields.io/badge/license-to%20be%20declared-lightgrey)](#许可证)

关键词：AI 模型质量检测、LLM 评测、Claude 检测、GPT 质量测试、Gemini 兼容性、模型中转站检测、API 质量监测、本地化部署、SQLite、附件识别、安装次数统计、开源 AI 工具。

## 项目简介

kk 是一个可以自行部署、审计和扩展的 AI 模型质量监测工具。它不只看一次回答是否正确，而是把以下证据拆开记录：

- **模型质量**：任务正确性、接口完整性、响应结构和稳定性。
- **协议一致性**：Anthropic、OpenAI Chat、OpenAI Responses、OpenAI Images、Google Generative 等请求/响应行为。
- **渠道证据**：最终请求主机、提供商域名、云渠道信息和可观察响应标记。
- **附件可识别性**：图片、PDF、文本、JSON、Python、PHP、JavaScript 等附件是否真正进入模型请求，以及模型是否返回了基于附件的证据。
- **本地历史**：检测请求、API 调用记录、附件元数据和报告保存到本机 SQLite，支持网页一键复测。
- **安装统计**：客户端安装完成后发送一个空请求，服务端累计统计安装上报次数并记录来源 IP。

服务端只需部署一次网页/API 和安装统计服务；客户端不部署服务，只在安装完成后调用上报 API。网页检测端和安装统计端可以使用不同端口，适合个人使用、内网部署和自建 API 服务。

## 为什么做这个项目

目前不少同类方案存在以下问题：评测题目停留在旧模型版本、项目长期不维护、结果不可复现，或者要求把 API Key、历史记录和附件交给别人搭建好的闭源服务。对于模型中转站、兼容 API 和私有部署场景，这些方案很难审计，也很难确认数据究竟去了哪里。

kk 的目标是把检测逻辑、数据存储和部署过程交给使用者自己掌握：可以查看代码、固定题集、替换探针、检查 SQLite、限制网络出口，并根据自己的模型版本持续回归。

## 禾维模型检测算法逆向实现

本项目的核心模型检测算法，来自对 [hvoy.ai（禾维）](https://hvoy.ai/) 公开检测流程的逆向分析与重新实现。逆向范围不是只参考页面样式，而是覆盖了模型质量检测的完整链路：题目批次编排、模型档案识别、协议请求构造、响应证据提取、行为探针、评分聚合、稳定性修正和报告字段映射。

当前实现将一次模型检测拆成以下阶段：

```text
检测请求
  -> 请求规范化与模型档案解析
  -> 按档案选择题目批次和协议探针
  -> 调用目标模型 API 并保存原始可观察证据
  -> 分离质量、行为、渠道和可选能力结果
  -> 按公开基准聚合主分与诊断字段
  -> 返回可审计的 JSON 报告并写入本地历史
```

算法逆向的目标是复现“如何检测和如何评分”的工程流程，而不是声称拥有禾维的私有源码或提供商内部实现。仓库中的题目快照、评分参考和请求指纹都会随版本记录，便于发现上游算法变化。

### 逆向来源与项目边界

逆向分析基于 [hvoy.ai（禾维）](https://hvoy.ai/) 的公开页面、浏览器网络请求和黑盒响应行为：

- 本项目不是 hvoy.ai（禾维）官方项目，也不代表禾维官方立场。
- 本项目不包含禾维的私有源码、私有密钥或服务端凭据。
- 逆向分析只用于理解公开可观察的请求结构、题目流程和报告行为；使用者仍需遵守所在地区法律、上游服务条款和目标站点的授权范围。
- 上游模型可能随时间更换版本、题库、路由或响应策略，任何评测结果都应结合报告版本和测试时间解读。

## 误差目标与评分算法

在**固定题集、固定模型版本、固定协议、固定随机种子和同口径公开基准**条件下，项目的工程目标是把评测误差控制在 **5% 以内**。报告会保存题目批次、引擎版本、评分依据和请求指纹，便于重复测试和定位差异。

这里的 5% 是可复现基准下的工程指标，不是对所有模型、中转站、网络重试、题库变化和未来版本的无条件保证。模型质量分也不等于模型身份的密码学证明：中转站可以修改响应，只有完成提供商独立公钥验签，才可能证明具体模型来源。

评分报告至少分为以下层级：

- `score` / `scores.primary`：调用方优先读取的主分。
- `scores.quality`：任务正确性、接口完整性和响应质量。
- `scores.behavior`：模型字段、协议结构、行为探针和响应一致性。
- `scores.official_compatibility`：有专用公开基准的模型档案兼容分。
- `scores.public_observable`：本地可观察证据支持的分数。
- `scores.primary_basis`：说明主分来自 `official_compatibility` 还是 `quality`。
- `attachment_analysis`：附件可识别性独立报告，固定不参与主分。

当核心探针不可用时，服务返回 `incomplete` 或 `unavailable`，不会把网络错误、限流或无效响应伪装成模型低分。多轮检测使用轮换题批，2 轮取平均、3 轮取中位数；缓存检测和实时知识检测是可选能力观测。

## 核心功能

### 多模型、多协议检测

- Claude、GPT、Gemini、GLM 及自定义模型 ID。
- Anthropic、OpenAI Chat、OpenAI Responses、OpenAI Images、Google Generative 协议。
- 支持自定义 base_url，适合官方 API、企业网关和兼容中转接口。
- 专用模型档案与质量档案分开，避免把未知中转模型名误判成官方模型。
- rounds 1-3 稳定性检测，多轮完成后按平均值或中位数聚合。
- 可选提示缓存观测和实时知识访问检测，默认关闭以控制请求量和费用。

### 附件上传与识别验证

一次 multipart 请求即可同时上传附件并检测：

- 不检查扩展名、MIME、内容、文件数量或应用级文件大小。
- 原始文件名保留，附件单独保存在 DATA_DIR/upload/ 和内部历史目录。
- 图片、PDF、文本、JSON、代码和其他二进制文件均可进入同一检测流程。
- files 字段可以重复提交多个文件，attachments 按顺序匹配，不需要用户管理附件 ID。
- 附件检查只判断模型是否收到并返回附件证据，不判断 OCR、用途或语义是否准确。
- 附件报告固定 scored=false、affects_primary_score=false，不会改变模型主分。
- 上传响应和检测报告返回浏览器 url，同名文件 URL 指向最新上传版本，旧文件仍保留在内部历史目录供复测使用。

示例：

```bash
curl -k -X POST 'https://YOUR_SERVER_HOST/api/v1/detections' \
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \
  -F 'request={"base_url":"https://api.example.com","upstream_api_key":"sk-target-key","model":"claude-opus-4-8","protocol":"anthropic","attachments":[{"mode":"understand","instruction":"只判断模型是否识别到附件"}]};type=application/json' \
  -F 'files=@./example.py'
```

-k 只适用于证书签发给域名、但调用时直接使用 IP 的情况；正式环境应优先使用证书匹配的域名或配置包含 IP 的证书。

### 本地历史与一键复测

- 检测历史、API 调用记录、审计记录和附件元数据写入本机 SQLite。
- 完整请求中的上游 API Key 使用 AES-256-GCM 加密后保存。
- 网页历史、API 响应和附件报告不会展示上游 Key。
- 历史记录可以在网页中一键复测，便于比较模型版本、协议和中转站变化。
- 丢失 HISTORY_ENCRYPTION_KEY 后，旧记录无法解密，因此生产环境应备份该密钥。

### 客户端安装完成上报

客户端安装完成后不需要生成设备 ID，只需发送一个空 POST：

```bash
curl -X POST 'https://YOUR_SERVER/api/v1/installations/report'
```

服务端会记录：

- 累计安装上报次数 total。
- 当日安装上报次数 today。
- 去重后的来源 IP 数 unique_ips。
- 最近上报时间和最近 14 天趋势。
- SSE 实时统计流，网页无需刷新即可更新数量。

这个数字表示“安装完成上报次数”，不是通过设备 ID 去重后的唯一设备数。服务端保存的是本机 SQLite 中的安装事件，后续新的安装上报会继续累加。

客户端不需要部署 Node.js、SQLite、网页、统计服务或数据库，只需调用上面的上报地址。

### 局域网兼容

局域网通过 HTTP/IP 访问时，浏览器可能处于 isSecureContext=false，crypto.randomUUID 不一定存在。前端已提供 getRandomValues 兼容 UUID 路径，开始检测不会因为 randomUUID 缺失而在发出上游请求前异常。

## 快速开始

环境要求：Node.js 20 或更高版本。

```bash
git clone https://github.com/kkddytd/relayAPI.git
cd relayAPI
npm install
cp .env.example .env.local
openssl rand -base64 32
# 将上一步生成的值写入 .env.local 的 HISTORY_ENCRYPTION_KEY
npm run build
npm run start
```

HISTORY_ENCRYPTION_KEY 只需要在每个部署环境中设置一次稳定值，不要提交到 GitHub：

```dotenv
HISTORY_ENCRYPTION_KEY=你的部署专用长期密钥
```

同一部署后续发布必须继续使用原值，否则旧的检测历史无法解密。不同使用者可以生成各自的密钥；密钥只保护本地 SQLite 历史，不需要和项目作者或其他部署共享。

默认地址：

- 检测网页和 API：http://127.0.0.1:6722
- API 文档：http://127.0.0.1:6722/api-docs
- 安装统计服务：http://127.0.0.1:6723

开发模式：

```bash
npm run dev
```

生产环境可以使用 PM2：

```bash
npm run build
npm run pm2:start
```

## API 调用支持

kk 提供可供脚本、CI、桌面客户端和其他服务调用的 REST API，不要求只能通过网页操作。API 支持：

- JSON 检测请求和 multipart 附件检测请求。
- 自定义模型 ID、base_url、协议和评测档案。
- 独立检测 API Key，与请求体中的上游模型 Key 分离。
- 返回机器可读的 JSON 报告、主分、诊断分、检查项、警告和引擎版本。
- 安装完成空 POST、累计数量查询和 SSE 实时安装统计。
- OpenAPI 3.1 文档：部署后访问 /api/v1/openapi.json，也可在网页 API 文档页查看。

API 请求流程：

```text
调用方 -> POST /api/v1/detections
      -> kk 解析模型档案并执行逆向评测探针
      -> kk 调用调用方指定的上游 API
      -> 返回 JSON 检测报告并保存本地历史
```

响应中最常用的字段是 status、score、scores.primary_basis、checks、metrics、warnings 和 attachment_analysis。上游 Key 只放在请求中，不会出现在网页、报告或 API 响应里。

## API 示例

无附件检测：

```bash
curl -X POST 'http://127.0.0.1:6722/api/v1/detections' \
  -H 'Content-Type: application/json' \
  --data '{
    "base_url": "https://api.example.com",
    "upstream_api_key": "sk-target-key",
    "model": "claude-opus-4-8",
    "protocol": "anthropic",
    "rounds": 1,
    "checks": { "cache": false, "live_knowledge": false }
  }'
```

公网调用建议配置独立的 DETECTOR_API_KEYS，它与请求体中的 upstream_api_key 是两套不同凭据：

```bash
curl -k -X POST 'https://YOUR_SERVER_HOST/api/v1/detections' \
  -H 'Authorization: Bearer YOUR_DETECTOR_API_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"base_url":"https://api.example.com","upstream_api_key":"sk-target-key","model":"gpt-5.5"}'
```

常用接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | /api/v1/detections | 运行模型检测，支持 JSON 或 multipart 附件 |
| GET | /api/v1/health | 检测服务健康检查 |
| GET | /api/v1/models | 查看模型档案、别名和协议 |
| GET | /api/v1/openapi.json | 获取 OpenAPI 3.1 文档 |
| POST | /api/v1/installations/report | 上报一次客户端安装完成 |
| GET | /api/v1/installations/stats | 获取安装统计 |
| GET | /api/v1/installations/stream | 订阅实时安装统计 SSE |

旧的 POST /api/v1/attachments 两步上传接口仅为历史调用兼容保留，新的附件测试建议直接使用上面的 multipart /api/v1/detections。

## 数据目录

```text
DATA_DIR/
├── kangkang.sqlite              # 检测历史、API 审计和附件元数据
├── .history-key                 # 自动生成的历史加密密钥
├── upload/                      # 浏览器可访问的同名文件最新版本
└── .attachment-history/         # 每次上传的原文件和历史版本

INSTALL_TRACKER_DATA_DIR/
└── installations.sqlite         # 安装上报事件和来源 IP
```

应用本身不限制附件类型和大小，但操作系统、磁盘容量、Nginx/Cloudflare 等反向代理仍可能有自己的请求限制。附件目录应视为不可信文件存储，不能让 Web 服务器执行其中的脚本文件。

## 本地化部署与安全边界

本项目采用本地优先设计：检测历史、附件、审计记录和加密后的上游 Key 保存在你自己的服务器上，不要求把这些数据上传到第三方 SaaS 服务。只有你主动配置的检测请求会发送到对应的上游模型 API。

在正确配置的自建环境中，项目数据可以完全留在你的服务器；这里的“完全本地化”不等于对任意操作系统、网络和部署环境作“绝对安全”的承诺。相比把 API Key 和历史记录交给未知的第三方搭建实例，本地部署更容易审计和控制。实际安全性还取决于：

- 服务器操作系统、SSH 密钥、文件权限和备份策略。
- 反向代理是否启用 HTTPS、是否正确限制管理端口。
- DETECTOR_API_KEYS、HISTORY_ENCRYPTION_KEY 和 WEB_SESSION_SECRET 是否使用随机长期值。
- 是否限制上游网络出口、关闭不需要的公网端口。
- 是否把 DATA_DIR、附件目录和日志目录纳入访问控制。

建议公网部署时：

1. 使用 Nginx/Caddy 终止 HTTPS，并只把 Web/API 端口代理到本机 6722。
2. 安装统计服务只监听本机 6723，通过同源路径或受控反代访问。
3. 配置独立检测 Bearer Key，不要把上游 Key 写入前端代码或公开仓库。
4. 定期备份 SQLite 和加密密钥，并限制备份文件权限。

## 评测结果的正确理解

score 是主质量分，优先读取 scores.primary 和 scores.primary_basis。以下字段不能被误读为模型身份的绝对证明：

- 满分不代表具体上游模型已完成密码学验真。
- 官方域名或云渠道只代表传输路径证据，不代表模型一定没有被替换。
- 附件 recognized 只代表模型返回了附件相关证据，不代表内容理解准确。
- 缓存和实时知识检查是独立能力观测，不默认降低主质量分。
- 上游不可用时返回 unavailable，不会把网络错误伪装成模型低分。

## 测试与质量保证

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run test:e2e
```

测试覆盖检测协议、模型档案、评分、缓存观测、实时知识、附件上传、历史复测、安装统计、SSE、局域网不安全上下文和移动端页面。

## 适合谁使用

- 需要检测 Claude、GPT、Gemini 或兼容中转接口质量的开发者。
- 需要把模型检测数据留在内网或个人服务器的团队。
- 需要验证图片、PDF、代码和 JSON 附件是否真正被模型看到的测试人员。
- 需要追踪客户端安装上报数量和来源 IP 的项目维护者。
- 需要审计评测流程，而不是只相信第三方页面显示的一个分数的用户。

## 贡献与问题反馈

欢迎提交 Issue、测试样例、协议差异、模型版本变化和可复现的错误报告。提交日志或请求示例前，请删除 API Key、Cookie、个人 IP、附件内容和其他敏感信息。

推荐的 Issue 信息：

- Node.js、操作系统和浏览器版本。
- 模型 ID、协议、是否使用中转站和检测引擎版本。
- 脱敏后的请求/响应结构。
- status、scores.primary_basis、warnings 和相关检查项。
- 是否可以在本地最小配置中复现。

## 许可证

当前仓库尚未预设具体许可证。公开发布前请添加 LICENSE 文件并明确选择 MIT、Apache-2.0 或其他适合你的开源许可证；在添加许可证之前，默认不授予他人复制、修改和再发布的许可。

## 免责声明

本项目仅用于授权范围内的模型质量评测、接口调试和本地化监测。使用者应自行确认上游 API、目标站点和逆向分析行为符合适用法律、服务条款和组织政策。本项目不对第三方模型服务的可用性、输出正确性、模型身份或部署环境安全承担保证责任。
