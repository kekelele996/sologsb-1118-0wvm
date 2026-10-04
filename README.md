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
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移，当前 v3） |
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
│       ├── types/              # trench.ts / basepoint.ts / stratum.ts / artifact.ts / relation.ts / index.ts
│       ├── stores/             # trenchStore / basePointStore / stratumStore / artifactStore / relationStore（Zustand）
│       ├── components/common/  # StratumDepthBar / RelationGraph / TrenchTag / UnitPicker
│       ├── hooks/              # useStratumOrder / useRelationGraph / usePersistentStore
│       ├── pages/              # TrenchesPage / StrataPage / ArtifactsPage / RelationsPage / SectionsPage
│       ├── router/index.ts
│       └── utils/              # graph.ts / reconcile.ts / export.ts / id.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Trench 探方 | 探方号、发掘区、规格、基点文字记录、开口层位、发掘起止、负责人、四壁备注、是否回填 | `trenches` |
| BasePoint 基点版本 | **测绘组台账**：所属探方、版本号、北/东坐标与高程、测绘记录、登记人、启用日期、是否生效；改基点只追加新版本 | `basePoints` |
| Stratum 地层单位 | 单位号、类型（地层/灰坑/房址/沟/墓葬）、开口层位、上下界深度、土质土色、包含物、堆积成因、绘图拍照号 | `strata` |
| Artifact 出土物 | **整理室台账**：所属地层单位、器物编号、类别、件数、残整程度、探方内平面读数 X/Y/Z、量算基点版本、对账状态、进库冻结坐标、出土日期、提取人、存放位置 | `artifacts` |
| Relation 层位关系 | 单位 A、关系类型（叠压/打破/共存）、单位 B、判定依据、记录人、备注 | `relations` |

- 数据库名 `gbtrenchlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史地层单位补齐「开口层位」字段并规范包含物数组；
- `version(3)` 起基点独立成带版本的测绘组台账，器物增加基点版本、对账状态与进库冻结坐标；旧数据没有基点版本，升级时按各探方**当时基点**补齐 v1 并把历史器物挂到该版本（基点文字解析不出坐标的先挂起，补录后可对账）；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 五·补、基点台账与器物坐标对账（测绘组 / 整理室各持一份）

两边数据分离、各自只改自己那份：

| 持有方 | 管什么 | 落点 |
| --- | --- | --- |
| 测绘组 | 基点坐标与换算基准，改动**只追加版本**（v1、v2…），历史版本保留作对账依据 | `basePoints`（探方卡片「基点台账」） |
| 整理室 | 器物编号、按基点量取的平面读数 X/Y、存放位置，以及量算时用的基点版本 | `artifacts`（出土物页） |

对账规则（见 `src/utils/reconcile.ts`，纯函数、不改测绘组数据）：

1. **基点改动后未归档器物重算**：测绘组在基点台账保存新版本，整理室未归档（含挂起）器物按各自依据的旧基点把平面读数换算到新基点（全局位置不变，仅换算基准平移）；已进库器物坐标**冻结不重算**。
2. **进库即冻结**：器物「进库」时按当时基点算出全局北/东坐标并写入 `frozenNorth/frozenEast`；此后基点再改也不动这些坐标。
3. **对不上就挂起**：进库后若测绘基点记录与冻结坐标对不上、或基点版本缺失/坐标未补齐，器物置为「挂起待确认」，**先不进库**，等测绘组在基点台账确认（补录旧版本或核对版本），由整理室「解除挂起」后重新对账。
4. **重算失败只重试自己那份**：基点缺失/不完整等失败只在器物记录上挂问题状态，绝不回写或修改测绘组基点台账。
5. **旧数据升级**：没有基点版本的历史数据在 v3 迁移时按当时基点补齐 v1；只有文字、解析不出坐标的基点可在基点台账「坐标待补录」处补录（已完整的基点要修正只能追加新版本，不能覆盖测绘记录）。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/trenches` | 探方清单：按「发掘区-探方号」校验唯一性，卡片显示单位数、出土物件数、关系数与发掘进度状态；每张卡片可打开「基点台账」（测绘组）维护基点版本、补录旧坐标 |
| `/strata` | 地层单位编目表：按类型与深度区间筛选，层序倒置与单位号重复即时高亮，深度刻度条展示厚度 |
| `/artifacts` | 出土物登记与清单：先锁定所属地层单位（级联选择器），带出深度区间并校验出土深度；平面读数按当前生效基点量取，支持与基点记录对账、进库冻结、挂起解除 |
| `/relations` | 层位关系视图：SVG 有向图展示叠压/打破，点击节点高亮直接关系，新增关系前做环路检测 |
| `/sections` | 四壁剖面示意：按深度刻度绘制地层条带与厚度标注，叠加出土物投影点 |

## 七、校验规则

- 同一「发掘区-探方号」只允许一个探方；
- 同一探方内单位号不可重复（保存时拒绝）；
- 上界深度大于下界深度即为**层序倒置**，编目表整行标红并在顶部汇总；
- 若「A 叠压/打破 B」但 A 的上界深度大于 B，则提示层位关系与深度矛盾；
- 新增层位关系前做**环路检测**（DFS），会形成闭合矛盾的关系直接拒绝保存；
- 出土物的 Z（深度）必须落在其所属地层单位的深度区间内，否则给出层位核对提示；
- 器物平面读数必须挂靠一个测绘组基点版本；基点缺失或坐标未补齐、以及进库冻结坐标与基点记录对不上时，器物挂起且不得进库；已进库坐标不随后续基点改动重算。
