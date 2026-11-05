# Business rule execution

Why did a field change, or why didn't a rule run? Confirm names with `describe_table`.

## Where to look

| Table | Holds |
| ----- | ----- |
| `sys_script` | Business rules: `collection`, `when`, `order`, `active`, `action_insert`, `action_update`, `action_query`, `action_delete`, `filter_condition`, `condition`, `script` |
| `sys_script_include` | Reusable server scripts |
| `sys_script_client` | Client scripts |
| `sys_data_policy2`, `sys_ui_policy` | Data and UI policies |
| `sys_dictionary` | Field defaults and calculated fields |

## Who changed this field?

1. `get_record_history` for the record. The `user` and time narrow it down.
2. `search_code` for the field name, on the tables above.
3. Read each candidate whole with `get_field_content`. Snippets don't show the conditions.
4. Check for flows and scheduled jobs too. See `flow-designer.md`. A change by `system` often means one of those, or an integration.

## Why didn't the rule run?

Check, in order:

1. `active` is true.
2. `collection` is this table or a parent. Rules on `task` also run on `incident`. Use `describe_table` to see the chain.
3. The action matches: `action_update` for an update, and so on.
4. `filter_condition` and `condition` held at the time. Compare them with the record's values from the history, not its values now.
5. `when` and `order`: an earlier rule may have aborted the action or changed a value first. List the table's rules ordered by `when` and `order`.
6. The change may have skipped rules: some imports and background updates run with workflow turned off. Look for that in the script that made the change.

## Listing a table's rules

```json
{
  "table": "sys_script",
  "where": [
    { "field": "collection", "op": "in", "value": ["incident", "task"] },
    { "field": "active", "op": "=", "value": "true" }
  ],
  "fields": ["name", "collection", "when", "order", "action_insert", "action_update", "filter_condition"],
  "order_by": [{ "field": "order", "direction": "asc" }],
  "limit": 200
}
```

## Comparing environments

If it works on one instance and not another, request a scope covering both, then use `compare_records` on the rule.

## Traps

- Display business rules and `before` query rules change what you see, not the stored data.
- Audit history can leave out fields excluded from auditing, so a change may not appear there.
