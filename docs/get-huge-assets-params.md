# `get_huge_assets` 参数关系说明

## 参数定义

| 参数 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `p_organization_id` | `uuid` | `NULL` | 调用方所属的组织 ID，**必须有值才会执行查询** |
| `p_workspace_id` | `uuid` | `NULL` | 具体的工作空间 ID，可选 |

---

## 两个参数的关系

`p_organization_id` 是**前置必要条件**，`p_workspace_id` 是可选的**进一步收窄**。

```
p_organization_id
    └── 确定查询范围上界（必须）
            │
            ├── p_workspace_id = NULL  →  org-wide：返回该 org 下所有 workspace 的结果
            │
            └── p_workspace_id 有值   →  精确匹配：workspace 必须同时满足
                                          w.id = p_workspace_id
                                          AND w.organization_id = p_organization_id
```

关键约束：**`p_workspace_id` 永远不能脱离 `p_organization_id` 单独使用**。
当传入 `p_workspace_id` 时，RPC 会同时验证该 workspace 确实隶属于指定的 org，
防止跨 org 越界查询。

---

## 三种调用场景

### 1. 扫码进入具体 workspace

```js
// 客户端同时持有 organizationId 和 workspaceId
supabase.rpc('get_huge_assets', {
  p_organization_id: organizationId,
  p_workspace_id: workspaceId,
})
```

**RPC 行为**：`w.id = workspaceId AND w.organization_id = organizationId`，
只返回该 workspace 的 `is_huge` 模型。

---

### 2. 只扫 org 码 / 切换 org 后未选择具体 workspace

```js
// 客户端只有 organizationId，workspaceId 传 null
supabase.rpc('get_huge_assets', {
  p_organization_id: organizationId,
  p_workspace_id: null,
})
```

**RPC 行为**：`w.organization_id = organizationId`，
返回该 org 下所有 workspace 的 `is_huge` 模型。

---

### 3. 未初始化（兜底保护）

```js
// organizationId 未知，客户端不发请求
if (!organizationId) return;
```

**客户端提前拦截，不调用 RPC**。
即便意外调用（两个参数均为 NULL），RPC 的 WHERE 子句两个分支均不满足，
返回空结果集，fail-close，不会泄露任何数据。

---

## WHERE 子句逻辑（完整）

```sql
WHERE
  (
    -- 场景 1：双重约束
    (p_workspace_id IS NOT NULL AND p_organization_id IS NOT NULL
      AND w.id = p_workspace_id AND w.organization_id = p_organization_id)
    OR
    -- 场景 2：org-wide
    (p_workspace_id IS NULL AND p_organization_id IS NOT NULL
      AND w.organization_id = p_organization_id)
  )
  AND a.is_huge = true
  AND a.file_type = 'model'
  AND a.location IS NOT NULL;
```

---

## 与 `fetchNearbyAssets` 的一致性

`get_huge_assets` 的参数传递模式与 `fetchNearbyAssets` 完全一致：
作用域约束**完全由 RPC 参数决定**，客户端不做额外的 `isHugeAssetInScope` 过滤，
避免客户端与数据库双重过滤逻辑不一致的问题。
