# Multi Metric Mixer

LLMチャットとノードエディタから、データ取得・絞り込み・計算・結合・集計・並べ替え・プレビュー・CSV出力のWorkflowを作成・実行するアプリケーションです。

## ローカルで起動する

必要なものはNode.js 24以上とDocker Compose v2です。

```bash
npm ci
npm run local
```

`npm run local`は、ローカル用のKeycloak、PostgreSQL、MongoDBをDockerで起動し、続けてUI、BFF、Backend serverを開発モードで起動します。

UIはOIDC callbackとBFFのOrigin制約に合わせて`5173`固定です。すでに別processが`5173`を使用している場合は`5174`へ自動変更せず、どのportが競合したかを表示して停止します。古い開発processを終了してから再実行してください。

ブラウザで [http://localhost:5173](http://localhost:5173) を開き、用途に応じたユーザーでログインします。どちらもWorkflow、ノードUI、実行、出力を利用できます。

| 権限 | ユーザー名 | パスワード | 追加機能 |
| --- | --- | --- | --- |
| 管理者 | `admin@example.com` | `local-password` | データソース管理、Workspace正本Catalogの公開 |
| 一般ユーザー | `alice@example.com` | `local-password` | 自分用Catalogの編集・探索・リセット |

最短でデータを確認するには、管理者でログインして左側の「Data Catalog」を開き、`local-sales`を選んで「Agentで探索」を押します。13 fieldsが自分用Catalogへ入り、ノードエディタで集計ノードを追加すると`category`や`amount`を選択できます。内容をWorkspace全員の基準にする場合だけ「正本へ反映」を押してください。

終了後もDockerサービスは動作するため、不要になったら停止します。

```bash
npm run local:down
```

ローカル固有の設定とDocker定義はすべて [`local/`](local/) にあります。アプリ独自の簡易ログインや認証fallbackは使わず、KeycloakでもOIDC Authorization Code + PKCEとBFF sessionを通します。

## OpenAI互換APIを後から接続する

モデルAPIが未設定でもアプリとチャット画面は起動します。チャットを送信すると分析エージェントを現在利用できない旨を返し、疑似的な回答やWorkflowを生成しません。ノードエディタ、Workflow管理、データソース管理、既存Workflowの実行は引き続き利用できます。

`/v1/chat/completions`と`response_format.type=json_schema`に対応するOpenAI互換APIを利用できるようになったら、次の手順で接続します。接続先はLM Studio、社内model gateway、外部のOpenAI互換serviceなどを問いません。

1. endpointのbase URL、model identifier、必要ならAPI keyを確認します。
2. [`local/app.env`](local/app.env)を次のように変更します。

```dotenv
AGENT_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=https://model-gateway.example.com/v1
OPENAI_COMPATIBLE_MODEL=確認したmodel identifier
OPENAI_COMPATIBLE_API_KEY=必要な場合だけ設定
OPENAI_COMPATIBLE_TIMEOUT_MS=60000
OPENAI_COMPATIBLE_MAX_TOKENS=8192
OPENAI_COMPATIBLE_CONTEXT_WINDOW_TOKENS=32768
# OPENAI_COMPATIBLE_REASONING_EFFORT=medium
```

3. アプリを再起動します。envファイルの変更は起動中のBFFへ自動反映されません。

```bash
# 起動中の npm run local を Ctrl+C で終了してから
npm run local
```

チャットに分析エージェントを利用できない旨が表示された場合は、BFF起動時の`agentProvider`と`agentModel`、request errorの`code`を確認してください。そのうえでendpointが起動していること、`OPENAI_COMPATIBLE_BASE_URL`の末尾がAPIのversion path（通常は`/v1`）であること、`OPENAI_COMPATIBLE_MODEL`が`GET /v1/models`に含まれることを確認します。一般利用者向け画面やBrowser APIにはprovider、model、endpoint、transport設定を返しません。

### macOSからLAN内のモデルAPIへ接続できない場合

macOSでは、`192.168.x.x`などLAN内のendpointへ接続するアプリごとに「ローカルネットワーク」権限が必要です。`npm run local`をVS Codeのterminalで実行する場合はVS Codeに、Terminal.appやiTerm2で実行する場合はそのterminalアプリに許可してください。

1. macOSの「システム設定」を開きます。
2. 「プライバシーとセキュリティ」→「ローカルネットワーク」を開きます。
3. `npm run local`を実行しているアプリ（例: Visual Studio Code）を許可します。
4. 対象アプリと`npm run local`をいったん終了し、起動し直します。

権限がない場合でも、macOSが許可ダイアログや明確なエラーを表示せず、アプリ側には単なる接続失敗として見えることがあります。また、通常のterminalから`curl`が成功しても、VS Codeのterminalから起動したNode.jsに権限があることの確認にはなりません。必ず`npm run local`を実行するのと同じアプリから疎通を確認してください。`127.0.0.1`上のモデルAPIにはこのLAN権限は通常関係しません。

BFFは互換APIへserver-sideから接続し、厳格なJSON Schemaで確認質問またはWorkflow提案を要求します。Browserからmodel endpointへ直接接続せず、Data sourceのcredentialも送信しません。

ローカルの平文HTTP接続は既定で`localhost`、`127.0.0.1`、`::1`だけを許可します。別端末やmodel gatewayへ接続する場合はHTTPS endpointを使用してください。

HTTPSを用意できない環境では、次の明示承認フラグでloopback以外のHTTP endpointへの接続を許可できます。hostname、IPv4、IPv6を区別しないため、LAN内DNSで解決するhostnameも利用できます。Workflow、Catalog metadata、将来の結果要約が暗号化されずネットワークへ流れるため、接続先を運用者が信頼できる場合に限り使用し、本番ではHTTPSへ切り替えてください。

```dotenv
OPENAI_COMPATIBLE_BASE_URL=http://192.168.1.252:1234/v1
OPENAI_COMPATIBLE_ALLOW_INSECURE_HTTP=true
```

LM Studioを使う場合もprovider種別は同じです。たとえばLocal Serverを`127.0.0.1:1234`で起動した場合は、`OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1`を指定します。製品名をアプリ設定へ持ち込まず、互換APIとして扱います。

互換serviceごとにstructured outputの対応範囲やmodel identifierが異なるため、接続後は[release verification](docs/version-1-release-verification.md)に従い、確認質問とWorkflow提案が返ることを検証してください。

reasoning modelがJSONを返す前に出力上限へ達した場合、一般利用者には依頼を分けて再試行するよう表示し、運用者はBFF logの`agent_provider_output_limit`で判別できます。利用中のserviceとmodelが許容する範囲で`OPENAI_COMPATIBLE_MAX_TOKENS`を増やしてください（アプリ上限は`32768`）。単純な疎通だけでなく、Catalog付きのWorkflow提案が最後まで返ることを確認します。

OpenAI互換APIが`finish_reason=stop`と推論用fieldを返していても、最終回答の`message.content`が空なら正常応答ではありません。本アプリは推論用fieldを最終回答として代用せず、応答不正としてfail-closedにします。LM Studio内蔵チャットはOpenAI互換`/v1/chat/completions`と異なる処理経路を使う場合があるため、内蔵チャットの表示だけでなく、実際に設定するendpointへ同じmodel、structured output、tool callを送って`message.content`を確認してください。

`OPENAI_COMPATIBLE_CONTEXT_WINDOW_TOKENS`にはAPI側の入力・出力合計上限を設定します。アプリは最大出力分を先に確保し、残りへ会話、Workflow、Catalogを収めます。長い履歴は古いものから除外し、WorkflowとCatalog自体が収まらない場合はAPIへ送らず明示エラーにします。

`OPENAI_COMPATIBLE_REASONING_EFFORT`は、対応するmodel/APIについて推論量と応答時間のバランスを調整する任意設定です。指定できる値は`none`、`minimal`、`low`、`medium`、`high`、`xhigh`です。未設定なら`reasoning_effort`をAPIへ送らず、接続先の既定値を使います。対応値はmodelごとに異なるため、接続先が明示的に対応する値だけを指定してください。この設定は推論用fieldを最終回答へ転用するものではなく、アプリは引き続き`message.content`だけを最終回答として扱います。

チャット画面はmodel応答をstreamで受け取り、生成中の出力token数、本文文字数、推論文字数、経過時間を「モデル生成状況」に表示します。providerがstream中のusageを返さない場合、token数には「約」を付けてUTF-8 byte数からの推定値を表示します。Agent応答が不正な場合は、error code、request ID、`finish_reason`、usage、最終`message.content`の最大4,000文字を「エラー詳細を表示」から確認できます。`reasoning_content`本文、credential、request header、tool引数はBrowserへ返しません。

## 外部OIDC Providerで開発する

Cognitoまたは別のOIDC Providerを使う場合だけ、`.env.example`をコピーして接続情報を設定します。

```bash
cp .env.example .env
npm run dev
```

OIDC Providerには`http://localhost:5173/auth/callback`をcallback URL、`http://localhost:5173/`をsign-out後のURLとして登録してください。少なくとも次の値を変更します。

- `AUTH_PROVIDER_KEY`
- `AUTH_PROVIDER_LABEL`
- `OIDC_ISSUER`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`（confidential clientの場合）
- `OIDC_ADMIN_GROUP`（管理者として扱うOIDC groupの完全一致名）
- `OIDC_LOGOUT_MODE`（標準OIDCは`oidc`、Cognito Managed Loginは`cognito`）
- `OIDC_LOGOUT_USE_ID_TOKEN_HINT`（標準OIDCでは既定`true`。ローカルKeycloakの再作成後にも安全にログアウトできるよう、`npm run local`では`false`）
- `OIDC_LOGOUT_ENDPOINT`（Cognitoの場合だけ、Managed Login domainの`/logout`）
- `SESSION_SECRET`
- `AUTH_TRANSACTION_SECRET`

## コマンド

公開しているnpm scriptは次の7つだけです。

| コマンド | 用途 |
| --- | --- |
| `npm run local` | Keycloak・DB・UI・BFF・Backendをまとめてローカル起動 |
| `npm run local:down` | ローカルのDockerサービスを停止 |
| `npm run dev` | `.env`を使ってUI・BFF・Backendをwatch起動 |
| `npm test` | 全テストを実行 |
| `npm run check` | TypeScript検査と全テストを実行 |
| `npm run build` | UI、BFF、Backendのproduction artifactを生成 |
| `npm run verify` | `check`、`build`、成果物境界検査、BFF／Backend別process smokeを実行 |

起動するprocessは常に次の3つです。

| Process | 開発時URL | 役割 |
| --- | --- | --- |
| Vite UI | `http://localhost:5173` | ブラウザUI |
| Hono BFF | `http://localhost:3000` | OIDC/session、Browser API、Agent/LLM、Conversation、Backend client |
| Backend server | `http://127.0.0.1:3001` | MCP/API Adapter、Backend Core。BFFだけが利用するloopback listener |

BFFの稼働確認は`/health`、Backend到達性を含む準備完了確認は`/ready`です。Backendは`/mcp`と`/internal/api`を同じloopback listenerで提供します。Data source接続の登録・変更・test・archiveはInternal APIだけにあり、MCP toolとして公開されません。

通常の分析画面へ渡すData source情報は、名前、形式、version、安全な検索パターン入力などのcapabilityに限定されます。URL、table、collection、log groupなどの編集用定義は管理者が「データソース管理」を開いたときだけ取得し、DB/MongoDBの接続URI、driver、TLS、denylistは管理画面にも返しません。画面からの保存・接続test・手動Catalog探索・Workflow実行はInternal API、Agentが会話中に選ぶ探索・sample・分析操作はMCPを使います。

localの永続化も共有DBではありません。BFFのidentity/session/Conversationは`.data/bff-v1.sqlite`、BackendのData source/Catalog/Workflow/Run/Artifact metadataは`.data/backend-v1.sqlite`へ保存されます。BFFはBackend DBを直接参照せず、Ed25519署名付き短期Bearer access tokenでBackendを呼び出します。同じtokenは期限内の複数requestで利用でき、`BACKEND_TOKEN_TTL_SECONDS`は既定300秒、local評価では3600秒です。productionでは許容するsession・membership失効反映時間に合わせて短く設定し、BFFへprivate key、Backendへpublic keyだけを配置します。

## ローカルのデータソースを試す

`npm run local`でPostgreSQLとMongoDBも起動し、読み取り専用ユーザーとサンプルデータを自動作成します。[`local/connection-profiles.json`](local/connection-profiles.json)にサーバー側の接続URIを直接定義し、起動時に所有者だけが読める`.data/local-connection-profiles.json`へコピーします。ブラウザへURI、driver、credential、denylistは返しません。管理画面には「表形式DB A」「JSONライクDB C」のような論理名だけを表示し、管理者は接続先とテーブルまたはコレクションを登録します。

### PostgreSQLを登録する

1. [http://localhost:5173](http://localhost:5173)を開き、管理者の`admin@example.com` / `local-password`でログインします。
2. 左側の「データソース管理」を開き、「表形式DB」を選択します。
3. 次の値を入力して「接続を登録」を押します。

| 項目 | 入力値 |
| --- | --- |
| 接続ID | `local-sales` |
| 表示名 | `Local Sales` |
| 接続先 | `表形式DB A` |
| Schema | `public` |
| Table | `sales` |
| 最大行数 | `1000` |

登録済み接続の「接続テスト」を押すと読み取り確認ができます。初期データは[`local/postgres/init.sql`](local/postgres/init.sql)にあり、地域、商品、顧客区分、販売経路、状態、割引、担当者、日時を含む13列・30行です。

### MongoDBを登録する

1. 同じ「データソース管理」で「JSONライクDB」を選択します。
2. 次の値を入力して「接続を登録」を押します。

| 項目 | 入力値 |
| --- | --- |
| 接続ID | `local-events` |
| 表示名 | `Local Events` |
| 接続先 | `JSONライクDB C` |
| Database | `metrics` |
| Collection | `events` |
| 最大document数 | `1000` |

こちらも「接続テスト」で読み取り確認ができます。初期データは[`local/mongodb/init.js`](local/mongodb/init.js)にあり、任意項目、配列、ネストした`context`や`campaign`を含む18件のeventです。可変スキーマの探索確認に利用できます。

### 複数データソースの結合を試す

同じJSONライクDB接続で、次の安定した地域マスタも登録できます。

| 項目 | 入力値 |
| --- | --- |
| 接続ID | `local-regions` |
| 表示名 | `Local Regions` |
| 接続先 | `JSONライクDB C` |
| Database | `metrics` |
| Collection | `regions` |
| 最大document数 | `1000` |

`local-sales.region_id`と`local-regions.regionId`を結合すると、地域名ごとの売上合計など、SQLとMongoDBをまたぐWorkflowを確認できます。

登録後は「Data Catalog」を開き、対象接続で「Agentで探索」を押します。探索結果はまず現在の利用者の「自分用」へ保存され、正本を暗黙に変更しません。管理者は内容を確認して「正本へ反映」でき、一般ユーザーは自分用の説明を編集したり「正本へ戻す」でリセットしたりできます。

データ取得ノードを追加または選択して、接続先に`Local Sales`か`Local Events`を指定します。絞り込み・列選択、計算列、データ結合、集計、複数データ集計、並べ替え・件数ノードでは、有効なCatalog（自分用があれば自分用、なければWorkspace正本）からfield候補が表示されます。その後にプレビューノードやCSV出力ノードへ接続し、右上の「実行」から結果を確認できます。一般ユーザーは接続設定を変更できませんが、管理者が登録した接続をWorkflowで利用できます。

ローカルDBはホスト側の`127.0.0.1:5433`（PostgreSQL）と`127.0.0.1:27017`（MongoDB）だけに公開され、アプリからは読み取り専用の`mmm_reader`を使用します。接続プロファイルの`deniedDatasets`は`schema.table`または`database.collection`を完全一致か`namespace.*`で拒否する補助防御です。最終的な安全境界はDB側の読み取り専用credentialと権限です。接続できない場合はDocker Desktopが起動していることを確認し、次のコマンドでコンテナと初期データを作り直してください。

```bash
npm run local:down
npm run local
```

Cognitoでは`cognito:groups`、ローカルKeycloakでは`groups` claimを読み、`OIDC_ADMIN_GROUP`と完全一致するgroupを持つユーザーだけを管理者とします。画面だけでなく、登録・編集・接続テスト・アーカイブ・JSON／CSV登録APIも同じ権限で拒否します。

JSON／CSVは接続登録画面からファイルをアップロードします。

### 大規模データソースの検索パターン

CloudWatch Logsは「取得方式」を「検索パターン必須」にすると、無条件の先頭N件取得を禁止できます。管理者はデータソース管理で複数のLogs Insightsパターンを追加し、開始日時、終了日時、自由入力、数値、プルダウンの変数と必須条件を設定します。query内では追加変数を`{{variableId}}`で参照します。

一般利用者とAgentにはquery本文を表示せず、ノード設定には管理者が定義した入力欄だけを表示します。WorkflowにはData source version、パターンID、入力値だけを保存します。プルダウン外の値、未知の変数、最大検索期間を超える入力はBackendで拒否されます。

REST APIの独立サンプルは必要な場合だけ別terminalで起動します。

```bash
npm --prefix samples/mock-rest-api start
```

Base URLは`http://127.0.0.1:3100`、Pathは`/patterns/mixed`、Methodは`GET`です。詳細は[サンプルREST API](samples/mock-rest-api/README.md)を参照してください。

## Production

ProductionではBFFとBackendを別processとして起動するため、単一の`npm start`は設けていません。`npm run build`で生成した次のentrypointを、systemdなどのprocess managerから個別に起動します。

```text
node dist/server/bff.mjs
node dist/server/backend.mjs
```

現在の対応構成と設定方法は[EC2 production profile](deploy/ec2/README.md)を参照してください。リリース前は`npm run verify`を実行します。

## 関連ドキュメント

| 内容 | ドキュメント |
| --- | --- |
| ユーザー体験と機能要件 | [Product design](docs/product-design.md) |
| BFF・Backend・MCP/API Adapter・認証・データ境界 | [Architecture](docs/architecture.md) |
| 永続化スキーマ | [Database schema](docs/database-schema.md) |
| Version 1.0の実装対応 | [Acceptance matrix](docs/version-1-acceptance.md) |
| AWSでの確認項目 | [Release verification](docs/version-1-release-verification.md) |
| 脅威と対策 | [Threat model](multi-metric-mixer-threat-model.md) |
