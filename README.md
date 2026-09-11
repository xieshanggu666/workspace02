# 方言田野工作站（Dialect Fieldwork）

面向**方言调查员 / 语言教练**的离线优先手机端工具：现场录音 → 说话人授权 →
波形音节标注 → 说话人绑定 → 编排跟读课 → 学员跟读 → 教练批注，全程支持离线采集与版本合并。

## 功能与技术映射

| 需求 | 实现 |
|---|---|
| 录音采集 | `apps/mobile/src/screens/RecorderScreen.tsx` + `src/recorder.ts`（expo-av，录音时实时电平采样成波形峰值） |
| 说话人授权 | `Speaker` 实体 + `consentStatus(granted/pending/revoked)` + 协议 `consentHash(sha256)`；App 内电子签署 / 撤回；撤回即封口 |
| 音频波形标注 / 切分音节 | `apps/mobile/src/ui/Waveform.tsx`（点波形落边界，两点成一音节，逐音节填转写/对译/IPA） |
| 绑定说话人 | 每条 `AudioAsset.speakerId`；按说话人详情页采集 |
| 课程编排 | `CourseEditorScreen`：从素材挑句、排序、跟读次数、教练提示 |
| 学员练习 | `CourseDetailScreen`：听原音 → 录音跟读（本地加密）→ 提交 attempt |
| 教练批注 | 按时间点（秒）在学员跟读波形上加 annotation |
| 离线同步 | outbox + 游标增量；`packages/shared/src/merge.ts` 三向版本合并（fast-forward / LWW / 冲突） |
| 敏感录音保护 | 端侧 AES-256（主密钥 Keychain/Keystore）+ 服务端 AES-256-GCM 一录一密落盘 + 读取时角色/授权闸门 |

## 仓库结构

```
packages/shared/      前后端共享：DTO、方言示例元数据、版本合并纯函数（含 vitest）
apps/api/             NestJS + TypeORM + MySQL（无 MySQL 时可用 sql.js 演示 profile）
apps/mobile/          Expo(React Native) + TypeScript + Zustand + TanStack Query
docker-compose.yml    一键 MySQL 8（root / zhongxin123，库 dialect）
```

## 一、启动后端

### 方式 A：Docker MySQL（推荐，正式栈）

```bash
cp .env.example .env          # 已按 root/zhongxin123 预填
docker compose up -d mysql    # 等待 healthy
npm install                   # 根目录一次装齐三个 workspace
npm run build:shared
npm run seed                  # 建表 + 演示账号 + 6 条方言示例 + 示例跟读课
npm run dev:api               # http://127.0.0.1:3000/api
```

> 不用 Docker 时，在本机 MySQL 里执行
> `CREATE DATABASE dialect CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
> TypeORM `synchronize=true` 会自动建表。连接配置全部在 `.env`：
> `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`。

### 方式 B：无 MySQL 的演示模式（sql.js 本地文件，零外部依赖）

```bash
npm install && npm run build:shared
cd apps/api
DB_TYPE=sqlite npm run seed --silent 2>/dev/null || DB_TYPE=sqlite npx ts-node --transpile-only src/seeds/run-seed.ts
DB_TYPE=sqlite npm run start:dev
```

数据落在 `apps/api/dialect-demo.sqlite`，上传/加密文件落在 `apps/api/uploads/`。

健康检查：`GET http://127.0.0.1:3000/api/health`

## 二、演示账号（密码统一 `demo1234`）

| 用户名 | 角色 | 能做什么 |
|---|---|---|
| `investigator1` | 调查员 | 建档、授权、采集、标注、同步说话人/音频 |
| `coach1` | 教练 | 编排发布课程、批注学员跟读 |
| `student1` | 学员 | 看已发布课程、听原音、录音跟读 |
| `admin` | 管理员 | 全部 |

## 三、方言示例数据（6 组，由 seed 程序化生成可播放 WAV）

| 方言 | 句子 / IPA | 说话人授权 | 素材状态 |
|---|---|---|---|
| 粤语-广州话 | 你好吗？ `nei˨˧ hou˧˥ maː˧` | granted(**course**) | published |
| 西南官话-成都话 | 我是成都人 `ŋo˨˩ sɿ˥˧ tsʰən˨˩tu˨˩ nən˨˩˧` | granted(**research，仅研究**) | annotated，**不可入课/不分发，GCM 加密落盘** |
| 吴语-苏州话 | 侬吃饭了啊？ `noŋ˨˧ tsʰi˥˩ ve˨˧˩ tsi˥˨ a˧` | granted(public) | published |
| 闽南语-厦门话 | 今仔日天气好 `ka˧˨ a˥˥ lit˩ sĩ˧˧ kʰi˥˩ ho˥˧` | granted(course) | published |
| 客家语-梅州话 | 我爱食白糖糕 `ŋai˩ oi˥˧ sit˩ pak̚˩ tʰɔŋ˩ kau˧` | **pending（待签）** | **restricted，AES-GCM 加密** |
| 湘语-长沙话 | 锁在哪里？ `so˧˩ tei˧˩ na˧˧ li˧˩` | **revoked（已撤回）** | **restricted，禁止分发** |

完整字段（含逐音节起止秒、波形峰值、采样率、授权哈希等）在
`packages/shared/src/samples.ts`，可被前后端直接引用；WAV 由
`apps/api/src/seeds/generate-wavs.ts` 按音节时间轴合成，无需携带二进制。

示例跟读课《南方方言入门 · 第1课》编排了 3 句已取得课程级授权的素材
（粤语/吴语/闽南语，每句跟读 3 遍 + 教练提示）；**成都话是 research 授权，
不会出现在任何课程或学员/教练的可下载集合中**。

## 四、启动手机端

```bash
cd apps/mobile
npm start            # Expo Dev Server；模拟器按 i / a，真机装 Expo Go 扫码
```

- **Android 模拟器**：API 地址保持默认 `http://10.0.2.2:3000/api`
  （模拟器内 10.0.2.2 指向宿主机；当前默认值是 127.0.0.1，请在 App「同步」页改成 10.0.2.2）。
- **iOS 模拟器**：`http://127.0.0.1:3000/api` 直连。
- **真机**：在「同步」页填电脑局域网 IP，如 `http://192.168.1.10:3000/api`。

离线流程：断网也可以建档、授权、连续录音（录完即本地加密）、标注、编课、跟读；
所有变更进 outbox。联网后在「同步」页一键 **推送元数据 → 补传录音 → 增量拉取**；
分叉时弹出冲突卡片，可选「采用服务端」或「强制保留本机」。

## 五、安全模型

1. **端侧**：录音停止瞬间用 AES-256-CBC（PBKDF2 10k 轮、每文件独立盐/IV）加密成
   `DENC1` 容器，明文文件立即删除；主密钥存 expo-secure-store（Keychain / Keystore）。
   - 试听：`decryptToTempFile()` 用正规 `CipherParams` 解密到 cache 临时文件播放，播完即删；
   - 同步上传：**先在端上解密成临时明文再 multipart 上传**（绝不直传 `DENC1` 容器，
     否则服务端/播放器会把密文当音频），传完删除临时文件。是否在服务端静态加密由服务端决定。
2. **服务端静态加密（落盘即密文，不依赖事后封口）**：新增统一判定
   `mustEncryptAtRest()`——只要素材**显式 sensitive** 或说话人当前**不可课程/公开分发**
   （`research` / `pending` / `revoked` / 说话人记录缺失），`attachFile()` 在文件
   **写入磁盘的瞬间**就输出 AES-256-GCM 密文（`*.wav.enc|*.m4a.enc`），明文从未落盘，
   因此不会进入备份或文件系统快照。这覆盖了「调查员给一个一开始就是 research 授权的
   说话人正常录音并同步」——该场景不发生授权状态迁移，事后封口本来不会触发。
   课程/公开授权的素材才以明文存储。
   密钥 =
   `SHA256(主密钥 || "media:v1:" || assetId)`，一录一密、可轮换；GCM 标签防篡改。
3. **授权闸门**：下载媒体时校验 `speaker.consentStatus` 与角色——
   `revoked` 仅 investigator/admin 可调档；`research`/`pending` 对教练与学员 403。
4. **撤回/收窄即真正封口加密**（`ConsentEnforcementService`，不只是改数据库状态）。
   所有能改 `consentStatus/consentScope` 的写通道共用同一个纯函数判定
   `consentTransition(before, after)`（`packages/shared/src/consent-transition.ts`），
   不存在“某个接口忘记封口”：
   - **通用 upsert**（`POST/PUT /speakers/:id`，现场建档/移动端编辑）、专门端点
     `/speakers/:id/revoke`、`/speakers/:id/consent`，以及 **sync push** 推来的状态变化，
     从可分发（granted+course/public）迁移到不可分发（revoked/pending/granted+research）
     时，都把名下**明文**媒体读入 → AES-256-GCM 加密为 `<id>.<ext>.enc` →
     **删除明文文件**，撤回/待签置 `restricted`（research 保留自身状态，分发由策略过滤）；
     新建即不可分发时（先录音后补授权）同样封口；
   - 操作幂等，已加密素材跳过；文件尚未上传时只封元数据；
     sync 通道在事务提交后做文件封口（避免脏读），并用保存前快照判断状态变化；
   - **启动自愈**：`ConsentEnforcementService.onModuleInit()` 调
     `reconcileAllAssets()` 扫描全部素材，把旧版本遗留在磁盘上的不可分发明文
     （如旧版给 research 说话人录的明文）在服务启动时批量改为密文，幂等；
   - `/revoke` 接口返回 `_sealedFiles`（本次新加密文件数）；
   - 迁移回 course/public 时元数据恢复可分发，文件**保留加密**（下载时按 keyVersion 内存解密）；
   - 种子数据中 research 范围的成都话以 `.wav.enc` 落盘，与待签/撤回素材一致。
5. **撤回联动**：撤回授权后名下素材在两端置 restricted；学员端列表和同步拉取都会过滤。
6. **练习数据归属**：学员只能读写本人的跟读与收到的批注（见第六节「学员练习数据的归属与隔离」），
   归属以 JWT 登录身份为准，知道他人 attempt id 也无法覆盖录音或读到评语。
7. **录音格式**：iOS 录 `LINEARPCM/wav`，Android 录 `AAC/m4a`；MIME 随元数据
   （`AudioAsset.mime` / `PracticeAttempt.mime`）贯穿同步、上传、落盘扩展名与下载
   `Content-Type`，播放器按真实格式解码，不会出现把 m4a 当 wav 或把密文当音频的问题。
8. **存储路径不可被客户端控制（防任意文件读取）**：
   - 媒体落盘路径（`audio/<id>.<wav|m4a>[.enc]`、`attempts/<id>.<wav|m4a>.enc`）
     **永远只由服务端**的上传接口生成；`filePath`、`keyVersion` 不在元数据编辑接口
     （`PUT /audio/:id`）和同步 push 白名单的可写字段里，教练/学员在请求体里携带的值一律忽略；
   - 读取时再过一遍 `resolveWithinStorage()`：相对路径必须匹配严格白名单正则，
     解析结果必须位于存储根目录内，`../../`、绝对路径、空字节等一律拒绝
     （`apps/api/src/media/path-guard.ts`）——即使数据库被污染也读不到 uploads 之外的文件；
   - `sensitive` 对教练只读（不可把受限录音自行降级为公开），staff 也只能升级不能降级。
   这样持教练 token 无法借元数据编辑 + 下载接口读取 `.env`、源码或密钥文件。

## 六、同步协议（版本合并）

所有实体带 `id(客户端 UUID) / version / deviceId / updatedAt / deletedAt(软删墓碑)`。

- `GET /api/sync/pull?cursor=<ISO>`：以**服务端提交时间** `serverUpdatedAt`（只由
  服务端盖章，DTO 里不暴露、客户端无法注入）为游标返回其后的全部实体（含墓碑）。
- `POST /api/sync/push`：单事务内逐条走 `mergeRecord`：
  - `baseVersion == server.version` → 快进，version+1（无内容变化则不提版本）；
  - `baseVersion < server.version`（两端都改）→ 比较 `updatedAt`，新者胜（LWW），
    旧者返回 `version_conflict`；
  - 服务端已删 → `deleted` 冲突，普通同步不能复活。
- 推送按角色限制（学员不能推 speakers/课程，教练不能推 speakers 等）。

**时间戳不可被客户端毒化**（防"未来游标"攻击）：

- 游标只认服务端时钟：实体新增 `serverUpdatedAt`，由 TypeORM 订阅器
  `TimestampSubscriber` 在任何 insert/update 强制盖章（QueryBuilder 软删路径显式盖章），
  客户端推送 2999 年的记录也不会抬高任何人的游标；
- 客户端时间一律入口钳制 `sanitizeClientTime()`：超过服务器时钟 +5 分钟（容差）的未来
  时间钳到 `now+skew`，无法解析/异常早的时间退化为 now——`updatedAt`（LWW）、
  `recordedAt`、`createdAt`、`consentSignedAt` 全部覆盖，REST 与 sync 两个通道都做；
- pull 对入站游标同样钳到 `now+skew`，已被旧版本毒化（持未来游标）的设备下一次同步即自愈；
- 移动端本地盖戳也调用同一清洗函数，设备时钟被拨快时自己产生的记录也不会进 outbox 毒化。
  纯函数与测试见 `packages/shared/src/time-sanitize.ts`。

**未推送的本地编辑绝不被 pull 覆盖**（移动端三道保证，`apps/mobile/src/store.ts` / `sync.ts`）：

1. `applyPull` 以 outbox 中待推送的 `(bucket,id)` 集合做保护：这些记录即使被增量
   结果（含远端更新或墓碑）命中也原样保留；只有推送成功、条目移出 outbox 后，下一次
   pull 才会把本地收敛到服务端版本。
2. `baseVersion` 锁定为「上次与服务器同步时」的版本：同一记录连续离线编辑多次，
   outbox 始终只有一条且 `baseVersion` 不随本地自增 version 漂移（避免本地新建记录
   被误判为 `deleted` 冲突、或已同步记录被误判成分叉）。
3. push 返回冲突时**不**用服务端版本立即覆盖本地表：离线编辑继续可见可改，冲突挂在
   「同步」页（冲突列表已持久化，重启不丢），由用户裁决——「采用服务端」才丢弃本地
   版本（服务端已删则本地一并删除）；「保留本机」以服务端当前版本为基线强推，成功后
   版本号跟到 `server+1`。

服务端在接受一次同步写入时保留客户端的 `updatedAt`（编辑实际发生时间）随记录传播，
LWW 比较的才是真实编辑先后而非收货时间；仅当客户端缺时间戳时才退回服务器时钟。

回归测试：`apps/mobile/src/store.test.ts`（8 例，可把守卫改回旧实现复现 3 例失败）、
`src/sync.test.ts`（4 例冲突裁决），随 `npm test` 一起运行。

### 知情同意使用范围（consent scope）

`consentScope` 不是标签，而是在所有分发通道强制执行（纯函数策略
`packages/shared/src/consent-policy.ts`，前后端共用）：

| scope | 调查员/管理员 | 教练 | 学员 |
|---|---|---|---|
| `research` 仅研究 | ✅ 研究/归档 | ❌ 下载/列表/同步 | ❌ 下载/列表/同步 |
| `course` 跟读课 | ✅ | ✅ 编课/播放 | ✅ 练习 |
| `public` 公开 | ✅ | ✅ | ✅ |
| `pending` / `revoked` | 仅 staff | ❌ | ❌ |

强制点（绕过任一个都会被下一个挡住）：

1. `GET /audio/:id/file` 媒体下载闸门：research 对教练/学员返回 403；
2. `GET /audio` 列表与 `/sync/pull` 的 `audio`：非 staff 不下发 research/pending/revoked；
3. 课程保存 `POST/PUT /courses` 与发布 `/courses/:id/publish`：引用 research 等越界素材
   直接 403，先校验后写库，不产生半截数据；
4. `/sync/push` 的 `courseItems`：引用越界素材抛 403，整个事务回滚；
5. 学员视角的课程列表/详情/`courseItems` 同步：过滤掉越界课目（防止历史脏数据）；
6. 移动端课程编排页只列出 `canUseInCourse` 的素材。

扩大使用范围（例如把 research 素材用于课程）必须先让发音人重新签署 course/public
授权（`POST /speakers/:id/consent`），系统不提供任何“管理员特批进课”的旁路。

### 学员练习数据的归属与隔离

跟读练习属于学员个人隐私（声音+评语），所有通道都以 **JWT 里的登录身份**为准，
请求体里的 `studentId` 一律不可信：

| 通道 | 规则 |
|---|---|
| `GET /sync/pull`（学员） | `attempts` 只下发本人提交；`annotations` 只下发挂在本人 attempt 上的批注（增量游标同样过滤） |
| `POST /sync/push`（学员） | 服务端把 `studentId` 强制改写为登录账号；覆盖已有记录但归属不是本人 → 403，整事务回滚 |
| `POST /practice/attempts` | 新建允许；用他人已存在的 attempt id 提交 → 403；落库 `studentId` 取 token |
| `POST /practice/attempts/:id/file` | 学员只能给本人 attempt 上传/重录；持他人 id 覆盖 → 403（且文件不会被写） |
| `GET /practice/attempts/:id/file` | 学员只能下载本人录音；教练/管理员可读全部用于批注 |
| `GET /practice/attempts/:id/annotations` | 学员只能读本人 attempt 的批注，遍历他人 id → 403 |
| 移动端 | 同步服务端已过滤；课程页再按 `studentId === me.id` 兜底过滤，双保险 |

教练/管理员角色不受归属过滤（需要听全班跟读、写批注）；`speakers/courses` 等其他桶的
角色闸门不变。相关用例见 `apps/api/test/integration.test.ts`（练习归属/越权上传/
拉取隔离/伪造 studentId 共 6 例）。

## 七、测试

```bash
npm test   # shared 31 例 + api 37 例 + mobile 19 例，共 87 例
```

API 测试使用临时 sql.js 库，无需 MySQL。关键用例：
- AES-GCM 往返、篡改密文被认证标签识破、错误 assetId 无法解密；
- pending/revoked/research 授权下教练与学员读取媒体 403、调查员读到解密 RIFF；
- research 素材在列表、同步、下载三通道对教练/学员不可见；
- research 素材编入课程在 REST 与 sync 双通道 403；混合脏数据课程对学员过滤；
- 教练注入 `filePath=../../.env`（相对/绝对路径）无法写库、下载仍返回原音频；
  DB 被直接写入穿越路径时读取守卫抛错；教练不能降级敏感素材；
- 未来时间戳（2999 年）被钳制、全服游标不跳未来、持未来游标的设备下次同步自愈、
  毒记录之后的正常数据仍能用旧游标拉到、未来版无法在 LWW 中永远压过合法编辑；
- 给一开始就是 research/pending/revoked 的说话人新录音：上传瞬间即 GCM 密文，
  磁盘从无明文窗口；course/public 素材仍明文；启动自愈把历史 research 明文批量封口；
- 撤回/收窄授权的所有写通道（通用 upsert、/revoke、/consent、sync push）共用
  consentTransition 判定，无一遗漏；调查员解密可读、学员/教练 403；重新授权后
  恢复可分发且文件保留加密；research 播种即加密；
- 离线推送新建 → 拉取可见；旧基线推送产生 `version_conflict`；
- 课程整课保存后移除条目被软删；
- 学员 A/B 互改 attempt、互传录音、互看批注、全量同步互相可见性全部按身份隔离；
- 伪造请求体 `studentId` 落库仍为登录账号；
- 端侧 `DENC1` 容器 seal/open 往返、容器损坏拒绝、明文不落盘；
- 同步上传走“先解密后上传”（断言 multipart 拿到的是明文临时文件而非 `.enc`）；
- m4a/wav 跟读按真实 MIME 存盘并以对应 `Content-Type` 解密返回。

## 八、主要 HTTP 接口（均需 `Authorization: Bearer <token>`，前缀 /api）

```
POST /auth/login                 GET /auth/me
GET/POST/PUT/DELETE /speakers[/:id]      POST /speakers/:id/consent | /revoke
GET/POST/PUT/DELETE /audio[/:id]
POST /audio/:id/file (multipart)         GET  /audio/:id/file   (按授权解密)
GET/POST/PUT/DELETE /courses             POST /courses/:id/publish
POST /practice/attempts                  POST /practice/attempts/:id/file
GET  /practice/attempts                  POST /practice/attempts/:id/annotations
GET  /sync/pull?cursor=ISO               POST /sync/push
```

快速手测：

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"student1","password":"demo1234"}' | jq -r .token)
curl -s localhost:3000/api/audio -H "Authorization: Bearer $TOKEN" | jq 'length'   # 4（受限2条被过滤）
curl -s -o /dev/null -w '%{http_code}\n' \
  localhost:3000/api/audio/aud-hsn-changsha-locked/file -H "Authorization: Bearer $TOKEN"  # 403
```
