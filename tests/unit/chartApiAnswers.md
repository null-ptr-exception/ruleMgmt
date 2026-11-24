# What chartApi.js gives its caller, for each kind of answer

Written by `tests/unit/chartApiAnswers.test.js`; do not edit by hand. Each
answer's body is in that test (`ANSWERS`). "200 with its body" answers
{"from":"server"}, or [{"from":"server"}] for a list.

## getUserInfo

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"user":null,"logoutUrl":null} |
| 409 naming a file | returns {"user":null,"logoutUrl":null} |
| 500 with a reason | returns {"user":null,"logoutUrl":null} |
| 504 HTML from a proxy | returns {"user":null,"logoutUrl":null} |
| network failure | returns {"user":null,"logoutUrl":null} |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/user`

## listCharts

| answer | the caller gets |
|---|---|
| 200 with its body | returns [{"from":"server"}] |
| 400 with field problems | returns [] |
| 409 naming a file | returns [] |
| 500 with a reason | returns [] |
| 504 HTML from a proxy | returns [] |
| network failure | returns [] |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/charts`

## createChart

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"failed":true,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"failed":true,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"failed":true,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"failed":true} |
| network failure | returns {"failed":true,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/charts (application/json) {"name":"c"}`

## deleteChart

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"failed":true,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"failed":true,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"failed":true,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"failed":true} |
| network failure | returns {"failed":true,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `DELETE /api/v2/charts/c`

## getChartInfo

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"failed":true,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"failed":true,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"failed":true,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"failed":true,"error":"the server answered 504"} |
| network failure | returns {"failed":true,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/templates/c`

## saveChartRules

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"invalid":true,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"failed":true,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"failed":true,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"failed":true} |
| network failure | returns {"failed":true,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/templates/c/rules (application/json) {"files":{"a.yaml":"groups: []"},"confirmBreaking":false}`

## migrationPreview

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"deployments":[]} |
| 409 naming a file | returns {"deployments":[]} |
| 500 with a reason | returns {"deployments":[]} |
| 504 HTML from a proxy | returns {"deployments":[]} |
| network failure | returns {"deployments":[]} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/templates/c/migration-preview (application/json) {"files":{"a.yaml":""},"migration":{"groups":{}}}`

## saveChartMeta

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false,"error":"the server answered 504"} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/templates/c/chart-meta (application/json) {"chartMeta":{"description":"d"}}`

## getDeployment

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"failed":true,"status":400,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"failed":true,"status":409,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"failed":true,"status":500,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"failed":true,"status":504,"error":"the server answered 504"} |
| network failure | returns {"failed":true,"status":0,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |
| 404 | returns {"failed":true,"status":404,"error":"No values for d"} |

Request: `GET /api/v2/deployments/c/d?folder=team%2Fd`

## saveDeployment

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false,"unknown":true,"error":"The server's answer could not be read, so whether the change was made is not known. Reload the page to see what the server has (and to sign in again, if asked)."} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | returns {"ok":false,"unknown":true,"error":"The server's answer could not be read, so whether the change was made is not known. Reload the page to see what the server has (and to sign in again, if asked)."} |
| 204 | returns {"ok":false,"unknown":true,"error":"The server's answer could not be read, so whether the change was made is not known. Reload the page to see what the server has (and to sign in again, if asked)."} |

Request: `POST /api/v2/deployments/c/d?folder=team%2Fd (application/json) {"values":{"cpu":[]},"version":"v1"}`

## deleteDeployment

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"error":"The values have 1 problem"} |
| 409 naming a file | returns {"error":"deployments/a/values.yaml cannot be read (permission denied)"} |
| 500 with a reason | returns {"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"error":"HTTP 504"} |
| network failure | returns {"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `DELETE /api/v2/deployments/c/d?folder=team%2Fd`

## getRouting

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"error":"The values have 1 problem"} |
| 409 naming a file | returns {"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"error":"Could not read routing"} |
| network failure | returns {"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |
| 404 | returns null |

Request: `GET /api/v2/deployments/c/d/routing?folder=team%2Fd`

## saveRouting

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `PUT /api/v2/deployments/c/d/routing?folder=team%2Fd (application/json) {"routing":"labels: {}"}`

## removeRouting

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `DELETE /api/v2/deployments/c/d/routing?folder=team%2Fd`

## getSharedConfigs

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"error":"The values have 1 problem"} |
| 409 naming a file | returns {"error":"deployments/a/values.yaml cannot be read (permission denied)"} |
| 500 with a reason | returns {"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"error":"Could not read the shared configs"} |
| network failure | returns {"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/routing/shared`

## saveSharedConfigs

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"ok":true,"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `PUT /api/v2/routing/shared (application/json) {"shared":{"configs":[]}}`

## renameSharedConfig

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"ok":true,"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/routing/shared/rename (application/json) {"from":"a","to":"b"}`

## regenerateShared

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"ok":true,"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml","unreadable":true} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/routing/shared/regenerate (application/json)`

## renderDeployment

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {} |
| 409 naming a file | returns {} |
| 500 with a reason | returns {} |
| 504 HTML from a proxy | returns {} |
| network failure | returns {} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/render/c/d?folder=team%2Fd (application/json) {}`

## getFolderTree

| answer | the caller gets |
|---|---|
| 200 with its body | returns [{"from":"server"}] |
| 400 with field problems | returns [] |
| 409 naming a file | returns [] |
| 500 with a reason | returns [] |
| 504 HTML from a proxy | returns [] |
| network failure | returns [] |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/folders/tree?path=team`

## listAllDeployments

| answer | the caller gets |
|---|---|
| 200 with its body | returns [{"from":"server"}] |
| 400 with field problems | returns [] |
| 409 naming a file | returns [] |
| 500 with a reason | returns [] |
| 504 HTML from a proxy | returns [] |
| network failure | returns [] |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/folders/deployments?chart=c`

## initDeploymentFolder

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"error":"The values have 1 problem"} |
| 409 naming a file | returns {"error":"deployments/a/values.yaml cannot be read (permission denied)"} |
| 500 with a reason | returns {"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"error":"Could not create the deployment (HTTP 504)"} |
| network failure | returns {"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/folders/init (application/json) {"folder":"team/d","chart":"c"}`

## getCommonPlan

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"error":"deployments/a/values.yaml cannot be read (permission denied)","problems":[]} |
| 500 with a reason | returns {"error":"Generation failed: boom","problems":[]} |
| 504 HTML from a proxy | returns {"error":"HTTP 504","problems":[]} |
| network failure | returns {"error":"Failed to fetch","problems":[]} |
| 200 with no body | returns {} |
| 204 | returns {} |

Request: `GET /api/v2/folders/common/plan?action=create&folder=team&chart=c`

## applyCommon

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"error":"deployments/a/values.yaml cannot be read (permission denied)","problems":[]} |
| 500 with a reason | returns {"error":"Generation failed: boom","problems":[]} |
| 504 HTML from a proxy | returns {"error":"HTTP 504","problems":[]} |
| network failure | returns {"error":"Failed to fetch","problems":[]} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/folders/common (application/json) {"action":"create","folder":"team","chart":"c","expected":["team/_common/c-values.yaml"]}`

## getCommonUsers

| answer | the caller gets |
|---|---|
| 200 with its body | returns [{"from":"server"}] |
| 400 with field problems | returns [] |
| 409 naming a file | returns [] |
| 500 with a reason | returns [] |
| 504 HTML from a proxy | returns [] |
| network failure | returns [] |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/folders/common/users?path=team%2F_common`

## getSyncRegistry

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"failed":true,"error":"The values have 1 problem"} |
| 409 naming a file | returns {"failed":true,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml"} |
| 500 with a reason | returns {"failed":true,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"failed":true,"error":"sync.yaml could not be read (the server answered 504)"} |
| network failure | returns {"failed":true,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/sync`

## getSyncSource

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"target":"team/d","failed":true,"error":"The values have 1 problem"} |
| 409 naming a file | returns {"target":"team/d","failed":true,"error":"deployments/a/values.yaml cannot be read (permission denied)","file":"deployments/a/values.yaml"} |
| 500 with a reason | returns {"target":"team/d","failed":true,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"target":"team/d","failed":true,"error":"sync.yaml could not be read (the server answered 504)"} |
| network failure | returns {"target":"team/d","failed":true,"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: false) |
| 204 | throws AnswerCutOff (uncertain: false) |

Request: `GET /api/v2/sync?target=team%2Fd`

## createSync

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem","problems":[{"path":"cpu[0].warn","message":"must be a number"}]} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)"} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false,"error":"Sync failed"} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | returns {} |
| 204 | returns {} |

Request: `POST /api/v2/sync (application/json) {"source":"team/a","target":"team/b"}`

## unlinkSync

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"ok":false,"error":"The values have 1 problem"} |
| 409 naming a file | returns {"ok":false,"error":"deployments/a/values.yaml cannot be read (permission denied)"} |
| 500 with a reason | returns {"ok":false,"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"ok":false,"error":"Unlink failed"} |
| network failure | returns {"ok":false,"error":"Failed to fetch"} |
| 200 with no body | returns {} |
| 204 | returns {} |

Request: `DELETE /api/v2/sync (application/json) {"target":"team/b"}`

## cloneChart

| answer | the caller gets |
|---|---|
| 200 with its body | returns {"from":"server"} |
| 400 with field problems | returns {"error":"The values have 1 problem"} |
| 409 naming a file | returns {"error":"deployments/a/values.yaml cannot be read (permission denied)"} |
| 500 with a reason | returns {"error":"Generation failed: boom"} |
| 504 HTML from a proxy | returns {"error":"Clone failed"} |
| network failure | returns {"error":"Failed to fetch"} |
| 200 with no body | throws AnswerCutOff (uncertain: true) |
| 204 | throws AnswerCutOff (uncertain: true) |

Request: `POST /api/v2/charts/c/clone (application/json) {"newName":"c2","migration":{"groups":{}}}`
