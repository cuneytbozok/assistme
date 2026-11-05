# Flow Designer

Confirm names with `discover_tables`: these tables vary by release. Flow definitions can be stored in a compressed form that isn't readable through the Table API. If so, say so, and ask the user to open the flow.

## Where to look

| Table | Holds |
| ----- | ----- |
| `sys_hub_flow` | Flows and subflows: `name`, `active`, `status`, `sys_scope` |
| `sys_hub_action_type_definition` | Actions |
| `sys_hub_trigger_instance` | What starts each flow |
| `sys_flow_context` | One run of a flow: `name`, `state`, `started`, `ended`, `source_table`, `source_record` |
| `sys_flow_log` | Log messages of runs, where enabled |

## Did a flow run for this record?

```json
{
  "table": "sys_flow_context",
  "where": [{ "field": "source_record", "op": "=", "value": "SYS_ID" }],
  "order_by": [{ "field": "started", "direction": "desc" }]
}
```

Check the field names first with `describe_table`. A run's `state` shows if it finished, failed or is waiting.

## Why didn't it run?

1. The flow is active and published.
2. Its trigger matches the table and condition, at the time of the event. Compare with the values in the record's history.
3. A flow triggered in the background runs after the transaction, so it can be delayed. Check the time.

## Why did it fail?

1. Find the run in `sys_flow_context`.
2. Read its logs in `sys_flow_log`. Detailed step data depends on the instance's reporting settings: the user can open the execution details in the UI to see more.
3. If an action calls a script, use `search_code` and `get_field_content`.

## Limits of this connector

Flow connection credentials (`sys_hub_connection_*`) are blocked, by design. You can't start, test or change a flow. Describe what you'd check, and let the user do it.
