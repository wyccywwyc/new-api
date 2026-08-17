# 为 /v1/chat/completions 增加渠道 ID 列表轮询入参

## Context

标准对话接口 `POST /v1/chat/completions` 当前按「优先级 + 权重随机」选择渠道(经由 `middleware.Distribute` → `service.CacheGetRandomSatisfiedChannel` → `model.GetRandomSatisfiedChannel`)。调用方无法指定候选渠道范围。

需求:在请求体增加 `channel_ids` 入参(整数数组)。为空时走原逻辑;非空时在「已启用 + 支持该 model + 在用户可访问 group」的校验通过后,按全局共享游标做轮询选择(依次循环,不按权重/优先级)。

## 设计决策(已与用户确认)

- **目标接口**:仅标准 `/v1/chat/completions`(及走同一通用 JSON 解析分支的其它标准 relay 端点,如 `/v1/completions`、`/v1/messages` 等,均为 opt-in)。**Playground `/pg/chat/completions` 不支持该入参**,继续走原逻辑。
- **轮询范围**:全局共享单个游标(一个 `atomic.Int64`),所有请求共同推进。不同 `channel_ids` 列表长度下分布可能不均,用户已接受此权衡。
- **校验策略**:候选渠道仍须通过 `model.IsChannelEnabledForGroupModel` 校验(隐含已启用 + 支持 model + 在用户 group 内);Advanced Custom(type 58)渠道再过 `channelSupportsRequestPath` 路径校验。校验失败的渠道从轮询候选中剔除。

## 实现步骤

### 1. `middleware/distributor.go` — 扩展 `ModelRequest` 与 body 解析

- 在 `ModelRequest` 结构体(line 27-30)增加字段:
  ```go
  type ModelRequest struct {
      Model      string `json:"model"`
      Group      string `json:"group,omitempty"`
      ChannelIds []int  `json:"channel_ids,omitempty"`
  }
  ```
- `getModelFromJSONBody`(line 208)的 `gjson.GetManyBytes` 调用由 `("model", "group")` 改为 `("model", "group", "channel_ids")`,新增解析 `values[2]` 为 `[]int`(复用 `gjson.Result.IsArray()` + 遍历 `.Array()` 取 `.Int()`,非法元素直接报错,与现有 `getJSONStringValue` 的严格风格一致)。新增辅助 `getJSONIntSliceValue(result gjson.Result, field string) ([]int, error)`,非数组/为空返回 `nil` 不报错。
- `getModelRequest` 的通用 JSON 分支(line 346-352)在 `modelRequest.Model = req.Model` 之后增加 `modelRequest.ChannelIds = req.ChannelIds`。
- **Playground 分支(line 401-410)不复制 `ChannelIds`**,仅复制 Model/Group,确保 Playground 不受影响。

### 2. `middleware/distributor.go` — 新增全局游标与轮询选择

- 包级变量(放在 `Distribute` 函数上方):
  ```go
  var channelIDRoundRobinCounter atomic.Int64
  ```
- 新增函数:
  ```go
  func selectChannelByRoundRobin(c *gin.Context, usingGroup, modelName, requestPath string, channelIDs []int) (*model.Channel, string, error)
  ```
  - 入参:`usingGroup`(来自 `ContextKeyUsingGroup`)、`modelName`、`requestPath`、候选 `channelIDs`。
  - 逻辑:
    1. 取 `userGroup := common.GetContextKeyString(c, constant.ContextKeyUserGroup)`。
    2. 遍历 `channelIDs`,对每个 id:
       - 非 auto:`IsChannelEnabledForGroupModel(usingGroup, modelName, id)` 为真则候选。
       - auto:遍历 `service.GetUserAutoGroup(userGroup)`,找首个 `IsChannelEnabledForGroupModel(g, modelName, id)` 为真的 g,记录 `(id, g)` 为候选并 break 内层。
    3. 对每个候选 id 再 `model.CacheGetChannel(id)` 取 `*Channel`,校验 `channel.Status == common.ChannelStatusEnabled` 且 `channelSupportsRequestPath(channel, requestPath, modelName)`;不过则丢弃。
    4. 去重(按 id,保留首次出现顺序)。
    5. 若候选为空,返回 `(nil, "", errors.New("no available channel in the specified channel_ids list for model ... in group ..."))`。
    6. `idx := int(channelIDRoundRobinCounter.Add(1)-1) % len(candidates)`,选 `candidates[idx]`。
    7. 返回 `(channel, selectGroup, nil)`,其中 auto 时 `selectGroup` = 该候选对应的 group;非 auto 时 `selectGroup = usingGroup`。
- 复用的现有函数:
  - `model.IsChannelEnabledForGroupModel`([model/channel_satisfy.go:8](file:///d:/work2/code/newAPI/new-api/model/channel_satisfy.go#L8))
  - `model.CacheGetChannel`([model/channel_cache.go:239](file:///d:/work2/code/newAPI/new-api/model/channel_cache.go#L239))
  - `service.GetUserAutoGroup`([service/group.go:46](file:///d:/work2/code/newAPI/new-api/service/group.go#L46))
  - `channelSupportsRequestPath`([middleware/distributor.go:175](file:///d:/work2/code/newAPI/new-api/middleware/distributor.go#L175))
  - `common.ChannelStatusEnabled`、`constant.ContextKeyUserGroup`、`constant.ContextKeyAutoGroup`

### 3. `middleware/distributor.go` — 接入 `Distribute`

在现有渠道选择块(line 134 `if channel == nil {` 进入 `CacheGetRandomSatisfiedChannel` 之前)插入轮询分支:
```go
if channel == nil && len(modelRequest.ChannelIds) > 0 {
    rrChannel, rrGroup, rrErr := selectChannelByRoundRobin(c, usingGroup, modelRequest.Model, c.Request.URL.Path, modelRequest.ChannelIds)
    if rrErr != nil {
        abortWithOpenAiMessage(c, http.StatusServiceUnavailable, i18n.T(c, i18n.MsgDistributorNoAvailableChannel, map[string]any{"Group": usingGroup, "Model": modelRequest.Model}), types.ErrorCodeModelNotFound)
        return
    }
    channel = rrChannel
    selectGroup = rrGroup
    if usingGroup == "auto" {
        common.SetContextKey(c, constant.ContextKeyAutoGroup, rrGroup)
    }
}
```
注意:`usingGroup` 与 `selectGroup` 变量需在 `if shouldSelectChannel` 块内已声明(当前 `selectGroup` 在 line 84 声明,`usingGroup` 在 line 85 声明),放在 affinity 之后、`CacheGetRandomSatisfiedChannel` 之前即可。轮询命中后 `channel != nil`,后续 `if channel == nil` 的原逻辑分支自然跳过。

### 4. i18n / 错误文案

复用现有 `i18n.MsgDistributorNoAvailableChannel`(「无可用渠道」)文案,不新增 i18n key。错误信息中 group/model 已由该模板填充。

## 不需要修改的部分

- `controller/playground.go`、`dto/playground.go`:Playground 不支持该入参,无需改动。
- `service/channel_select.go`:原 `CacheGetRandomSatisfiedChannel` 逻辑保持不变(空列表走这里)。
- `model/channel_cache.go`:`GetRandomSatisfiedChannel` 不变。
- 前端:本次仅后端,不改 `web/`。
- 不需要数据库迁移(`channel_ids` 仅在请求体内,不入库)。

## 验证

1. **编译**:`go build ./...` 通过。
2. **空列表走原逻辑**:向 `/v1/chat/completions` 发正常请求(不带 `channel_ids`),行为与改动前一致。
3. **非空列表轮询**:
   - 准备一个用户可访问 group 下、支持某 model(如 `gpt-4o-mini`)的 2~3 个已启用渠道,记录其 id。
   - 用对应 API Token 连续发 6 次 `{"model":"gpt-4o-mini","messages":[...],"channel_ids":[id1,id2,id3]}`,通过日志/响应头确认渠道按 `id1→id2→id3→id1→id2→id3` 顺序循环(响应中渠道 id 可从日志的 `channel_id` 字段观察,或临时打印)。
4. **校验生效**:
   - 列表中混入一个「已禁用」或「不支持该 model」或「不在用户 group」的 id,确认该 id 被跳过,只轮询剩余有效渠道。
   - 列表全部无效时,返回 503 + 「无可用渠道」错误。
5. **auto group**:token 的 group 为 `auto` 时,列表中的渠道在不同 auto 分组里都能正确选中,且计费 group 正确(检查日志的 `group` 字段)。
6. **Playground 不受影响**:`/pg/chat/completions` 即使 body 带 `channel_ids` 也走原逻辑(因为 Playground 分支不复制该字段)。
7. **并发安全**:游标用 `atomic.Int64`,无需加锁;`CacheGetChannel`/`IsChannelEnabledForGroupModel` 内部已有 `channelSyncLock.RLock`。

## 风险与边界

- 全局共享游标意味着高并发下不同用户的请求会交错推进游标,同一用户的连续请求未必严格 1→2→3。用户已接受。
- `channel_ids` 字段会随原 body 透传到上游(与现有 `group` 字段一致),OpenAI 等上游会忽略未知字段,无副作用。
- 若 `MemoryCacheEnabled=false`,`IsChannelEnabledForGroupModel` 走 DB 查询,`CacheGetChannel` 走 `GetChannelById`,均已有降级路径,无需额外处理。
