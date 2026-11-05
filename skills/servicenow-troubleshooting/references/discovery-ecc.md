# Discovery and the ECC queue

Confirm names with `discover_tables`: they depend on the plugins installed.

## Where to look

| Table | Holds |
| ----- | ----- |
| `discovery_status` | One Discovery run: state, schedule, start and end |
| `discovery_device_history` | What happened per device in a run |
| `discovery_log` | Log lines of a run |
| `ecc_queue` | Messages to and from MID Servers: `agent`, `topic`, `name`, `queue` (`output` or `input`), `state`, `payload`, `sys_created_on` |
| `ecc_agent` | MID Servers and their status |
| `discovery_schedule` | Schedules and their ranges |

## Approach

1. Find the run in `discovery_status`, by schedule or time.
2. Find the device in `discovery_device_history` with that status. Its fields show how far it got.
3. Read `discovery_log` for that run, filtered by the device's source.
4. Follow the `ecc_queue`: each probe is an `output` row, and its answer an `input` row. Filter by `agent` and a time window. `ecc_queue` is huge, so always use a time range.
5. Read the failing `payload` with `get_field_content`. It can be long and XML.

## What it usually means

| Symptom | Look at |
| ------- | ------- |
| `output` stuck in `ready` | The MID Server is down or busy: its `ecc_agent` status |
| `input` with an error in the payload | Credentials, connectivity or the probe itself |
| Classified but not updated | Identification (`cmdb-ire.md`) |
| No device found | Schedule ranges and port probes in the log |

## Limits of this connector

Credential tables are blocked, by design. You can tell the user that a credential seems to be failing, from the error in the log or payload, but you can't read which credentials exist or their values. They can check those themselves.
