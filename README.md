# 考古探方地层编目台（gbtrenchlog）

面向考古发掘工地的记录员与整理人员，把「探方 → 地层单位 → 堆积描述 → 层位关系 → 出土物」整理成一套可核对的编目档案，解决地层编号重复、打破与叠压关系记不清、出土物脱离层位上下文的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21818>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbtrenchlog
FRONTEND_PORT=21818
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21818
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1118/
├── docker-compose.yml          # 顶层 name: gbtrenchlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # basePoint.ts / trench.ts / stratum.ts / artifact.ts / relation.ts / index.ts
│       ├── stores/             # basePointStore / trenchStore / stratumStore / artifactStore / relationStore（Zustand）
│       ├── components/common/  # StratumDepthBar / RelationGraph / TrenchTag / UnitPicker
│       ├── hooks/              # useStratumOrder / useRelationGraph / usePersistentStore
│       ├── pages/              # TrenchesPage / SurveyPage / StrataPage / ArtifactsPage / RelationsPage / SectionsPage
│       ├── router/index.ts
│       └── utils/              # graph.ts / export.ts / id.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| BasePointVersion 基点版本 | **测绘组持**：探方基点 N/E/高程、版本号、生效日期、测绘人、改版/勘误说明、是否现行 | `basePoints` |
| Trench 探方 | 探方号、发掘区、规格、基点文本（以基点台账为准）、开口层位、发掘起止、负责人、四壁备注、是否回填 | `trenches` |
| Stratum 地层单位 | 单位号、类型（地层/灰坑/房址/沟/墓葬）、开口层位、上下界深度、土质土色、包含物、堆积成因、绘图拍照号 | `strata` |
| Artifact 出土物 | **整理室持**：所属地层单位、器物编号、类别、件数、残整程度、相对基点的平面读数 X/Y/Z、读数基点版本、台账状态（未归档/已进库/挂起/重算失败）、进库冻结绝对坐标、存放位置、挂起原因 | `artifacts` |
| Relation 层位关系 | 单位 A、关系类型（叠压/打破/共存）、单位 B、判定依据、记录人、备注 | `relations` |

- 数据库名 `gbtrenchlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史地层单位补齐「开口层位」字段并规范包含物数组；
- `version(3)` 新增 `basePoints` 基点版本表：**旧数据没基点版本，升级时按当时登记基点为每个探方补 v1 基点**，旧器物按该基点补版本号并视作已进库、冻结其绝对坐标（历史坐标不被改写）；基点文本无法解析的暂记 (0,0) 并留痕，等测绘组勘误；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

### 基点改算与进库对账规则（测绘组 ↔ 整理室双账）

两边各持一份：**测绘组管基点坐标和换算基准，整理室管器物编号、平面读数和存放位置**。

1. 探方基点由测绘组定，改版即升版本：旧版本自动归档（不删除），新版本现行；历史版本可勘误并留痕。
2. 器物平面读数按整理室量取时的基点版本登记（`baseVersion`）。换算基准：`新读数 = 旧读数 +（旧基点 − 新基点）`，保证物理位置不变。
3. 测绘组改基点后，**没归档（未进库）的器物读数要按新基点重算**；在「基点与对账」页对该探方批量执行。
4. **已进库器物的绝对坐标在进库时冻结，不随基点改版变化**；页面按其冻结时的基点版本重算并与冻结值对账（容差 0.01 m）。
5. **对不上的挂起，等测绘组确认，先不进库**；测绘确认后可选「确认进库」（以现行基点记录为准冻结）或「退回重测」（回到未归档重新量取）。
6. 重算只动整理室那份：找不到旧基点版本等失败仅标记在器物上（状态 `failed`），**基点补齐后只重试失败件**，不回写测绘台账。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/trenches` | 探方清单：按「发掘区-探方号」校验唯一性，卡片显示单位数、出土物件数、关系数、当前基点版本、挂起/失败件数与发掘进度状态 |
| `/survey` | **基点与对账（测绘）**：基点版本台账与改基点升版、历史版本勘误；未进库读数按新基点重算 / 只重试失败件；已进库器物冻结坐标与基点记录对账、挂起件测绘确认 |
| `/strata` | 地层单位编目表：按类型与深度区间筛选，层序倒置与单位号重复即时高亮，深度刻度条展示厚度 |
| `/artifacts` | 出土物登记与清单：先锁定所属地层单位（级联选择器），读数按当前基点版本登记并带出深度区间校验；进库前对账、对不上挂起；已进库坐标冻结只可改档案 |
| `/relations` | 层位关系视图：SVG 有向图展示叠压/打破，点击节点高亮直接关系，新增关系前做环路检测 |
| `/sections` | 四壁剖面示意：按深度刻度绘制地层条带与厚度标注，叠加出土物投影点 |

## 七、校验规则

- 同一「发掘区-探方号」只允许一个探方；
- 同一探方内单位号不可重复（保存时拒绝）；
- 上界深度大于下界深度即为**层序倒置**，编目表整行标红并在顶部汇总；
- 若「A 叠压/打破 B」但 A 的上界深度大于 B，则提示层位关系与深度矛盾；
- 新增层位关系前做**环路检测**（DFS），会形成闭合矛盾的关系直接拒绝保存；
- 出土物的 Z（深度）必须落在其所属地层单位的深度区间内，否则给出层位核对提示。
