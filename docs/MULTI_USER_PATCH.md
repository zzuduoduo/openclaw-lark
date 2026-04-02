# 飞书插件多用户支持修改记录

## 修改目的
移除飞书插件的 owner-only 限制，允许多个已授权用户使用文档创建等功能。

**⚠️ 安全警告：此修改会放宽安全限制，请仅在可信环境中使用。**

## 修改文件清单

### 1. src/tools/onboarding-auth.ts（原 onboarding-auth.js）
**位置：** 约第60-71行
**修改内容：** 注释掉 onboarding 流程中的 owner 检查

```typescript
// 修改前:
  // 1. 检查 userOpenId === 应用 owner（统一走 getAppOwnerFallback）
  const ownerOpenId = await getAppOwnerFallback(acct, sdk);
  if (!ownerOpenId) {
    log.info(`app ${appId} has no owner info, skipping`);
    return;
  }
  if (userOpenId !== ownerOpenId) {
    log.info(`user ${userOpenId} is not app owner (${ownerOpenId}), skipping`);
    return;
  }
  log.info(`user ${userOpenId} is app owner, starting OAuth`);

// 修改后:
  // 1. 检查 userOpenId === 应用 owner（统一走 getAppOwnerFallback）
  // [MODIFIED] 注释掉 owner-only 限制以支持多用户使用
  // const ownerOpenId = await getAppOwnerFallback(acct, sdk);
  // if (!ownerOpenId) {
  //   log.info(`app ${appId} has no owner info, skipping`);
  //   return;
  // }
  // if (userOpenId !== ownerOpenId) {
  //   log.info(`user ${userOpenId} is not app owner (${ownerOpenId}), skipping`);
  //   return;
  // }
  // log.info(`user ${userOpenId} is app owner, starting OAuth`);
  log.info(`user ${userOpenId} starting OAuth`);
```

### 2. src/core/tool-client.ts（原 tool-client.js）
**位置：** 约第333-334行
**修改内容：** 注释掉 `invokeAsUser` 方法中的 owner 检查

```typescript
// 修改前:
    // Owner 检查：非 owner 用户直接拒绝（从 uat-client.ts 迁移至此）
    await assertOwnerAccessStrict(this.account, this.sdk, userOpenId);

// 修改后:
    // Owner 检查：非 owner 用户直接拒绝（从 uat-client.ts 迁移至此）
    // [MODIFIED] 注释掉 owner-only 限制以支持多用户使用
    // await assertOwnerAccessStrict(this.account, this.sdk, userOpenId);
```

### 3. src/commands/auth.ts（原 auth.js）
**位置：** 约第141-149行
**修改内容：** 注释掉 `/feishu auth` 命令中的 owner 检查

```typescript
// 修改前:
  // Owner 检查（fail-close: 授权命令安全优先）
  try {
    await assertOwnerAccessStrict(acct, sdk, senderOpenId);
  } catch (err) {
    if (err instanceof OwnerAccessDeniedError) {
      return { kind: 'owner_only' };
    }
    throw err;
  }

// 修改后:
  // Owner 检查（fail-close: 授权命令安全优先）
  // [MODIFIED] 注释掉 owner-only 限制以支持多用户使用
  // try {
  //   await assertOwnerAccessStrict(acct, sdk, senderOpenId);
  // } catch (err) {
  //   if (err instanceof OwnerAccessDeniedError) {
  //     return { kind: 'owner_only' };
  //   }
  //   throw err;
  // }
```

### 4. src/tools/oauth.ts（原 oauth.js）
**位置：** 约第278-291行
**修改内容：** 注释掉 OAuth 授权流程中的 owner 检查

```typescript
// 修改前:
  // 0. Check if the user is the app owner (fail-close: 安全优先).
  const sdk = LarkClient.fromAccount(account).sdk;
  try {
    await assertOwnerAccessStrict(account, sdk, senderOpenId);
  } catch (err) {
    if (err instanceof OwnerAccessDeniedError) {
      log.warn(`non-owner user ${senderOpenId} attempted to authorize`);
      return json({
        error: 'permission_denied',
        message: '当前应用仅限所有者（App Owner）使用。您没有权限发起授权，无法使用相关功能。',
      });
    }
    throw err;
  }

// 修改后:
  // 0. Check if the user is the app owner (fail-close: 安全优先).
  // [MODIFIED] 注释掉 owner-only 限制以支持多用户使用
  const sdk = LarkClient.fromAccount(account).sdk;
  // try {
  //   await assertOwnerAccessStrict(account, sdk, senderOpenId);
  // } catch (err) {
  //   if (err instanceof OwnerAccessDeniedError) {
  //     log.warn(`non-owner user ${senderOpenId} attempted to authorize`);
  //     return json({
  //       error: 'permission_denied',
  //       message: '当前应用仅限所有者（App Owner）使用。您没有权限发起授权，无法使用相关功能。',
  //     });
  //   }
  //   throw err;
  // }
```

### 5. src/tools/auto-auth.ts（原 auto-auth.js）
**位置：** 约第938-946行
**修改内容：** 注释掉 Owner 访问拒绝的错误处理

```typescript
// 修改前:
  // --- Path 0：Owner 访问拒绝 → 直接返回友好提示 ---
  if (err instanceof OwnerAccessDeniedError) {
    return json({
      error: 'permission_denied',
      message: '当前应用仅限所有者（App Owner）使用。您没有权限使用相关功能。',
      user_open_id: err.userOpenId,
      // 注意：不序列化 err.appOwnerId，避免泄露 owner 的 open_id
    });
  }

// 修改后:
  // --- Path 0：Owner 访问拒绝 → 直接返回友好提示 ---
  // [MODIFIED] 注释掉 owner-only 限制以支持多用户使用
  // if (err instanceof OwnerAccessDeniedError) {
  //   return json({
  //     error: 'permission_denied',
  //     message: '当前应用仅限所有者（App Owner）使用。您没有权限使用相关功能。',
  //     user_open_id: err.userOpenId,
  //     // 注意：不序列化 err.appOwnerId，避免泄露 owner 的 open_id
  //   });
  // }
```

## 恢复原始限制的方法

如需恢复原始的安全限制，只需取消注释上述代码块即可。

## 修改时间
2026-04-02

## 修改者
AI Assistant

## 相关代码位置
- `src/tools/onboarding-auth.ts` - Onboarding 流程的 owner 检查
- `src/core/tool-client.ts` - API 调用时的 owner 检查
- `src/commands/auth.ts` - 授权命令的 owner 检查
- `src/tools/oauth.ts` - OAuth 授权流程的 owner 检查
- `src/tools/auto-auth.ts` - Owner 拒绝的错误处理
