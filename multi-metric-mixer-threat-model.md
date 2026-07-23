# Multi Metric Mixer Threat Model

> Status: Version 1 implementation-aligned review  
> Reviewed: 2026-07-24  
> Related: [Product design](docs/product-design.md) / [Architecture](docs/architecture.md) / [Database schema](docs/database-schema.md) / [Acceptance](docs/version-1-acceptance.md)

## Summary

主要riskは、公開BFFまたは同一host processによるBackend迂回、Workspace越境、接続管理機能のMCP露出、Capability窃取/replay、REST SSRF、untrusted dataからのaction drift、巨大source/upload/joinによる枯渇である。

Version 1は、別process/DBのBFFとBackend、loopback bind、request単位の署名付き短期Capability、MCP/API Adapter分離、API-only接続管理、read-only connector、隔離parser、action-bound Approval、永続監査を同時に適用する。データ分類が低くてもbaselineを弱めず、外部データ更新toolは実装しない。

## Scope and assumptions

- Public surface: `src/client`と`src/bff`。BrowserはALB/HTTPS経由でBFFだけへ到達する。
- Internal surface: `src/backend-server`は同一instanceの`127.0.0.1`専用listenerで、`/mcp`と`/internal/api`を提供する。
- Shared business core: `src/backend-core`はlistener、OIDC/session、LLM、Data source connection CUDを持たない。
- Persistence: BFF DBとBackend DBは別credentialで、cross-query/foreign keyを持たない。
- Production profile: 単一EC2、別systemd unit、RDS PostgreSQL×2 logical boundary、S3 SSE-KMS、Secrets Manager、Cognito。
- External systems: OIDC IdP、OpenAI互換LLM、登録済みREST/DynamoDB/CloudWatch Logs/SQL/MongoDB、upload。
- LLM出力、chat、Workflow import、source/upload値はすべてuntrustedである。

host/container、IdP、AWS account administratorが完全に侵害された後の機密性はapplication Capabilityだけでは保証しない。単一EC2のinstance roleとkernelは共通host boundaryであり、最小権限IAM、OS user/env file分離、KMS、backup、credential rotation、host hardeningを別に適用する。

## Trust boundaries

| Boundary | Required control | Evidence |
| --- | --- | --- |
| Browser → BFF | OIDC Code+PKCE、opaque HttpOnly session、rotation、CSRF、exact Origin、membership | `src/bff/auth`, `src/bff/app.ts` |
| BFF → Backend | loopback、exact Host/Origin、Ed25519 Capability、5–60秒TTL、action/input/scope binding、一回消費 | `src/shared/backend-capability.ts`, `src/bff/internal-*client.ts` |
| BFF DB ↔ Backend DB | 共有なし、別driver/secret、opaque IDだけ | `src/bff/persistence`, `src/backend-core/persistence`, boundary tests |
| MCP Adapter → Core | 型付きread/profile/transform/workflow toolだけ | `src/backend-server/mcp-adapter.ts` |
| API Adapter → connection admin | `admin` + `connections:admin` scope、MCP依存graphから不可視 | `src/backend-server/api-adapter.ts`, `data-source-admin-service.ts` |
| Backend → source | 登録ID、GET/read allowlist、SSRF防御、read-only credential/IAM | `src/backend-core/connectors`, `deploy/ec2/iam-policy.json` |
| source/file → Artifact | untrusted label、parser limit、immutable content、checksum/provenance | `src/backend-core/upload-*`, `persistence/artifact-repository.ts` |
| user → export | 構造化確認、Workflow/content/output binding、一回消費 | `src/bff/approval-service.ts` |

## Assets and attacker capabilities

保護対象はBFF session、OIDC transaction、Principal/Workspace membership、admin role、Capability signing key、接続定義/secret locator、Workflow/Catalog version、Approval、source data/Artifact、audit/provenance、compute/storage quota、build artifactである。

攻撃者はInternet client、正規の低権限member、悪意あるWorkflow共有者、REST/upload提供者になり得る。URL、redirect、DNS、巨大/深いJSON、危険なkey/CSV cell、prompt風文字列、改ざんCapabilityを制御できる。一方、初期状態でhost、IdP、Secrets Manager、DB administrator権限は持たず、任意command/SQL/filesystem path/外部writeを実行できない。

## Abuse cases

| ID | Abuse path / impact | Control | Residual risk |
| --- | --- | --- | --- |
| TM-001 | Backend port公開またはlocal processがBFFを迂回する | separate entrypoint/process、`127.0.0.1`、public routeなし、Host/Origin/Capability検証 | host compromiseには無効。network driftを監視する |
| TM-002 | BFFとBackendがDBを共有し、BFF session権限またはBackend dataへ横断する | 別DB class/file/secret、dependency closure/table negative test、cross-DB FKなし | EC2 instance role/kernelは共通host boundary |
| TM-003 | Capabilityを改ざん・別actionへ転用・replayする | Ed25519署名、issuer/audience/key ID、input hash/scope/action/Workflow/Approval binding、短期TTL、one-use `jti` | 複数active Backend前にdistributed replay storeが必要 |
| TM-004 | LLM/一般利用者が接続先を追加・変更する | connection CUDはAPI Adapter専用、admin role + scope、MCP tool/Backend Coreへ非公開、dependency negative test | IdP group管理を限定し、role変更後sessionを失効する |
| TM-005 | 推測IDで別Workspace resourceへアクセスする | Capability context由来Workspace、全repository predicate、tool inputにidentityを持たない | 共有role追加時はnegative testを拡張する |
| TM-006 | REST URL/redirect/DNSでmetadata/private networkへSSRFする | GET固定、scheme/host/IP class、redirect各hop、DNS pin、byte/timeout上限、egress policy | private host allowlist変更を監査する |
| TM-007 | source値をinstructionとしてAgentが権限/actionを変更する | untrusted metadata、text rendering、structured LLM output、Workflow/Catalog validation、proposal/apply分離 | 実modelのprompt-injection反復評価が必要 |
| TM-008 | Approvalを変更後Workflow/別出力へ再利用する | canonical action hash、Principal/Workspace/version/content/output binding、TTL、single consume | network failure後は再承認になる |
| TM-009 | malformed upload/importでparser DoSやforeign source実行を起こす | quarantine、worker memory/time、byte/depth/node/key/row/column/field limit、strict import Draft | malware scanはparser isolationの代替にしない |
| TM-010 | SQL/Mongo入力でinjection/write/credential漏えいを起こす | 任意query禁止、登録identifier、生成SELECT/find、limit、read-only user、TLS、Backend-only secret resolver | stagingでDB role/networkを検証する |
| TM-011 | CSV formulaがspreadsheetで実行される | spreadsheet modeでprefix neutralize、machine modeを分離表示 | machine CSVは値を保持する |
| TM-012 | response/join/同時Run/Artifactで資源を枯渇させる | body/source/depth/join/lease/quota/TTL/worker limit | 同期Runのcancelは未実装 |
| TM-013 | 開発用identityまたは弱いfallbackを本番利用する | provider明示、標準OIDC、独自credential loginなし、Keycloakも同adapter | 実Cognito key rotation/logoutをsmokeする |
| TM-014 | logへsecret/raw data/改行を混入する | redaction/allowlist/CRLF除去、本文/token/capability非保存 | immutable log sinkとalertは運用設定 |
| TM-015 | dependency/build改ざんでprocess roleを奪う | lockfile、MCP SDK、audit/SBOM、bundle boundary、read-only source policy | release artifact署名を運用する |

## Security invariants

1. Public BFFへ`/mcp`または`/internal/api`をmountせず、Backendをloopback以外へbindしない。
2. BFFとBackendはDB、database credential、repository dependencyを共有しない。
3. BFF private signing keyをBackendへ、OIDC/session/model secretをBackendへ渡さない。Backendはpublic verification keyだけを持つ。
4. Backend requestはCapabilityなし、署名不正、期限切れ、replay、action/scope/input/Workflow/Approval不一致を拒否する。
5. Principal、Workspace、role、assurance、credentialをBrowser/LLM/tool inputから受け取らない。
6. Data source connection CUD/test/archiveはInternal API Adapterの管理者操作だけに置き、MCPとBackend Coreへ公開しない。
7. Data source toolはlist/describe/read/profileだけとし、REST/AWS/SQL/Mongo credentialもread-onlyにする。
8. Source dataをinstruction、HTML、tool metadata、接続先、role、承認本文として使用しない。
9. Cookie、Capability、CSRF、OIDC/model token、secret、raw prompt、chain-of-thought、業務データ本文をauditへ保存しない。
10. 外部writeを追加する場合は通常機能追加でなく、product decisionとthreat model再設計を必須にする。

## Verification and re-review

`npm run check`は回帰testを、`npm run verify`はproduction build境界とBFF/Backend別process smokeを検査する。EC2 rolloutではBackend port非公開、別DB credential、key/env分離、RDS TLS、S3 KMS、read-only source policy、backup/restoreを確認する。

新connector、別host Backend、複数active instance、Workspace共有role、parser/retention変更、外部write提案時に再reviewする。

References: [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices), [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [OWASP Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html), [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html), [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
