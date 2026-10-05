# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The Vite frontend routes prompts through `NexusAgent` and `ModelRouter` to the local Agent Hub. `NEXUS_FREE_MODE=true` is the default: CPU-only Ollama is first, optional loopback llama.cpp second, then verified zero-cost providers if configured. Existing GPT/Codex, Copilot, Claude and ChatGPT adapters remain in the source but are blocked in FREE mode. Gemini is also blocked unless its pinned model and no-billing Free Tier project are explicitly verified; see [optional Gemini and local Cline setup](docs/GEMINI-LOCAL-FIRST.md). Voice input, browser TTS and avatar selection remain in place.

The browser requires the Hub to explicitly report `freeOnly=true` before inference. Older/non-FREE Hubs are not silently trusted. Responses stream through the Hub to the existing avatar conversation pipeline; the animated video itself is not re-rendered or changed by this integration.

The UI defaults to FREE / LOCAL FIRST. Paid/subscription selections are disabled. `provider.cost > 0`, credit/subscription requirements and unverified remote pricing are rejected before health, generation or streaming. No paid fallback, account purchase or subscription is performed. Routing preserves provider tiers, then uses measured latency within each tier. Small local models still require human fact/language review.

Earlier provider controls were saved separately in Floot. Changes in this checkout are not automatic Floot synchronization or production deployment. A Floot connector enabled in Claude proves connector availability, not that this source version has been saved to the Floot project.

The Floot copy's own 2D motion engine now smooths gaze, activity transitions and mouth movement, nods while listening, caps rendering at 30 frames per second, honors reduced-motion preferences on start, skips hidden-page computation and closes the mouth on stop. Five engine tests passed, along with routing and generation safeguards. It still uses 2D portraits and estimated visemes, not Vidy's proprietary real-time generative video, full-body generation or voice cloning. The original Growth Engine routes are not mounted in the current Hub (`/api/growth/nexus/org` and `/api/growth/status` return 404); conversational SEO recommendations do not constitute a live audit or CMS publishing integration.

### Independent company workspace (first integration stage)

The main screen includes a company onboarding form (name, description, website, goals, market/language). Saving creates a fresh company identifier, clears the visible conversation and selects a separate browser memory namespace. Reloading restores the saved profile and that company's memory. Each new save intentionally starts a new memory; returning to general mode preserves existing general memory. Previous company memories are not erased by removing the active profile. This is local browser separation, not server-side multi-tenant isolation or a cloud backup.

The avatar's existing conversation pipeline receives the validated company profile and a proposed Nexus -> SEO/Content/Growth -> QA -> owner approval hierarchy. These are planning roles in the current assistant, not separately running agents from the copied Ezostylia Growth Engine. Entering a website does not crawl it, verify its ownership, perform an SEO audit, connect Search Console or authorize changes. No production database, API key, publishing job or Emergent connection is transferred by this form. Never enter credentials in company fields.

The complete Ezostylia source copy is kept separately; its production application is untouched. Full engine neutralization, an independently configured backend/database, cloud deployment and real engine-to-avatar execution are subsequent stages, not implemented by this onboarding form.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Run locally

On Windows the Hub's CLI bridges invoke the installed `.cmd` launchers rather than PowerShell `.ps1` shims, so they do not require changing the system execution policy. Child stdin is closed to prevent non-interactive CLI calls waiting for additional input. CLI version health checks prove installation only; verify generation separately. `/api/chatgpt/status` reports direct ChatGPT authorization independently of Codex login. A valid sign-in URL does not mean the user has completed authorization.

Install dependencies with `npm install`. Copy `.env.example` to `.env.local` if overrides are needed. The local defaults are Ollama at `http://127.0.0.1:11434` and Agent Hub at `http://127.0.0.1:8788`; `qwen2.5:1.5b` is preferred when installed because it is lighter than larger local models.

The Hub reads `NEXUS_FREE_MODE` from its process environment (not automatically from Vite's environment file). Missing means true; only literal `true`/`false` are accepted. The Windows launcher enforces true and starts Ollama with the officially supported `OLLAMA_NO_CLOUD=1`. Remote/cloud model metadata and cloud-tagged Ollama models are rejected, including renamed cloud aliases. No keys belong in `VITE_*` variables.

The Agent Hub also exposes a capability registry for local web search and read-only GitHub discovery, file reading, code search, branches, commits, pull requests, issues and release assets. GitHub access is optional and uses the server-only `NEXUS_GITHUB_TOKEN`.

Recommended on Windows: run the one-click launcher:

```powershell
scripts\\start-nexus-windows.bat
```

It validates existing dependencies, starts/reuses local services and verifies FREE policy. It does not install packages, download models, stop existing processes or sign in to paid providers. Manual startup still works:

```powershell
npm run hub
npm run dev
```

Open `http://127.0.0.1:5173/`. The Hub stores runtime state under the user's local app data directory when started by the current Windows setup.

### Optional Claude development tools

See [Claude tooling setup and diagnostics](docs/CLAUDE-TOOLING.md) for Claude Code,
loopback-only OmniRoute, optional Headroom compression and Task Observer.
These development tools do not replace Nexus runtime or block startup when offline.

ChatGPT-plan authorization is disabled in FREE mode. Browser Bridge remains available for existing browser coordination; Claude Code remains an optional developer tool, never an automatically invoked paid Nexus runtime.
On Windows, `scripts\start-nexus-windows.bat` starts or reuses the Hub, UI and installed CPU-only Ollama and opens ordinary Edge. It never downloads models, installs provider CLIs or overwrites environment files. Missing dependencies and occupied/unresponsive ports are reported explicitly. Existing processes are not stopped. It reports provider availability separately; starting the UI does not configure an AI account.

### Optional local runtime tools

- Headroom is connected via local MCP. Enable the UI checkbox to compress a copy of context above 8,000 characters; prompts, memory and source files are unchanged. Original retrieval is verified byte-for-byte before using compressed output. Compression failures are surfaced and the original context is retained. Not every input compresses.
- Task Observer exposes its installed skill instructions and current Hub task progress via `tasks.observer`. For larger development tasks, explicitly ask the developer agent to use Task Observer and inspect Hub status/leases. Reading the skill does not automatically run Claude or make a model call.
- OmniRoute has a loopback health connector. Inference stays disabled until a provider's zero cost and no-paid-fallback behavior can be verified; localhost alone is not proof of free pricing. An offline gateway does not block Nexus.
- Provider health has a 5-second single-flight cache. Deterministic responses (`temperature: 0`) have a bounded 64-entry, 30-second in-memory cache; it is not a disk backup and restart clears it. Source data is never deleted.
- `npm run test:free` checks that paid health/generation/stream methods are never invoked, including explicit provider requests. See [Agent Hub API and policy](docs/AGENT-HUB.md).

## Local capabilities

### Own avatar presentation

The default character is the canonical `nexus-librarian` profile. Its
conversation portrait is `public/avatars/references/nexus-librarian/nexus-librarian-front-facing.jpeg`;
the face and expression-reference SHA-256 values are pinned in
`helpers/characterProfiles.ts`. The other two photos are identity references
only and are never randomly substituted as animation frames. Luna, the bear
and locally saved custom portraits remain selectable.

The main Nexus Live view does not play the legacy android/Luna MP4s, batch
rendered clips or CSS mouth overlays. It shows a neural video track only after
a persistent warm renderer returns and the browser decodes its first frame.
Until then, the portrait stays unchanged and the UI reports "Live avatar
unavailable". No neural renderer is currently configured, so live visual
generation and its FPS/latency/audio-video synchronization have not been
verified.

The existing opt-in "Nexus Live" Paulina stack streams verified local PCM16
chunks and native viseme timing; when a real neural session exists, the same
audio and cues are forwarded using the PCM playback clock as PTS. Clicking the
microphone while Paulina is speaking stops that audio first, sends a session
interrupt, then enters listening on recognition start. EchoMimic/FasterLivePortrait
remain batch/Studio tools, not a live fallback. See
`architecture/VOICE-AVATAR.md` for the transport contract and current limits.

The main screen contains the avatar and one text/microphone/attachment composer.
The gear opens a modal containing existing settings, Studio, tools and company
configuration. Image/avatar/website requests ask only for missing task inputs.
Website generation produces a local static HTML preview/download, sandboxed
with scripts, external requests and form submission disabled; it does not
publish, host a shop or process payments.
The website workflow is experimental: CPU smoke attempts at 1024 and 512
output tokens exceeded the local provider deadline. They returned an error,
not a successful preview. Parser/HTML-sandbox tests pass, but a real generated
website has not yet been verified on this machine.

Image generation can be started by voice or text with `Wygeneruj mi [opis]`,
for example `Wygeneruj mi cybernetycznego Nexusa w zielonej matrycy`. Keep the
image description in the same command; Nexus does not reuse a previous turn's
description.

To render a new speaking clip, the avatar studio exports
`nexus-ai-avatar-job.json` for the existing
[Nexus Colab notebook](https://colab.research.google.com/drive/1GFDqlXTUKuZ-ORihVzhe5FflVWbZnK-l?authuser=1#scrollTo=smy7KFajiWUI).
Upload the JSON in Colab, run its renderer and MP4 download cells, then import
the downloaded MP4 back into Nexus. Imported Colab clips loop muted as the
avatar; the selected Nexus voice reads new replies separately.

The saved Floot Nexus/Luna use the shared rig with their existing expression
atlases, feathered articulation patches and explicit loading/error/retry states.
TTS owns the estimated viseme clock, resynchronizes at available word boundaries,
and cancels mouth movement immediately with speech. Audible speech continues
animating if the embedded preview reports hidden; hidden idle animation pauses.
This is procedural 2D, not Vidy-style generative full-body video. No assets from
Vidy, model downloads, purchases or local GPU inference are used. See
`architecture/VOICE-AVATAR.md` for the exact differences between desktop, Floot
and remote batch rendering.

The Hub can route chat through official globally installed Codex, Copilot and Claude CLIs on Windows, using their own terminal logins (`codex login`, `copilot login`, `claude auth login`). Install the corresponding official packages only when needed; do not paste tokens into Nexus. Codex uses a read-only sandbox in a temporary empty directory, Claude and Copilot have tools disabled. Calls run in the cloud; their subscription/quota limits still apply. CLI availability is not proof of successful generation. Cloud CLIs are included in `/api/ai/health`. The default Hub forces Ollama `num_gpu: 0` for generation and streaming. The UI enables its fallback only after health explicitly confirms CPU-only configuration and an installed model. The Windows launcher starts installed Ollama with GPU discovery disabled; it never downloads models or changes credentials.

- The main screen has one composer for text, attachments and spoken commands; film controls are grouped in the collapsible Studio and advanced speech/browser controls remain in settings. `Ustaw awatara z tego zdjęcia` imports an attached image as a portrait, not a reconstructed 3D model. `Animuj awatara: text` uses the configured cloud renderer only after Studio consent and reports failures; the Colab file bridge remains available in Studio.
- `Wygeneruj obraz: description` uses the Nexus Image Engine through the server-side Agent Hub, then shows a PNG preview with download and save-as-default-avatar actions. Studio also generates a portrait and can set it as the default avatar for that browser profile. Engine URL and token stay in the Agent Hub environment; the Colab tunnel is temporary. Saving the browser preference does not replace the shared static asset or deploy a Floot project update.
- Microphone input requests permission, enumerates audio inputs and refreshes on device changes. Web Speech uses the system/browser default input, not a selectable stream; the final recognized utterance executes immediately and once through the same command handler as text, without waiting for recognition `onend`. Unsupported recognition, denied permission and service/network failures are displayed explicitly. Web Speech may send audio to its recognition provider. This is single-command dictation, not verified continuous live conversation.
- Advanced settings include Polish, US/UK English, German, French, Spanish, Italian and Ukrainian for recognition, reply language and TTS. Automatic Polish speech for the default librarian selects local female Microsoft Paulina, never a silent male/online fallback. The neural live path requires the native Polish PCM stream; ordinary TTS remains available separately. Explicit manual voice choices remain available for ordinary TTS. Language/voice preferences persist locally. Online voices may send reply text to their provider; no paid TTS service is configured. The default speed is 1.0. Ordinary replies are requested concisely. Model startup/network latency still applies; responses are not guaranteed instant.
- Speech prefers the exact regional language when available and never silently substitutes another language's voice. If no matching voice is installed, the text reply remains available with a clear notice. Each language has a native-language preview; the persistent read-aloud checkbox mutes speech. During playback, `Zatrzymaj odczyt` stops the current utterance. Sending a new message cancels old speech, and late callbacks from canceled utterances or submitted recognition sessions cannot overwrite the current conversation state.
- Optional downloaded Polish voice: run `powershell -ExecutionPolicy Bypass -File scripts\install-nexus-voice.ps1`. This installs pinned Piper in `%LOCALAPPDATA%\NexusAI\speech\venv`, downloads `pl_PL-darkman-medium` (~63 MB, dataset CC0) and retains its model card. Piper's runtime is GPL-3.0-or-later; see the upstream package license. The Hub uses CPUExecutionProvider only and two inference threads. The local worker stays warm for five minutes, then releases memory; first-load latency is higher. Polish automatic voice selection uses Piper when installed; explicit browser voice choices are preserved. Speech text is limited to 6000 characters and WAV output to 24 MB. No local GPU, cloud text upload or paid API is involved. The Clipchamp/CapCut shortcuts are separate video editors, not downloadable voice providers for Nexus.
- `Studio awatara` groups photo selection, a 1-300 character script, selected-voice preview, Polish Piper WAV download, cloud render status/consent, Colab JSON export and MP4 import/replay. Downloaded WAV is separate audio; it is not automatically muxed or used by the cloud renderer, whose own voice settings apply. Automatic rendering requires the existing server-only cloud configuration plus explicit photo/script consent; configured does not mean verified online. Polling has a five-minute deadline and can be stopped, but stopping the wait does not cancel a remote render. Imported/generated results can be reopened and saved; they are not a persistent video library and editing the script does not change an existing MP4. HeyGen is a workflow reference only, not an integrated backend or a guarantee of comparable animation quality. The Colab file workflow is now in Studio, not advanced settings.
- This desktop UI disables local GPU inference and local avatar rendering. It allows AI fallback only after the Hub explicitly confirms CPU-only Ollama and an installed model. Strict cloud-only clients may still send `allowLocalFallback: false` to generation and streaming. Restart the Hub after updating its source. `/api/ai/health` reports provider configuration without exposing credentials.
- Web search runs through DuckDuckGo from the local Hub and returns clickable source links/snippets.
- File import accepts one file up to 10 MB into `%LOCALAPPDATA%/NexusAI/workspace` (or `NEXUS_WORKSPACE_DIR`). Executable/installer extensions are blocked; imports are never launched.
- Windows software installs are restricted to the Hub's approved `winget` catalog and require an explicit UI confirmation for every app. The installer is disabled if `winget` is unavailable; Nexus does not install a package manager automatically.
- The local Agent Hub supports opt-in **Continue with ChatGPT**. For eligible ChatGPT plans, the plan provider is first in AUTO routing, followed by Codex/Copilot/other configured providers and Ollama.
- ChatGPT OAuth credentials are stored only in the local NexusAI app-data directory; Floot does not receive them.
- The ChatGPT plan connection starts new Nexus conversations. It does not import existing ChatGPT conversation history or native ChatGPT memory; durable continuity is owned by Nexus memory.

## Next task

Configure and verify the same frontend/runtime values in the hosted Floot deployment if that environment is required. The local end-to-end path is documented in `docs/AGENT-HUB.md`.


## Continue in a new AI session

Read `docs/NEXUS-HANDOFF.md` first. It records the current architecture, provider fallback, internet endpoints, memory behavior and avatar work so a new session can resume without relying on chat history.
- The separate Primary Agent connector remains `NOT_CONFIGURED`; this does not block the Hub's CLI-based model chat.
- Local avatar GPU rendering is disabled. Nexus has its own cloud worker based on FasterLivePortrait + JoyVASA, without HeyGen. Configure server-only `NEXUS_AVATAR_SERVER_URL` and `NEXUS_AVATAR_SERVER_TOKEN` after deploying the worker on your cloud server. The animation button explicitly submits portrait/text there; no automatic local render fallback is enabled. See `avatar-cloud/DEPLOY.md` for deployment and verification requirements.
- The Colab/Kaggle notebook also has an optional LTX image-to-video mode for full-body motion (arms, legs and torso), isolated from the face renderer. It produces batch clips, not a real-time 3D rig. Its attached Polish speech is not lip-synchronized; generated anatomy and limb movement require visual review. This mode is not a permanent Hub backend.
- Additional notebook modes import a collage into named character references for the existing face renderer and build a separate controllable, stylized 27-bone 3D prototype. The prototype exports GLB/BLEND and a cloud-CPU-rendered preview with body/face cameras and idle/wave/walk/showcase motion. It is not a photorealistic reconstruction of the supplied images, and the reference pack is not automatically fused into its mesh. See `avatar-cloud/DEPLOY.md`.

The local runtime API and provider/capability endpoints are documented in `docs/AGENT-HUB.md`. Avatar renderer limitations are documented in `architecture/VOICE-AVATAR.md`.
