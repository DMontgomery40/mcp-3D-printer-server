# Printer notifications through MCP Events

This development feature is opt-in. Installing the npm/stdio package or desktop MCPB does not automatically subscribe a user or deliver a notification. Ordinary ChatGPT notification delivery requires an installed native MCP Events connection and a user-requested automation. No dot or maintainer relay is part of the product.

**Acceptance currently fails:** the authorized tiny P1S print finished, both development observers recorded one completion, but the user received no MCP-client notification. Signed simulated receiver tests are diagnostic evidence only. The remaining acceptance test must inject a labeled test completion and verify an actual ChatGPT notification. No second physical print is needed. Nothing here is released, merged to main, registered externally, or publicly exposed.

## Supported sources and clients

| Backend | Event ingestion | Completion / problem evidence | Limits |
| --- | --- | --- | --- |
| Bambu | Existing MQTT `push_status` connection in an isolated legacy child | Matching active job then FINISH with known clear errors; FAILED, print_error and actionable HMS produce problems | One P1S physical observer test; no upstream durable log; jobs entirely offline are missed |
| Klipper / Moonraker | Read-only object query every 15 seconds | Explicit print_stats printing/paused → complete; error or Klippy shutdown produces a problem | Mocked API tests; virtual_sdcard required; transitions entirely between polls may be missed |
| OctoPrint | Authenticated SockJS push, existing API key with STATUS permission | Explicit PrintStarted/current active identity then PrintDone; PrintFailed(error) produces a problem | Mocked transport/lifecycle tests; cancellation is suppressed; reconnect history can arm an active job but cannot recover missed terminal events |
| Duet (DSF object model) | Read-only machine/status query every 15 seconds | Active matching file and changed last-job record, with explicit aborted/cancelled/simulated flags; aborted produces a problem | Mocked API tests; absent flags or unchanged identical terminal records withhold completion; firmware simulation is never a physical completion |
| Repetier Server | Native socket events, explicitly configured printer slug | jobStarted/start timestamp → jobFinished for the same slug/job | Mocked events; jobKilled suppresses success; API does not distinguish deliberate cancellation from faults, so no fabricated problem diagnosis; events missed offline cannot be recovered |
| Prusa Connect / PrusaLink | Not enabled for native completion in this host | Current Buddy status drops job ID when FINISHED; OctoPrint-compatible idle flags do not prove success | Needs a verified terminal job-history/event contract before reconnect-safe completion support; using OctoPrint with a Prusa printer can use the OctoPrint source |
| Creality Cloud | Not enabled | Existing adapter routes are not a verified official event contract | Needs documented authenticated job identity plus successful/failed/cancelled terminal events; no guessed completion from progress or idle |

The Bambu-only fork contains only Bambu source support. Its farm can contain multiple Bambu models. Unsupported sources fail configuration visibly. Other backends' ordinary control adapters remain available in the parent server; the optional source layer does not change those controls.

The optional host uses real `@modelcontextprotocol/server` 2.2.0 and the Node adapter. Its authenticated `/mcp` endpoint provides SDK discovery for protocol `2026-07-28`, events/list, subscribe, unsubscribe, and read-only history/minimal-state tools. ChatGPT supports the signed outbound webhook delivery described in the [official Events guide](https://developers.openai.com/plugins/build/mcp-events). Existing SDK 1.x stdio/HTTP clients retain their current behavior. Session notifications, polling an MCP tool and streaming are not durable client wakeups. Durable Codex CLI/legacy-client notifications are not established by this implementation.

Source references: [Moonraker object queries](https://moonraker.readthedocs.io/en/latest/external_api/printer/), [Klipper print_stats implementation](https://github.com/Klipper3d/klipper/blob/master/klippy/extras/print_stats.py), [OctoPrint push](https://docs.octoprint.org/en/main/api/push.html) and [terminal events](https://docs.octoprint.org/en/main/events/index.html), [Duet job model](https://github.com/Duet3D/DuetSoftwareFramework/blob/master/src/DuetAPI/ObjectModel/Job/Job.cs), [Repetier socket events](https://www.repetier-server.com/manuals/programming/API/index.html), [Prusa status rendering](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/master/lib/WUI/nhttp/status_renderer.cpp) and [job-state lifetime](https://github.com/prusa3d/Prusa-Firmware-Buddy/blob/master/src/state/printer_state.cpp).

## Operator opt-in and farms

Build the root package and install the isolated optional dependencies:

```sh
npm run build
npm --prefix events-host ci
```

The host requires Node 20 or later. Start it explicitly with `npm --prefix events-host start` only after provisioning:

- `MCP_EVENTS_HOST_STORE`: absolute private journal outside the checkout, existing parent directory.
- `MCP_EVENTS_AUTH_MODULE`: absolute private module exporting authenticate(request), authorize({principal}, printerAlias), oauthMetadata and optionally scopesSupported/requiredScopes. Advertised optional scopes do not need to be required for read-only access. It must verify an existing OAuth issuer and resource audience, and consult a current account-to-printer policy on every request and delivery.
- `MCP_EVENTS_PUBLIC_URL`: approved authenticated HTTPS `/mcp` endpoint, forwarded only to the read-only host. The host binds 127.0.0.1:3001; optional MCP_EVENTS_HOST_PORT selects a different loopback port. OAuth protected-resource metadata routes must also be forwarded.
- `MCP_EVENTS_PRINTERS_FILE`: optional absolute owner-readable-only JSON file configuring 1–100 printers. Without it, an explicitly configured environment supplies one default printer. Each child/source uses a separate `${MCP_EVENTS_HOST_STORE}.printer-<alias>` journal.

A farm configuration uses operator-chosen public aliases, not printer serials or IPs:

```json
[
  {"id":"farm-a","type":"bambu","environment":{"PRINTER_HOST":"YOUR_LAN_HOST","BAMBU_SERIAL":"YOUR_SERIAL","BAMBU_TOKEN":"YOUR_EXISTING_ACCESS_CODE","BAMBU_MODEL":"P1S"}},
  {"id":"farm-b","type":"klipper","environment":{"PRINTER_HOST":"YOUR_MOONRAKER_HOST","PRINTER_PORT":"7125","API_KEY":"YOUR_EXISTING_KEY"}}
]
```

Use only Bambu entries with the fork. Repetier entries additionally require REPETIER_SLUG. Individual printer credentials are explicitly isolated; values absent in an entry do not inherit another printer's credentials or a checkout .env. Configuration and journals must never be committed or packaged. Source children are local stdio; the remote host never forwards start, heating, motion or other mutating tools.

Catalogs expose only aliases allowed for the authenticated account. Subscriptions include one exact printer argument. Deterministic subscription identity includes owner, callback, event name and printer. Delivery rechecks that account's permission for the selected printer and filters history by both printer and event name. Tools also enforce selected-printer permissions. Farm source watermarks and observed-job state are independent; the same filename/task value on two printers never shares an opaque job UUID.

Existing OAuth provider integration is portable: `events-host/oauth-auth.mjs` validates RS256/ES256 JWT signature, issuer, expiration, subject, canonical resource audience and required scopes using operator-configured JWKS. It ignores token-supplied key URLs. Supply current isAllowed(principal, printerAlias) mapping, where principal is a hash of verified issuer and subject. Providers with opaque access tokens need an existing introspection/upstream assertion verifier instead. The optional cloudflare-auth.mjs is one provider adapter, not a required hosting service; it verifies the signed origin assertion and supplies no invented scopes. Neither module creates clients, accounts, grants, tokens or external services. An operator is responsible for existing issuer discovery, OAuth 2.1/PKCE, permitted ChatGPT redirects and deployment. Do not guess a callback or broaden policy to make connection setup pass.

Operators choose their own always-on LAN-accessible machine, OAuth provider and approved HTTPS ingress. A hosted operator can authorize several farm users; a self-hosting user keeps their own credentials. There is no maintainer-controlled central service in this feature. A TLS proxy can see connection metadata and minimal responses; the OAuth provider sees login identity. ChatGPT receives alias, opaque job ID, event/time, optional problem codes and a test flag when present. Printer addresses, serials, access codes, filenames, camera images and model files do not enter event payloads. Do not expose the existing legacy HTTP server's control port or MQTT/FTPS ports.

## Persistence, replay and failure behavior

Journals and locks use mode 0600, one writer, atomic replacement and fsync. Normal shutdown removes locks; after a crash, verify the process exited before removing its lock. Corrupt/locked history is not silently reset. A source outage does not block other sources or previously captured callback retries. Root legacy optional Bambu recording disables capture on storage failure while leaving emergency controls available. Its local list_print_events tool is history only and never creates a client subscription.

Completion requires a documented successful terminal signal and an observed matching active job. Initial terminal snapshots, 100% progress, idle, cancellation and ambiguous identities do not prove completion. Problem codes deduplicate per printer/job. Bambu FAILED reports without a locally observed cancel request can represent a firmware-reported fault or an external cancellation; do not interpret every problem event as a diagnosed mechanical failure. Reconnect clears transient state; persisted job identity prevents duplicate terminal replay. No upstream durable log means unknown transitions cannot be reconstructed; polling sources can miss short prints and job boundaries entirely between polls. Identical same-file jobs during a restart/outage may be withheld or indistinguishable from an already observed job. OctoPrint firmware aborts encoded only as cancellation do not receive an invented fault diagnosis; Duet halted/off without an explicit last-job record does not prove completion. Do not promise perfect detection across those gaps.

Host import commits event and per-source watermark together. A retention gap fails visibly instead of advancing past lost events. Journals retain 1000 events; evicting an unacknowledged matching subscription event stops delivery. Replay/refresh reports truncation. Subscriptions retain owner, printer, expiration, acknowledged cursor, callback secret and retry state; default/max lifetime is one day, including a null lifetime request. Revoked access removes subscriptions. Host operators must inspect and surface stopped subscriptions.

Callbacks require verified public HTTPS:443, nonprivate DNS results pinned to the connection, TLS hostname validation, no redirects and bounded payloads. Signed verification challenges precede activation; verification is cached for five minutes. Secret rotation uses a verified replacement and five-minute dual signatures. Retries preserve subscription-scoped eventId/webhook-id and body, refreshing signing timestamp/signature. Delivery is at least once; clients must deduplicate. A 2xx acknowledges receipt, not an executed automation. Transient delivery retries back off for eight attempts; permanent errors, 410, 413 or exhausted attempts stop the subscription.

## Official plugin preparation and registration status

Prior local registration work prepares the parent's official MCP Registry npm/stdio listing in PR28. That listing supports discovery; it does not register a ChatGPT MCP Events connection. Its publication/submission remains a separate release task, including resolving the old 1.2.11 version collision. No Events support is shipped in Bambu 1.1.22.

`plugins/print-events/` supplies a portable Agent Plugins manifest and notification skill. Prepare a new self-host/team package with an approved concrete endpoint:

```sh
node scripts/prepare-events-plugin.mjs https://YOUR_APPROVED_FARM_HOST/mcp /ABSOLUTE/NEW_PLUGIN_DIRECTORY
```

The command adds schema-based mcp.json with an HTTP transport. It registers nothing, creates no credentials and overwrites nothing. The source template has no invented connector ID or fabricated hosted URL. Existing [official packaging instructions](https://developers.openai.com/plugins/build/plugins) require connecting the actual MCP server in developer mode before associating a registered plugin_asdk_app identity, or submitting a remote HTTPS endpoint through With MCP for public distribution. A local repo marketplace is not public directory publication.

Remaining public-submission blockers are concrete: a selected deployable authenticated HTTPS endpoint with durable LAN event ingestion and per-account authorization; actual client registration/redirect and review access approved by its operator; real client Events acceptance; public privacy/terms/support information and submission approval. A distributed local-only package cannot supply a universal ChatGPT callback by itself. The official docs direct developers to contact OpenAI for local MCP distribution if a public endpoint cannot be provided. Secure MCP Tunnel is a separate developer connection option; its credentials/workspace association and live Events acceptance are not established here.

For one real acceptance test, an operator with an approved existing endpoint must add/connect it through [ChatGPT's supported connection workflow](https://developers.openai.com/plugins/deploy/connect-chatgpt), complete account linking, rescan and enable it in a normal chat. Request native completion/problem notification for one authorized alias. Verify actual server/discover, events/list, events/subscribe, signed challenge acceptance and persistent subscription. For the narrowly authorized synthetic retest, stop the single-writer host, run:

```sh
node scripts/inject-test-print-event.mjs /ABSOLUTE/PRIVATE_HOST_JOURNAL farm-a
```

Restart the host and verify the actual user receives a notification labeled **TEST printer notification**. The event includes data.test=true and an opaque test job ID; it must not claim a new print occurred. This operator script is not remotely callable and never contacts a printer. Verify unsubscribe afterward. A simulated callback, observer log, installation success or a maintainer relay does not pass this acceptance test.

## Submission readiness and remaining product decision

The endpoint ownership/distribution decision precedes a public submission. No personal Cloudflare service is proposed or authorized.

| Distribution choice | Who owns the endpoint and credentials | What remains |
| --- | --- | --- |
| Each user or farm self-hosts | Each operator owns its LAN observer, OAuth issuer, hostname, journals and authorized accounts | This code and plugin generator support that opt-in path. Each actual endpoint needs client connection/authentication and the real notification acceptance test. A fixed public plugin URL is not automatically replaced with every installer's local server. |
| Maintained multi-tenant service | The product operator owns a stable service domain, authenticated tenants, storage and operations; farms need an approved LAN-to-service connection | This is a separate product/operations decision, requiring tenant onboarding, secure outbound farm agents, hosting/account cost, retention/revocation/support policy and credentials. The current locally configured farm host is not a complete SaaS onboarding service. No new central infrastructure is created. |
| Official local MCP distribution | Users retain local printers and credentials; OpenAI supplies any supported client association/wakeup route | Official packaging documentation directs developers who cannot deploy public HTTPS to their OpenAI contact for local MCP support. This is a support request, not a documented automatic local Events connection. No availability or acceptance is assumed. |

The public plugin dashboard requires one connected MCP server per plugin and verifies the endpoint's domain. Existing official MCP Registry stdio registration is a different discovery mechanism; it cannot satisfy this requirement. Pick self-hosting as an explicit setup model, or approve investigating official local distribution before committing to a maintained service. The latter two are product decisions, not more adapter implementation.

Concrete submission fields/status:

| Requirement | Prepared | Missing / owner action |
| --- | --- | --- |
| Portable plugin identity, skills and component layout | Separate parent/fork plugin manifests, read-only notification workflow, mcp.json generator | Assign a submission version only when authorized; provide the selected real HTTPS endpoint before packaging the complete ZIP |
| Publisher organization/project and identity | Existing repository owner is identified | Select the actual OpenAI organization/project; verify publishing identity and owner or Apps Management Write entitlement in the dashboard |
| Listing text and product/support URLs | Display/short/long descriptions, category, developer name, source/support links | Publisher must approve final product copy and endpoint-specific support commitments |
| Privacy/terms and primary icon | No invented public legal URL or brand asset | Approved publicly accessible privacyPolicyURL and termsOfServiceURL for the chosen distribution; approved primary logo/icon assets (composer icon also required for Codex); optional screenshots |
| Endpoint, OAuth and domain ownership | Real SDK2 read-only implementation and verified existing-issuer adapter | Operator-selected authenticated public HTTPS /mcp resource; actual issuer/JWKS or introspection, PKCE client registration/redirect, current account→printer grants; host the exact dashboard domain challenge token only after scoped authority |
| Review account | Synthetic local fixtures exist | Dedicated sample-data account/tenant and login instructions; must work for reviewers without personal accounts, private-LAN access, one-time codes or MFA handoff. Do not create or disclose credentials without approval |
| Review cases | Five positive and three negative scenarios below | Execute each through the actual review account/client; record real result and accessible walkthrough video; prepare release notes |
| Native Events acceptance | Internal detection, real SDK2 protocol and simulated signatures pass | Actual prior user notification failed. Use the labeled injected completion exception with the real client subscription; verify user-visible notification, deduplication and unsubscribe |
| Submission/publication | Nothing sent, uploaded or published | Approve final ZIP, exact project/domain/account scope and review material before upload/submission; approval of a draft is separate from publication |

Prepared positive scenarios: (1) list only the account's printer aliases and read one printer's minimal state; (2) subscribe to completion for an exact allowed alias and receive a clearly labeled injected test notification; (3) subscribe to problem events and receive a synthetic fault notification through the actual client; (4) retry/reconnect delivers one user-visible notification for a stable event ID without crossing printer accounts; (5) refresh then unsubscribe and demonstrate no subsequent notification. All remote fault/test injection is operator-controlled sample data; there is no public injection or physical fault tool.

Prepared negative scenarios: (1) another account's printer alias is forbidden and absent from catalogs; (2) cancellation, initial FINISH and progress-only data produce no completion; (3) revoked access or an unsupported native Events client stops/declines notification setup with a precise explanation. These are prepared review scenarios, not claims they have passed live.

Verified official local-distribution contact route: [Package your plugin](https://developers.openai.com/plugins/build/plugins) directs local-MCP developers to their **OpenAI contact**; it supplies no dedicated local-MCP email or enrollment form. If no account contact is known, the [official support route](https://help.openai.com/en/articles/6614161-how-can-i-contact-support) is the chat bubble at help.openai.com. That is a support entry point, not a promise of local Events access. Draft request (not sent):

> We maintain open-source multi-brand mcp-3D-printer-server and Bambu-only bambu-printer-mcp. Printers and credentials stay on users' LANs. We have a real MCP2 (2026-07-28) Events host with authenticated per-printer subscriptions and signed webhook delivery. We need the supported ChatGPT/Codex distribution and durable notification path for independently installed local servers, without a maintainer-owned central service or per-user public hosting. Does official local MCP distribution support Events and user-visible automations? What registration/client association, transport/authentication and review prerequisites are required? Our local diagnostics pass, but the actual first notification acceptance test failed; we will retest with a clearly labeled synthetic completion and no second print.

No support request is sent until its exact destination, content and account disclosure are approved. Public submission instructions and current requirements are in [Upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission).
