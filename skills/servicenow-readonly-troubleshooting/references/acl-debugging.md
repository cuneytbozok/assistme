# ACL debugging

Who can see or do what? The connector reads as the signed-in user, so what you see is what their ACLs allow.

## Where to look

| Table | Holds |
| ----- | ----- |
| `sys_security_acl` | ACL rules: `name` (`table` or `table.field`), `operation`, `type`, `active`, `condition`, `script`, `admin_overrides` |
| `sys_security_acl_role` | The roles an ACL requires |
| `sys_user_has_role` | Roles per user, including inherited ones |
| `sys_user_grmember` | Group membership |
| `sys_user_role_contains` | Roles contained in other roles |

## Why can't this user read this?

1. List the ACLs for the table, its parents, and the field: `name` is `incident`, `task`, `*`, `incident.field`.
2. Keep the active ones for the operation, usually `read`.
3. For each, compare three things with the user: the required roles, the `condition`, and the `script`. All must pass for an ACL to grant access.
4. Get the user's roles from `sys_user_has_role`.

```json
{
  "table": "sys_security_acl",
  "where": [
    { "field": "name", "op": "in", "value": ["incident", "task", "*", "incident.*"] },
    { "field": "operation", "op": "=", "value": "read" },
    { "field": "active", "op": "=", "value": "true" }
  ],
  "fields": ["name", "operation", "type", "condition", "admin_overrides"]
}
```

## What the connector shows you

- `ACL_DENIED` means the signed-in user can't read the table. Tell the user. Don't try other tables to get the same data.
- ServiceNow can return fewer rows than exist, because hidden rows are removed. A `total` higher than what's readable means ACLs are hiding rows.
- A field missing from a record, or empty, may be hidden by a field ACL.
- If reading `sys_security_acl` is refused, the signed-in user can't see the rules. Ask a ServiceNow admin.

## Before-query rules

Business rules with `action_query` can filter rows before ACLs apply, so a row can be invisible with no ACL involved. See `business-rule-execution.md`.

## Limits

You can't impersonate another user, and you can't run the access-debugging tools. You reason from the rules; the user or an admin can confirm with the session debugger or impersonation.
