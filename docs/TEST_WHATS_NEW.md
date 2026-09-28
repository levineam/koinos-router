## Node startup and local RPC recovery

- Node startup waits for the internal RabbitMQ service to be ready. Health checks now include RabbitMQ and the local RPC, including unhealthy containers that still appear running.
- Memory-saver mode reduces service jobs and keeps the local RPC available. Monitoring resumes for an already-running node when the app reopens.
- Failed restarts and software panics no longer label chain data as corrupted or recommend repeated Quick Sync. Current-process chain validation failures still require attention.
- Health checks ignore errors from before a container's latest restart. Recovery reports restart failures and waits for RPC confirmation before calling the node healthy. Manual Stop and snapshot restore remain protected from concurrent recovery.

## Koinos AI mainnet API with backups

- Mainnet wallet, node dashboard and Koinos chain tools now try `https://api.koinosai.com` first, then `https://api.koinosblocks.com`, then `https://api.koinos.io`.
- Requests move to a backup after a timeout, transport/HTTP failure, invalid response or missing RPC method. Each endpoint gets one attempt per request, and later requests try the primary again.
- Existing custom RPC settings stay first. Default installations pick up the new order automatically without changing wallet or node data. Local-node health checks still test only the local node, and Harbinger/testnet earning connections keep their existing endpoints.
- Signed transaction retries reuse the same transaction. Chain or contract rejections keep their original error and do not trigger submission through a different provider.
- Master continues serving its API from its local node; its public gateway and metadata fallback configuration do not need changing for this client update.

## App interface languages

- Choose English, Español, Português (Brasil), Français or Deutsch when first opening the app. The dialog previews your choice and remembers it after Continue. Existing users see it once after this update.
- Change it later in **Settings → Language**, without restarting or losing an unsent message. The desktop companion and tray follow the same preference.
- Translations are included in the app and work offline. User content, wallet addresses, model choices and voice settings stay as entered. Some advanced help and service diagnostics still fall back to English; native-speaker feedback on the initial translations is welcome.

## Koinos Node with Local-Only AI

- Enabling Koinos Node now opens its UI while AI Privacy stays Local-Only. Node synchronization, production and explicit wallet actions use their own controls without requiring online AI.
- AI web tools, cloud connections and account access still follow AI Privacy. Wallet password checks and local API access controls remain enforced.
- Settings now explain the separate node networking behavior instead of directing node operators to enable online AI.

## Continuous voice playback clock

- Pocket, Windows and Kokoro/native WAV replies now share one turn-scoped Web Audio clock instead of opening a new player for each sentence. When the next sentence is ready, it is scheduled directly after the current one with no artificial media-element or audio-device gap.
- Quick start remains quick: KAI still begins with the first complete sentence. The queue can now place one prepared sentence ahead on the same clock while retaining one synthesis job and bounded audio memory.
- Listening receives the clock's exact audible window, queued duration and 1.2-second acoustic tail. Speaker echo remains marked during that tail, while only currently audible speech can be paused by a barge-in candidate.
- Stop, hide, turn replacement and wake-guarded interruption cancel the complete clock and discard scheduled or late audio by turn identity. System browser voices retain their native playback path and the existing local-only/no-fallback rules.
- Pocket diagnostics now report both synthesis-buffer underruns and output-clock gaps, helping distinguish a slow voice engine from a playback scheduler problem.

## KAI Eyes · screen and camera context

- KAI can now see the screen he is sitting on or a camera you explicitly enable. Open **KAI Eyes**, choose Screen and/or Camera, approve the session, then ask naturally: “What is this error?” or “What am I holding?”
- A visible orange indicator stays on whenever either source is active. Capture is session-only and stops on Off, hide, return to the app, quit or a brain change.
- Each source keeps only six small frames in memory at about one frame per second. Only the freshest frame is attached to the current turn; frames are not saved in chat history or written to a video/image archive.
- KAI can take one fresh higher-detail look when small text or an object needs closer inspection. Looking does not grant permission to click, type or control the desktop; those approvals remain separate.
- Eyes works only with an installed local vision model or a configured private OpenAI/Anthropic vision model. Network/text-only models are blocked, Local-Only still blocks private-provider egress, and local visual turns cannot overflow to Koinos Network workers.

## Working manual update checks

- **Settings → Check for updates** now contacts the installed app's actual Test update feed instead of only re-reading its packaged/source status.
- The row says whether Test is current, an installer is downloading, or the update service could not be reached. Automatic startup and four-hour checks continue unchanged, and source checkouts keep their existing git-based check.

## Smart-Turn semantic listening

- KAI now distinguishes a quiet pause from a finished thought with the local Smart-Turn v3.2 acoustic model. A breath after “Can you help me…” can stay part of the same question instead of being sent early.
- Smart-Turn runs in parallel with local Whisper inside an isolated worker and reuses KAI's existing ONNX/Transformers runtime. Audio stays on the computer, the worker releases after idle time, and no second heavyweight inference stack was added.
- Quick, Natural and Patient now tune the complete turn policy: trailing pause, semantic confidence and a bounded 2.5/4/6-second wait. Keep speaking to continue, or tap the mic to send immediately.
- If the semantic model cannot start, KAI visibly falls back to the proven silence endpoint. Wake phrases, the one-minute follow-up window, guarded “KAI” interruption and local transcription are unchanged.

## Silero listening for KAI Live Senses

- KAI now uses local Silero VAD v5 as its primary `speech / not speech` detector. It reuses the microphone stream and ONNX runtime KAI already owns, with one capture worklet and one inference lane rather than a parallel audio stack.
- Quiet room, Everyday room and TV nearby now tune speech probability instead of raw loudness. Conversation pause choices, Hey KAI, the 60-second follow-up window, local Whisper, echo rejection and the spoken “KAI” interruption rule stay in place.
- If Silero cannot initialize on a computer, listening starts with KAI's previous calibrated detector instead. Voice & listening shows which detector is active so Test feedback can distinguish the two paths.
- The Silero model, runtime code and worklet are bundled locally. Microphone audio is not sent to a VAD service, no CDN is used, and the installer reuses KAI's existing ONNX runtime instead of including a duplicate copy.

## KAI Live Senses architecture foundation

- KAI's listening, model work, tools, streamed text, voice synthesis and playback now share one turn identity and cancellation boundary. Stop, a wake-guarded interruption, or a newer request retires the whole old turn so late text or audio cannot reappear.
- Spoken replies remain active until both the model and the scoped audio queue finish. Voice failures leave the text answer intact, and tool approvals pause recovery timers while you review them.
- New local, content-free timing diagnostics measure capture, speech recognition/endpointing, first model text, first audible speech and total turn time. First-response and stream-stall watchdogs recover KAI instead of leaving the companion indefinitely busy.
- This is the shared turn/session boundary underneath Silero and Smart-Turn listening. Optional camera/screen senses will migrate onto it in later Test revisions.

## Verified Windows releases

- Test and alpha Windows releases now require Azure signing and Windows verification of the installer, portable app, packaged app and helper executables before upload.
- Updates verify the existing Michael Milas publisher identity. Signed releases include timestamps and a versioned signature report with checksums.
- SmartScreen can still show an “unrecognized app” reputation warning for a correctly signed download.

## Send from the KAI wallet with external producer custody

- Fix KOIN and VHP sends from the local KAI wallet being blocked when an external producer wallet is selected. Sends still require the local wallet password; external producer transfers still require external signing.

## Wallet submission results

- Show Koin Vault’s actual submission error and transaction ID instead of hiding the reason behind a generic failure message.

## Zero VHP allowance fix

- Accept the protobuf empty response for a zero allowance. Full-balance approvals and manual burn-plus-allowance requests now prepare correctly before an allowance has been set. RPC failures still stop preparation.

## Full VHP allowance with manual burns

- Koin Vault manual burns offer “Also allow my full VHP balance for production” (checked by default). The same phone-approved transaction burns KOIN and sets the PoB allowance to the VHP balance read during preparation plus the newly burned amount. Uncheck it to burn only.
- The allowance action offers “Use full VHP balance”; KAI reads the balance when preparing the review. Other deposits or burns outside this flow do not automatically change the allowance.

## Koin Vault VHP production allowance

- Add a phone-approved, limited VHP allowance for the official Proof-of-Burn contract. Choose an amount up to the current VHP balance; 0 revokes it. This replaces the remaining allowance and does not grant token-transfer authority to the hot key. Requires the companion Koin Vault backend update.
- Show failed block submissions separately from healthy running services. A VHP burn rejection remains visible until a successful submission is observed; it does not trigger Quick Sync or automatic restarts.

## Koin Vault signing feedback

- Signing setup errors now appear beside Review and sign and in a notification. If the connected wallet has not been selected as producer, KAI explains which button to click before preparing registration.

## Koin Vault producer signing

- Node → Producer wallet custody → Koin Vault now connects your phone with a QR code. Scan with Koin Vault's Connect App, approve the connection, then click Use this producer wallet while the node is stopped.
- Generate the separate hot key and use Review and sign with Koin Vault to register it. Koin Vault shows the full public key and requests your fingerprint/device passkey before submitting. The same flow supports burns and KOIN/VHP transfers.
- Producer selection persists across restarts. The temporary phone connection expires after 30 minutes and reconnects with a new QR. Production continues without the phone once registration is verified.
- Pending approval blocks conflicting custody/key/network changes. Rejections, expiry, uncertain delivery and disconnect failures retain clear status; requests are never automatically retried. KAI checks submitted operations on-chain and still requires matching on-chain registration before production.
- Mainnet only. The Koin Vault and original wallet backend updates enable this integration; an older backend shows an update-needed message. Existing Kondor/offline signing remains available.

## Kondor producer signing

- Keep the producer account key in Kondor on a separate computer. The new Mainnet Producer Signer at https://koinosai.com/producer-signer/ reviews and signs registration, KOIN burns, and KOIN/VHP transfers.
- Node → Producer wallet custody → External signing now includes the signer link, unsigned JSON download and signed JSON import. No WIF export or KAI installation is needed on the Kondor computer.
- Accept Kondor mana reductions within the prepared maximum while verifying the new transaction ID and producer signature. All operations, accounts, recipients, amounts, chain ID, nonce and hot public key stay protected. Keep Kondor Use free mana off.
- The browser signer checks canonical Mainnet contracts and exact burn approvals. Signing requests and broadcasting remain separate explicit user actions; registration still needs on-chain verification before starting production.

## Cleaner node dashboard

- Node Details now has its own titled card directly below the running status, followed by Node value, Profit & projected return, Koinos network and Activity feed.
- Removed the network source, connected-peer and block-definition footer text. Loading, stale and unavailable counts still show a short status in the network header.
- Added consistent spacing between section headings, action buttons and tiles, including View block producers.

## Live network producer counts

The blockchain Dashboard now displays live numbers directly: active producers over the last 28,800 blocks (about 24 hours), producers with a block in the last 2 hours (the green status rule), and total tracked producer accounts. Tracked includes VHP holders who may not be producing; these are accounts, not a census of every running node.

Data comes from KoinosScan’s public producer API, refreshes at most once a minute, and loads independently of wallet/node status. Counts remain available when your local node is stopped. Failed refreshes show explicitly stale data for at most ten minutes, then unavailable; missing data is never shown as zero. Mainnet counts are not shown for other networks. Local-Only blocks the request.

Definitions verified from [the explorer’s producer display](https://github.com/interfecto/koinos-token-tracker/blob/aa11ddfc19adb9ef0afa0e244b363706fcb732fd/internal/api/explorer.html) and [its indexed producer query](https://github.com/interfecto/koinos-token-tracker/blob/aa11ddfc19adb9ef0afa0e244b363706fcb732fd/internal/store/sqlite.go). The live API response is checked during Test release verification.

## Network information on the Dashboard

- Moved connected-peer information into a dedicated Koinos network section on the blockchain Dashboard.
- Added a supplementary button opening KoinosScan’s producer list. Local peer connections remain distinct from the live network producer counts above.

## Node health, Quick Sync and storage

- Replay validation failures, fatal chain errors and repeated producer request timeouts now show warnings on Node and Dashboard, even when Docker containers look running or automatic recovery is off. Replay mismatches stop automatic restart loops. Exited containers are included in status.
- Quick Sync removes stopped node containers to release mounts, checks data folder locks before downloading, and explains when a full Windows restart may be needed. Failed installs roll original databases back; an interrupted restore blocks node starts until recovered.
- Manage backups on the Node screen lists previous chain copies with dates and sizes. Delete individual copies after confirming the restored node works. Cleanup is never automatic and does not target active data, wallets or producer keys.
- Node status shows connected peers from the latest P2P report (about once a minute). A capped list shows a lower bound with “+”; missing reports show unavailable. This is this node's connections, not the total network size.
- These changes do not establish or fix the underlying Koinos replay-validation cause. Save full chain logs and Docker image versions if it repeats after a verified restore.

## Brain permissions and node controls

- Choose “Always allow this action” when chat or KAI asks to save a Brain memory. Revoke it in Connections → Connection settings → Always allowed actions. Forgetting remains separately approved.
- The node screen shows only Stop node while running, or Start node while stopped. Controls are disabled during node operations, including quick sync.

# Brain is now the single memory store

Chat and desktop KAI save and recall memories through Brain. Earlier facts migrate automatically into encrypted Brain storage; the legacy store is cleared only after a successful save. Manage memories in Brain → Memories. The old Core memory API and tools are retired. Brain remains private to eligible desktop models and is not available to network workers.

### Azelma Pocket by default

- KAI now selects Azelma Pocket on Windows x64 and Linux x64 for new profiles and profiles still using the former Bella default. Existing alternative voices and later manual choices are preserved.
- When KAI opens with Azelma selected, its pinned voice pack (about 201 MB) downloads automatically if missing. Progress and retry remain available in the compact companion. Existing voice files are reused; hiding KAI pauses setup and reopening resumes it.
- Voice reply and microphone toggles keep their existing settings. Unsupported computers retain their existing voice setup. English speech stays local.

### Release checks and code completion

- Koinos Code keeps its completed status when an approval acknowledgement arrives after the answer. A delayed-response browser regression now checks the full approval, file write and final answer.
- Test publication now requires macOS app tests and the explicit MCP Agent-mode replay, in addition to the existing Linux and Windows checks. The native drag check respects macOS pointer hit testing.

### Faster chat and local recall

- Main Chat and desktop KAI now share intent routing. A personal-memory question such as “What is my daughters name?” bypasses the tool planner, web search, memory writes and connected-account sessions, including when the globe is enabled. Ordinary conversation also answers directly.
- Local memory is retrieved once per store for the final reply, not repeatedly during planning. Family plurals/possessives match reliably; the legacy memory search index is reused until memories change. Model-proposed memory saves require explicit approval and are not available for recall requests.
- Real actions retain bounded planning and recent conversation context. Connected workflows keep their longer budget and fresh read-after-write verification; unrelated account tools no longer receive an unconditional ranking boost. Repeated discovery, malformed planner output and repeated failures stop sooner.
- Connected sessions and result polling now start lazily, only for actual connected work. Stop cancels research and recall, and a stopped planning phase cannot start a second answer request. The displayed first-reply time now includes planning and retrieval.
- Partial connected tasks report actual returned results instead of incorrectly claiming that nothing changed. See [the routing audit, regression coverage and remaining performance checks](CHAT_OPTIMIZATION_2026-09-11.md). Hardware/model latency still needs measurement on the target Windows machine.

### Reliable connected actions and voice approvals

- Local-business requests now use structured OpenStreetMap place data instead of trying to infer practice names from directory pages and search advertisements. KAI receives spreadsheet-ready names, addresses, phones, websites and source links, keeps those rows through the connected-action plan, and does not count a newly created blank Sheet as completion.
- DuckDuckGo and Bing advertisement/tracking redirects are excluded from search results and citations.
- Minimizing or hiding KAI stops microphone capture and speech but no longer cancels an active text reply or an already-approved connected action. Stop, closing the window and navigation still cancel; an unapproved action still waits for visible review rather than running invisibly.
- Public research now falls back from DuckDuckGo to Bing's compact search feed before the narrower Wikipedia fallback, uses browser-compatible request headers, recognizes block/challenge pages, and tries more independent sources instead of letting one inaccessible site derail the answer.
- Approval dialogs for public research and a specific connected-account action now offer **Always allow this action**. The grant is encrypted locally, stays scoped to that capability and account/action revision, and can be revoked under Connections → Connection settings.
- Compound requests such as researching local businesses and putting the results into Google Sheets now stay in one connected workflow. Natural phrases such as “look up” and “put in a Sheet” are recognized, public research remains separately reviewed, and ordinary chats no longer inherit the connected planner's long retry loop.
- Pocket voice now uses an adaptive jitter buffer throughout each sentence. Fast generation still begins early; slower generation waits for a clean sentence, and a mid-reply CPU slowdown rebuilds an audio lead before resuming instead of stuttering through tiny fragments.
- Direct connected-app requests now expose only the relevant connected-action tools to KAI's planner. An unrelated Brain lookup can no longer replace a Drive or Calendar action, and KAI gives a short failure statement instead of manual instructions when no write actually ran.
- When KAI must leave the public network for a connected action, it now prefers a configured private OpenAI or Anthropic model over silently selecting a weaker local model. A local model explicitly selected by the user remains selected.
- Explicit Drive, Calendar and other connected-app requests now begin with actual account discovery. Small local models get a bounded corrective planning pass instead of falling back to a generic “I do not have access” reply after an enabled account was found.
- Calendar, Google Drive and other explicit connected-app requests now leave Koinos Network inference and use an available local/private desktop model before any account data is read. If none is available, KAI explains the required model instead of falling into desktop observation and showing a misleading error.
- Compact and expanded KAI use the same connected-action path. Keeping the text box open is no longer relevant.
- Voice playback and listening stop cleanly while private tools and native approvals are active, preventing Pocket KAI audio from overlapping an approval or the following reply.
- Connected accounts still need **Use in conversations** and the required actions enabled under Connections → Connected apps → Manage access. Actions prompt once unless you explicitly choose an action-scoped always-allow grant.

### Smoother GPU earning and accurate producer status

- Automated network probes now prefer one resident model per earning session, avoiding background model unload/reload cycles every few minutes. User-selected network models remain available.
- Block-producer checks inspect the actual node service when recent log output has no VHP estimate. A temporary or noisy log gap no longer claims the node may have stopped, while stopped, syncing and recovering states remain distinct.

### Security and reliability sweep

- Hardened remote API access, local browser access, desktop window permissions, wallet files and public web requests.
- Fixed truncated or incorrectly typed Agent Network results, lingering network requests after Stop, stalled MCP responses, and download failures that could crash the app.
- Local-Only earnings status stays offline while earning is stopped. Email requires encrypted delivery; calendar connections and event text have stronger validation.
- Updated vulnerable dependencies and added security regression checks to the Test release workflow. Scheduler authorization and request-handling fixes are included in the repository and require a separate server deployment.
- See the [audit findings, validation and remaining coverage](SECURITY_SWEEP_2026-09-10.md).

### Clearer navigation and node status

- Sidebar menu groups now expand one at a time. Open Workspace, Your toolkit or Contribute to reveal its options; the previous group retracts.
- Quick sync clearly shows that the node is stopped for a snapshot restore. Start/stop controls stay unavailable during the restore, and saved key registration no longer implies active block production.
- Dashboard status uses one colored dot, including an amber state for quick sync.

### Agent Network private service preview

- Agents content scrolls within its workspace while the app navigation stays in place.
- Added Agents with Discover, My agents, Jobs, Earnings, Activity and separate relay settings. Create a service from a template or reviewed workflow, request a signed free quote, run it, and inspect the encrypted result.
- Includes a headless client and independent relay implementation. Hosted workflows use isolated job data and installed local models; private Brain, app credentials and the earning wallet are unavailable to callers.
- This is the first foundation for the Agent Network v1 proposal. Paid services remain disabled: the new custody contracts, sponsorship and paid-network acceptance still need deployment and integration. No KAI is moved and no new rewards are emitted. See [setup and current coverage](agent-network/README.md).

### Cleaner producer wallet controls

- Producer address and public-key fields now match the node settings, with rounded borders and room to read their values. The Copy button sits beside the public key, actions wrap on smaller windows, and external signing has clearer spacing.

### Connected chat and instant workflows

- Main Chat and desktop KAI can discover connected accounts, inspect selected action inputs, and chain app actions using returned file/message IDs. Ask for a folder and spreadsheet, a document, an appointment, or a message. Each external call still uses exact native review.
- Ask KAI to find, inspect, run, check, stop or resume a saved workflow. Unreviewed drafts must first be saved in the builder; running a workflow does not enable a schedule.
- One-time action chains can run from chat and be saved as disabled workflow drafts. The tool loop now allows up to 24 steps.
- Action receipts appear in chat and under Connections → Connected apps. Partial and uncertain outcomes remain visible after restart; uncertain writes cannot auto-retry. Inspect the destination before acknowledging an uncertain receipt.
- Manage access now includes guidance and action-search shortcuts for Google Calendar/Docs/Sheets/Drive, Discord Bot, Slack, Gmail, Teams, Notion, GitHub issues, Todoist and OneDrive/Excel.
- Public research can continue after a private Brain lookup through a desktop-only tool that reviews the exact public query or URL. Private observations still cannot flow into ordinary Core/MCP tools.
- Your accounts must have the required selected actions and **Use in conversations** enabled. Provider scopes and actual account compatibility still need testing in your installation. Discord messages use the bot/app identity. No new hosting environment variables are needed.

See [connected chat setup and testing](KAI_CONNECTED_CHAT.md).

### External producer wallets

- Koinos Node now supports a watch-only producer address separate from the KAI earning wallet. Generate/copy/rotate the hot block key, verify registration on-chain, and prepare externally signed registration, burn and transfer transactions. Automatic funds operations are disabled in external mode. See [setup and offline signing](EXTERNAL_PRODUCER.md).

### Steadier KAI animations

- The Launch KAI card no longer jumps during desktop-provider status refreshes.
- Speaking keeps one continuous arm/head pose between audio phrases and buffering pauses. The mouth still follows audible playback, and the status bubble keeps a consistent size.

### KAI-managed connection fix

- Fixed the desktop account-service wiring that incorrectly showed managed connections as disabled even when the server was enabled. Connections now shares the account server and sign-in service used by Settings. Existing server environment variables and personal Composio keys need no changes.

### Workflows with a visual flow builder

- **A cleaner sidebar.** Brain, Workflows and Connections sit flush beside the main navigation, with compact left-aligned menus.
- **Build connected routines.** Drag nodes, connect branches, edit their settings, zoom/pan, auto-arrange and undo changes. Includes conditions, switches, merges, loops, sub-workflows, parsing, transformations and isolated JavaScript.
- **Build with KAI.** Describe a routine, review Copilot's graph proposal or choose from nine templates. Discover suggestions from selected context, optionally once a day.
- **Run when it matters.** Manual input, time-zone schedules, app/source change watches and Composio app events. Inspect each run's data, timing, retries and approvals on the canvas or in history.
- **Tasks moves into Workflows.** Existing scheduled prompts migrate with their timing and previous chat links; old timers stop to prevent duplicates. Brain's personal to-dos remain.
- **Review before changes.** App and Brain writes pause for approval, including individual items and nested flows. Preview uses simulated capability outputs without external changes.

Read the [Workflows guide](KAI_WORKFLOWS.md) and [OpenHuman coverage comparison](OPENHUMAN_WORKFLOW_COVERAGE.md). Live Composio events need the matching server update and KAI sign-in. Existing connection environment values remain valid; no new Composio API key is required. Schedules and workflow reasoning run on your desktop while KAI is open, using installed local models.

### A connected Brain, with Awareness

- **The same 1,516-app catalog in both connection modes.** Search the full list immediately, filter eight stable categories or authentication types, and browse compact logo cards. Category changes no longer repeat or grow the menu.
- **Sidebar navigation.** Brain, Workflows and Connections now use a left rail like Koinos Node.
- **A richer Brain.** Explore source/topic relationships, search by source/topic/date, maintain goals and tasks, and compare memory changes with their original text.
- **More sources.** Select local text folders, KAI conversations, public websites, RSS/Atom feeds and GitHub repositories, alongside your connected app reads. Each source has its own refresh control.
- **Awareness.** Choose Off, Observe or Assist, select what KAI can read, add custom background checks and use an installed local model for summaries, briefings and reviewable suggestions.
- **Visible background work.** Inspect the queue, results, retry/stop controls and activity; start reviewed workflows for follow-through.
- **Portable knowledge.** Export a new Markdown/Obsidian folder with linked sources, topics and memories.

Read the [Brain and Awareness guide](KAI_BRAIN_AWARENESS.md) and [OpenHuman feature coverage](OPENHUMAN_BRAIN_COVERAGE.md). The full app catalog includes OAuth, API credentials and other connection types; provider/project setup still applies. This update needs no new server environment variables.

### Connect without a settings loop

- **App cards keep the chosen app open.** Connect checks the current server status and explains whether KAI sign-in, a personal key, or a privacy change is needed.
- **Server setup and desktop sign-in are shown separately.** When the server enables Composio, KAI-managed connections need only your KAI account sign-in. Expired sessions get a clear sign-in prompt.
- **Key errors identify the right setting.** A rejected server Composio key asks the administrator to check it, without reporting your desktop sign-in as expired.
- **Fresh status without losing your place.** Refresh picks up a newly enabled server, keeps useful errors visible, and preserves a key or connection method being edited.

### Easier app connections

- **Explore your apps.** Search a catalog with platform logos, categories, and a guided browser sign-in. See your connected accounts and manage each one separately.
- **Choose who manages the connection.** Use **KAI-managed** connections after the server administrator enables Composio, or save your own Composio project key. Both use the same catalog and sign-in flow.
- **Choose what KAI can use.** Select actions, allow conversation access, and bring selected read-only data into Brain through ordinary input fields. Optional source refresh runs every 20 minutes while KAI is open. Actions that can make changes still require review.
- **Keep account boundaries clear.** Switching methods keeps projects separate. Personal keys stay encrypted on the desktop; the shared key stays on the server. Custom APIs remain available in their own tab.

## Companion workspaces: Brain, Workflows and Connections

- **Brain:** editable notes, people/projects/preferences, tags, pins, goals, a category map, text imports, selected API sources, optional 20-minute sync, and Markdown export. Relevant context supports private/local chat and desktop KAI.
- **Workflows:** visual ordered steps, local-model drafting, templates, manual/recurring schedules, API steps, conditions, approvals, cancellation and persistent run history. Reasoning uses installed local models; private provider keys remain reserved for attended chat.
- **Connections:** self-managed tokens/API keys, starter GitHub/Notion/Slack/Home Assistant operations, custom APIs, request testing and separate agent/background-read grants. Keys are encrypted in the desktop app; writes and model-requested calls ask for approval.
- Includes a [setup guide](KAI_COMPANION_QUICKSTART.md) and [full companion feature inventory/roadmap](KAI_COMPANION_ROADMAP.md), distinguishing this implementation from future OpenHuman-inspired capabilities.


### Tidier Developer Tools

- **Aligned fields and actions.** Multi-agent, Playground and Pipelines now use consistent labels, field heights and spacing. Saved-team controls stay together, and forms stack cleanly in smaller windows.
- **Compact agent cards.** Tool lists expand when needed, show the selected count, and keep checkboxes beside readable names. Role instructions stay in a normal text font; JSON editors keep their code formatting.
- **Clearer JSON controls.** Builder updates sit beside each JSON editor, with a reminder that saving and running use the JSON. Existing team definitions and execution behavior stay the same.

### More natural conversations and fewer provider cut-offs

- **Room to finish your question.** In **Voice & listening → Conversation pauses**, Natural allows a short thinking pause, Quick sends sooner, and Patient gives you more time. Natural is the default. Words spoken while KAI is still recognizing your question stay together in one request. This uses the existing local listener; no extra download is needed.
- **Interruptions still need “KAI.”** Recognizing the name stops the old reply, even if you are still finishing your new question. Ordinary dialogue during a reply cannot interrupt it. Stop and hiding KAI cancel pending input and reply audio. Microphone Off and listening-setting changes discard unfinished input.
- **Fix for frequent “output limit” errors.** Private Anthropic/OpenAI action planning has a larger allowance. If a plan hits that limit, KAI makes one attempt with more room before any action runs. Incomplete plans cannot reach the tool runner, and existing approvals still apply.
- **Long answers can finish.** A confirmed output limit can continue the answer once with the same provider. Recovery uses the original Stop button and deadline. If the answer is still too long, KAI keeps the partial text and explains how to continue, instead of cancelling its speech. A recovery request uses your provider account and may add usage; account errors and disconnected streams do not automatically retry or switch providers.

Pocket's continuous audio, character effects and voice selection stay in place. Conversation pauses change how long KAI waits after you speak, not the voice's synthesis speed. This is pause handling, not speaker identification or a new semantic turn-detection model.

### Pocket voice setup, right where you need it

- **A visible download button beside the voice selector.** Pocket setup now sits at the top of **Voice & listening**, with a clear blue **Download Pocket voices** button and progress. There is no need to scroll past the other voice settings.
- **Download directly from KAI’s prompt.** When a selected Pocket voice is missing, the desktop message includes the download button, progress and retry. Once ready, click **Try Alba** (or your selected Pocket voice) right there.
- **An easy sample after setup.** The same voice panel offers a named sample button after the download. Downloads still require your click, and installing alone keeps your existing voice selected.

### Try Pocket voices with KAI

- **Four optional English voices.** Download Pocket once in KAI’s **Voice & listening** panel, then choose Alba, Marius, Javert or Azelma. Your existing voice stays selected until you change it. The download is about 201 MB; no account, Python installation or subscription is needed.
- **Audio starts while the sentence is still generating.** Pocket sends small audio chunks to a continuous player. Cute, Squeak and Classic effects keep their pitch and timing across those chunks. Your usual reply-timing choice returns when you select another engine.
- **Compare on your computer.** “Hear a hello” uses the real engine, and the panel reports the last sentence’s startup time and buffering pauses. This is a trial, not a promise of faster speech on every computer. The first use after loading is slower.
- **Local and easy to stop.** Pocket runs in an isolated CPU process. Stop, voice-off and hiding KAI stop its audio; unused voices release their memory. Existing microphone behavior and the spoken “KAI” interruption rule are unchanged. This English bundle does not add Korean speech.

### Smoother thinking and clearer spoken answers

- **A proper hand at his chin.** KAI now rests a curled hand under his face, with upright knuckles. The same grip holds his magnifying glass while searching.
- **Steady thinking and searching.** His arm eases into position, his head nods gently, and web searches keep their animation between lookup steps. A greeting ends when KAI starts working, so the poses do not compete.
- **Answers without spoken web addresses.** Voice replies skip full URLs, numbered citations and source lists. Useful source links remain clickable in the text chat.
- **Emoji in plain words.** Common emoji get short names such as “smiley face emoji,” “thumbs up emoji” or “robot emoji.” Combined emoji are handled as one symbol. This works with fast Windows, browser and natural voices, including streamed replies.

### KAI can work in your browser and desktop apps

- **“Open Tubi” just opens Tubi.** Known website commands launch your default browser immediately. You can also give KAI a complete website address.
- **Ask about what is on your screen.** On Windows, KAI can inspect visible window controls, switch windows, click buttons, type into text fields and scroll. A vision-capable model can also see screenshots and propose visual clicks or drags. Try **“Play the movie on my screen.”** If several movies could match, tell KAI the title or point at it first.
- **Your existing browser session.** KAI works with the apps and browser where you are already signed in. It checks the updated screen after each action; availability depends on how the app exposes its controls and how well your selected model understands the task.
- **You stay in control.** Approve each desktop task once. Purchases, rentals, messages, destructive actions, unknown controls and visual clicks require another confirmation. Visual targets are marked on screen. **Ctrl+Alt+Backspace** stops control immediately; KAI reserves **F8** if that shortcut is already taken. The red Stop button and **KAI options → Stop desktop control** also work. Closing or hiding KAI ends permission.
- **Private to your desktop.** Choose an installed local model or your own OpenAI/Anthropic connection. The permission prompt tells you whether screen text and screenshots will go to your API provider. Desktop observations never overflow to network workers. Screenshots are held in memory for the current task and are not saved as chat attachments.

Passwords, CAPTCHAs, administrator prompts and terminal commands remain manual. Protected video cannot be inspected through screenshots; KAI uses visible player controls. No streaming subscription, rental or paid API connection is included or enabled automatically.

### Clear status bubbles and Korean Windows speech

- **The whole status bubble stays visible.** Thinking, speaking, microphone and Stop changes now update the native desktop window's visible area, including while KAI rests on the bottom edge.
- **Korean replies use an installed Korean Windows voice.** Your usual voice remains selected for later replies, and Cute, Squeak and Classic effects still apply. If Korean speech is missing, KAI explains how to add it through **Voice & listening → Add Windows voices**, followed by **Refresh voices**. Nothing is installed automatically.
- **A missing language no longer looks like a broken audio format.** KAI shows one helpful message, keeps the full text answer and lets the next conversation continue normally. Internal Windows IPC error text is removed.
- **Continuous replies handle different voice sample rates.** An English introduction and Korean answer can play together without a rate-mismatch error.

### A proper wave and faster character voices

- **A natural little wave.** KAI bends his elbow and shows an open palm. His wrist waves gently instead of swinging the entire arm backward. This works on the desktop and while resting along the edge.
- **Fast Windows voices with real character effects.** Open **Voice & listening → Use fast Cute KAI**. The installed Windows voices now produce local audio that KAI can actually reshape, so Cute KAI, the Squeak slider and Classic deeper KAI work even when the browser voice engine ignores pitch. No neural-model download or new account is needed. The list includes supported installed Windows and desktop voices, which vary by computer.
- **More installed options.** **Add Windows voices** opens Windows Speech settings. Install an available speech voice there, then **Refresh voices** in KAI. Only voices exposed by Windows' supported speech APIs appear; a Narrator-only voice is not promised to work in other apps.
- **Choose how replies start.** Quick start plays the first complete sentence and works best with fast voices. Head start prepares two sentences. **Whole reply** prepares and joins the reply audio first, then plays it continuously, avoiding waits for synthesis between sentences. It takes longer to begin; exceptionally long answers are read in bounded sections.

An explicitly selected browser Windows voice is upgraded to its matching installed voice when found. Existing natural voice selections stay selected. The four natural voices share one engine, so switching among them is not a speed upgrade. Stop, KAI-name interruptions, follow-ups, microphone cleanup and the shared wallet/node profile are preserved.

### Pick KAI up and bring him along

- **A little robot in your hand.** Pick KAI up by dragging him. His arms and legs dangle, his cape sways, and his body leans with your movement. Dropping him on the desktop gives a soft settling bounce.
- **A place on the desktop edge.** Drop KAI near the bottom of the usable screen and he rests with his hands along the edge above the taskbar. Slide him left or right, or pull upward to lift him back onto the desktop. His resting position is remembered.
- **No more bottom-to-top jump.** Movement follows the monitor under your cursor and keeps the native window inside that monitor's usable area, including when chat is open or displays change.
- **More expressive activities.** Thinking brings a hand to his chin with a question mark and a little idea bulb. Actual web searches bring a moving magnifying glass and floating pages. Speaking adds hand gestures; the mouth still follows audible playback.

Click KAI to open or minimize chat. **Animation off** and the system's reduced-motion preference stop the movement while retaining the edge pose. Your voice preferences, microphone controls and ongoing conversations continue to work while KAI is moved.

### KAI finds a cute little voice

- **Cute KAI is the new character voice.** Bella with a brighter, higher, lightly squeaky character treatment. The **Squeak** slider in **Voice & listening** goes from Gentle to Extra squeaky. Pitch and pacing are handled separately, so a higher voice does not race through every word. Classic deeper KAI and the unprocessed voices remain available.
- **Hear it immediately.** With Bella selected, **Hear a hello** uses a tiny bundled recording and applies your current character settings. No model startup or download is needed for that preview. Conversations reuse the same local voice files you already installed; first-time setup still requires a click.
- **Start with the first sentence.** **Quick start** is now the default. KAI speaks the first complete sentence as soon as its audio is ready while preparing the next. It no longer waits for two sentences. **Extra buffering** remains an option for slower computers; pauses can still occur when local synthesis cannot keep up.
- **Stay ready to talk.** While KAI is visible with voice replies enabled, the installed voice engine stays loaded. Setup prepares the first-use speech components too. Hiding KAI or turning off voice replies stops the keep-warm requests; idle voice memory is released after two minutes. No background microphone use is added.

This update selects Cute KAI with Bella once. Your choices after that persist. Open **Voice & listening → Hear a hello** to try it. The reference guided the character's pitch and energy; this is an original local character treatment, not a clone or ElevenLabs connection. Voice generation and processing stay on your computer, with no new account, API key or subscription.

### Meet the new KAI

- **A new character, inspired by your reference.** Glossy white armor, a cobalt cape and headset, a K badge, and an expressive cyan face. KAI looks around, blinks, leans in to listen, thinks, nods while speaking and gives a cheerful greeting. The mouth still moves only during audible playback.
- **A brighter app, from end to end.** Pearl and soft blue surfaces, deep navy text, electric blue controls, a new app icon and clearer navigation groups. Chat, Documents, Compare, Models, Tools, Tasks, Earn, Settings, Code and the embedded wallet/node screens share the new design.
- **A proper welcome from KAI.** The new chat home has a character greeting and three starting points for questions, building and ideas. Clicking one puts a draft in the composer for you to edit and send. The source/model controls have their own row, with more space for your message.
- **A lighter desktop companion.** Matching white conversation and voice cards, blue controls and a clear green mic indicator. KAI still launches compact. Chat, listening, interruptions and voice preferences work as before.
- **Room for smaller windows.** A Conversations button opens chat history in narrow windows. Model controls, forms and cards resize with the workspace. Keyboard focus and reduced-motion preferences are supported.

Install over the existing **Koinos AI Test** app after quitting it from the tray. Your shared profile, chats, wallet, downloaded models, private desktop provider settings and live earning/node data stay in place. This is a visual revision; it adds no new computer permissions or automatic microphone use.

### Your own OpenAI or Anthropic connection

- **Settings → Desktop AI connections** now accepts your own OpenAI and Anthropic API keys. Save a connection, then **Test & refresh models**, or enter a model ID from your provider account. The connection check lists models; it does not generate a paid test reply.
- **Choose your source in Chat**, then choose a model. **Use in chat** opens that picker from Settings. The desktop KAI **Brain** picker also includes connected models. Chat, Research, Agent and KAI's app tools use your chosen provider, with streamed answers and Stop support.
- **Private to your desktop.** Keys use encrypted OS storage and are never returned to chat pages, included in network model lists, or used for earning jobs. These connections are unavailable through the local/public API, remote access, Teams or scheduled tasks. Provider failures stop the request without switching to another source.
- **Your provider account pays for usage.** Questions, conversation context, attachments and relevant app tool results go directly to the selected provider. Local-Only blocks these online requests; choose **Local API → Privacy → Local-First** to allow them. This does not require a network wallet for provider chat. Your earning node retains its existing models and data.

Your API key is separate from your ChatGPT or Claude app login. Models and access depend on your provider account. Choosing a provider does not change KAI's locally generated voice or local microphone transcription.

### Your app, a question away

- **KAI can use the app's tools.** Desktop conversations can search the web, read pages and use connected tools, memory, workspace files, email and calendar through the existing permissions. Web access follows Privacy settings; Local-Only stays offline. Include your city for weather, or KAI can ask for it.
- **Ask about your real app.** Check KAI balance and pending earnings, KOIN/VHP wallet balances, node health and recent KOIN rewards, installed/downloadable models, documents, saved chats, scheduled tasks and connection status. Unavailable or stale data is reported instead of being treated as zero.
- **Ask KAI to do things.** Model downloads/removal, earning controls, node start/stop, document editing, scheduled prompts and supported settings changes show a native **Allow once** dialog before running. Tool activity appears in the conversation; web sources are clickable.
- **“Open up the application.”** KAI can bring up the main app or a specific screen while staying available beside it. Financial transactions, wallet passwords/backups, Docker setup and coding sessions use the existing app forms and their approval steps. Disabled sections open Settings first.

Simple balance/model questions go straight to the relevant app data before answering. Other tool requests may take extra model steps. Stop or hiding KAI cancels pending approvals and further steps; an action the app has already accepted may keep running. KAI's voice, follow-ups, shared wallet and live node data remain in place.

### KAI interruptions, smoother sentences and a deeper robot voice

- **Say “KAI” to interrupt.** Say the name alone to stop the reply, or begin your new question with it. “Hey KAI” still works. Ordinary speech no longer interrupts a reply, including profiles that previously disabled the name requirement.
- **Keep talking after a reply.** Follow-ups still need no wake phrase for a minute after KAI finishes. A question spoken immediately after a separate “KAI” cue is retained while the cue is being recognized.
- **Complete sentences before playback.** KAI no longer speaks a short opening fragment while the rest of that sentence is still being synthesized. Longer sentences are assembled into one audio clip, and the next sentences are prepared ahead. This favors smoother speech and can increase the initial wait; slower computers can still pause between sentences.
- **The same voice, a little more KAI.** Heart stays the default voice. The new **KAI** voice character sounds slightly deeper with a light electronic texture. Choose **Natural · original sound** under **Voice & listening → Voice character** to compare. No additional voice download is needed.

### Calmer listening with a TV nearby

- **TV nearby** is the new default microphone setting. It requires stronger, longer speech and rejects more quiet background dialogue. **Voice & listening** also offers balanced and quiet-room settings, with a live microphone level indicator.
- **Say “Hey KAI” to interrupt a reply** is on by default. Movie dialogue no longer pauses or replaces a reply unless the name is recognized. You can turn this option off for immediate speech-onset interruption in a quieter room. Follow-up questions after KAI finishes still need no wake phrase; tapping the mic always interrupts directly.
- The mouth moves only when audio actually starts playing, and stops when audio pauses or ends. Preparing a voice no longer looks like silent talking.
- KAI prepares a shorter first clause and loads the installed voice engine while listening or thinking. This reduces startup work after text arrives. Local voice generation, particularly compatibility mode, can still take several seconds.

KAI does not recognize your individual voice yet. Sensitivity filters sound level, not speaker identity: a loud movie can still trigger a follow-up after the reply. Keep background sound below the listening level, move the microphone closer, or turn hands-free listening off when needed.

### KAI listening stability repair

- Fixed a reply getting stuck on pause when another sound arrived during transcription.
- Background noise no longer blocks a voice that is still being prepared. KAI briefly checks your microphone level when listening starts and filters steady hum more reliably.
- The microphone indicator stays on while listening, recognizing words and replying. Temporary recognition errors keep the same microphone session open.
- Unconfirmed interruptions have a time limit, so they cannot leave KAI silent indefinitely. Confirmed questions still interrupt and retain the conversation.

### Natural voice startup repair

- KAI now automatically recovers when Windows cannot load its native voice DLL. The compatible engine uses the same local Heart, Bella, Puck and Emma voices and your existing voice download.
- The setup card shows a clear error and **Retry natural voice** if setup fails, instead of staying on “Warming up.” Retrying verifies and reuses downloaded files.
- Compatibility mode can take longer to generate speech. Replies still start playing as phrases become ready, and Stop and interruptions cancel pending audio.

### A more natural conversation with KAI

- **Heart is now the default voice.** KAI offers a one-time 93 MB natural-voice download right beside the robot. No account or subscription is needed. The old automatic computer voice no longer takes over silently. You can preview Heart, Bella, Puck and Emma in **Voice & listening**.
- **Tap the mic and talk.** You do not need a wake phrase or a second tap to send. Pause briefly and KAI answers. The waveform button enables “Hey KAI” when you want to start hands-free.
- **Keep the conversation going.** After waking KAI, ask follow-up questions without repeating its name. KAI stays in conversation for a minute after each reply. Say “That’s all” to return to wake-only listening, or “Stop listening” to switch the microphone off.
- **Interrupt naturally.** Start speaking during a reply and KAI pauses its voice. Once your words are recognized, it stops the old response and answers with the earlier conversation and your new request in context. Echo cancellation and a local echo check help prevent KAI from answering itself.
- **Just the robot by default.** Voice questions do not open the chat panel. Click the chat bubble to open it and the minus button to minimize it again. A Stop button is available beside the robot during replies.
- **More responsive listening.** Quieter speech is detected, pauses are shorter, and capture continues while earlier audio is being transcribed.

Listening remains opt-in, with a green microphone indicator. Hiding KAI, returning to the full app or quitting turns it off. Microphone audio stays on this computer; accepted questions go to your selected chat model. Local transcription and voice generation still take some processing time, and speaker/microphone hardware affects interruption performance.

Test continues using your existing profile, wallet, models and earning node.

- Updated the Kondor producer signer to match the website and explain extension connection failures without implying a signature was received.

- External signing now shows broadcast progress, transaction IDs and errors directly below Broadcast, with an error notification.

- Dual-boot producer signing: optional 24-hour drafts and Resume saved draft after restarting Windows. Original draft, signature, nonce, network and hot-key checks remain required.
