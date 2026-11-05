# Logs and transactions

Confirm table and field names with `describe_table`: they vary by release.

## Where to look

| Table | Holds |
| ----- | ----- |
| `syslog` | Script and system log messages (`level`, `source`, `message`, `sys_created_on`) |
| `syslog_transaction` | One row per transaction: URL, user, response time, SQL and business rule time |
| `sys_email` | Sent and received email |
| `sysevent` | Queued events, their state and when they were processed |
| `sys_trigger` | Scheduled jobs and when they next run |

## Approach

1. Get the exact time from the record's history or the user's report.
2. Query a small window around it. Times are UTC in the API.
3. Use `aggregate_records` first to see the shape: group `syslog` by `source` or `level` over the window.
4. Then read the rows you care about, with the fields you need.

```json
{
  "table": "syslog",
  "where": [
    { "field": "sys_created_on", "op": "between", "value": ["2026-11-05 10:00:00", "2026-11-05 10:05:00"] },
    { "field": "level", "op": "=", "value": 2 }
  ],
  "fields": ["sys_created_on", "source", "message"]
}
```

`level` is commonly 0 for information, 1 for warning and 2 for error. Check with `describe_table` and `include_choices`.

## Slow transactions

Sort `syslog_transaction` by `response_time` within the window, then compare the time fields to see where it went: SQL, business rules, or elsewhere. Reading the slow URL tells you which page or API call it was.

## Common traps

- A missing log line doesn't prove code didn't run: the script may not log, or the level may be filtered.
- High-volume log tables are slow on `contains` with no time range.
- Long messages are previews. `omitted` has the `get_field_content` call for the full text.
