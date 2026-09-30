---
name: print-notifications
description: Set up user-requested print completion and problem notifications through the connected printer MCP server's native events.
---

Use the connected MCP server's advertised native event source. Resolve the exact authorized printer alias from its event catalog; ask when the user has not identified the intended printer. Subscribe to `print.completed` and/or `print.problem` as requested, preserving the printer argument. Use the host's supported event automation workflow and the user's requested notification action. Never replace native events with scheduled status polling or an active chat relay.

Printer completion events report an observed successful job transition. Cancellation, idle status and 100% progress do not prove completion. Events with `data.test: true` are synthetic acceptance-test events: the notification must explicitly say "TEST printer notification" and must not claim a new physical print finished. Opaque job IDs are for deduplication, not file names.

Only describe notification setup as successful after the actual client subscription succeeds. A recorded event, plugin installation, webhook acknowledgement or simulated receiver alone does not establish a user-visible notification. If the client has no native event integration, report the exact unsupported capability and leave notification acceptance incomplete. Do not operate, heat or move printers as part of notification setup.
