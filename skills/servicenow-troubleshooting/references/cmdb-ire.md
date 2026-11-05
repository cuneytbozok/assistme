# CMDB and identification

Confirm names with `discover_tables`: they vary by release.

## Where to look

| Table | Holds |
| ----- | ----- |
| `cmdb_ci` and children | Configuration items. Use the most specific class you can |
| `cmdb_rel_ci` | Relationships: `parent`, `child`, `type` |
| `cmdb_rel_type` | Relationship types |
| `cmdb_identifier`, `cmdb_identifier_entry` | Identification rules per class |
| `reconciliation_definition` | Which source may update which attributes |
| `sys_object_source` | Which source knows a CI, and by what id |
| `cmdb_datasource` | Registered data sources |

## Why did this CI change, or not?

1. `get_record` the CI, then `get_record_history` to see changes and who made them.
2. `sys_object_source` shows which sources report it.
3. Check reconciliation for the class and attribute: a lower-priority source can't overwrite a higher one.

## Why is there a duplicate?

1. Compare the two CIs on the identifier's attributes. Find the rule in `cmdb_identifier` for the class, walking up the class chain from `describe_table`.
2. Look for a difference in those attributes, such as a serial number or a name with a different case.
3. Check `sys_class_name`: the same device under two classes doesn't always match.
4. Use `aggregate_records` to find how widespread it is: group by the attribute, and look for counts above 1.

## Relationships

`get_related_records` finds references to a CI. Relationships in `cmdb_rel_ci` also point at it through `parent` and `child`, so they appear there. Query them directly to see the type:

```json
{
  "table": "cmdb_rel_ci",
  "any_of": [
    [{ "field": "parent", "op": "=", "value": "SYS_ID" }],
    [{ "field": "child", "op": "=", "value": "SYS_ID" }]
  ],
  "fields": ["parent", "child", "type"]
}
```

## Traps

- Querying `cmdb_ci` returns all classes. Group by `sys_class_name` to see what's there.
- A CI's `operational_status` and `install_status` mean different things. Check their choices.
