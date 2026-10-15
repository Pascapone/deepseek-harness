# Manual compaction transport diagnosis

This reference records the scope of the isolated [transport regression](transport-compaction.host.spec.ts). It does not establish the cause of the historical 60-second failures or claim a proxy repair.

## Request lifetime and timer owners

The [command UI](../../../client/ui-commands/src/client/service.ts#L406) calls generated `remote.commands.execute` without its own deadline. The [Client Gateway unary invocation](../../../api/gateway/src/client/index.ts#L431-L459) awaits `connection.rpc.call`; its [cancellation construction](../../../api/gateway/src/client/index.ts#L528-L532) combines registration retirement and an optional caller signal, not a timer. The [browser RPC](../../../client/connection/src/client/rpc.ts#L34-L70) posts JSON with that signal and awaits the complete response without adding a timeout.

The [Host HTTP bridge](../../../client/connection/src/http-bridge.ts#L41-L49) creates a request controller and aborts it with the default `DOMException` on premature response-socket close. It [waits for the handler before writing response headers](../../../client/connection/src/http-bridge.ts#L94-L97). The [Host RPC](../../../client/connection/src/rpc-host.ts#L260-L265) passes the request signal into the handler. The [Gateway method signal](../../../api/gateway/src/index.ts#L1155-L1159) preserves unary carrier signal identity. The [registry](../../../interaction/commands/src/index.ts#L421-L430) awaits the handler with caller cancellation; [the compact command](../src/index.ts#L66-L78) forwards it into the backend.

The [manual backend](../../compaction-basic/src/index.ts#L378-L429) synchronously enters real Agent maintenance, combines maintenance and request signals, and forwards the result to the summarizer. The [maintenance owner](../../../core/agent-loop/src/agent.ts#L183-L203) remains reserved until task settlement. The [transaction](../../compaction-basic/src/region.ts#L230-L280) checks cancellation before replacement, closes its marker, and flushes before releasing maintenance. These are distinct from the registry's earlier cancellation settlement.

No 60-second unary deadline is declared in these framework paths. The Connection [readiness deadline is 15,000ms by default](../../../client/connection/src/recovery-config.ts#L13-L30), with a 3,000ms warning; these govern a generation handshake, not an already dispatched unary command. Gateway's WebSocket heartbeat governs the separate stream carrier. Node HTTP inbound header/request timers must not be confused with an upstream response-header timer. The inspected [WebServer](../../../host/webserver/src/index.ts) does not configure a 60-second pending-response timeout. Browser, provider, worker/carrier overrides, and external proxies remain independent possible owners; source absence is not live telemetry.

## Regression and correlation

Run from the isolated checkout:

```sh
pnpm exec vitest run packages/compaction/command-compact/tests/transport-compaction.host.spec.ts
```

The test loads the command registry, compact command, Gateway, meter, and real Basic backend through Loader. A controlled fake summarizer returns after 90,000ms virtual time, including after cancellation. The real AgentLoop and Session transaction remain in charge. An ephemeral loopback Node HTTP server runs the actual bridge; the browser RPC uses actual Fetch. Authentication admission is outside this test and has its own Connection tests. No production profile, provider credentials, public proxy, or paid model is used.

The bounded trace captures browser/server aborts and command/compaction markers with monotonic times, RPC id, command id, and compaction id. It includes only ids and reasons, not headers or prompts. The cases assert eventual success beyond 60 seconds; a controlled socket close at 60 seconds; explicit caller cancellation; user Stop; and actual agent-owner disposal. Request disconnect preserves the exact bridge `AbortError` reason object through the summarizer signal and records `This operation was aborted`; caller Fetch preserves its custom Error locally. Stop preserves the user cause; disposal preserves the disposed cause and waits for quiescence. Cancelled attempts commit no summary or replacement even when the summarizer returns late, close once, and retain maintenance until cleanup. Retrying non-disposed agents and a subsequent maintenance task establish lock release.

## Remaining evidence

The historical browser URL, network failure, earliest aborting hop, effective public-proxy configuration, and live provider abort origin were not captured. A deliberately injected socket close reproduces the cancellation mechanism and text, not its original owner. Virtual time exercises JavaScript timers and transaction lifetime; it does not advance a remote proxy, browser-native deadlines, or OS socket clocks. This is not a real-browser/public-proxy acceptance test.

A follow-up isolated Dev reproduction must correlate the browser request id and URL/authority, caller cancellation source, Host socket close, command id, maintenance signal, and provider signal with monotonic timestamps. Use only the controlled fake summarizer and bounded ids/reasons. Compare direct loopback with the authorized public Dev route and identify the first abort before changing that owner's deadline. The production proxy remains untouched. No generic job runtime, asynchronous command-acceptance API, or ignored caller abort is warranted by this evidence.
