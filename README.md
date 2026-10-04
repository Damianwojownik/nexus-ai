# Nexus AI

Snapshot of the existing Nexus project from Floot.

Floot project ID: `155877bd-a916-4527-8a1f-63d8e09ecf79`

## Current state

The Vite frontend routes prompts through `NexusAgent` and `ModelRouter`. The local Agent Hub hosts GPT/Codex, Copilot, Claude and Gemini adapters with CPU-only Ollama fallback; the browser never receives provider credentials. Voice input, browser TTS and avatar selection remain in place.

The frontend health bridge accepts both the original lowercase provider map and Hub 1.5's uppercase provider array, including direct `chatgpt-plan` authorization. A connected ChatGPT provider does not require Gemini configuration; an older server must still explicitly confirm CPU-only Ollama before local fallback is enabled.

The local UI defaults to economical routing: routine working drafts use CPU Ollama without API fees; questions, analysis, comparisons, final editing, SEO, fact checking and decisions use Astra through the connected ChatGPT plan and its limits. The small CPU model's Polish draft test showed language errors and unsupported additions, so drafts are not publication-ready. This is a transparent keyword rule on the user's command (including question marks), not an AI complexity assessment. Manual Astra, Copilot and CPU Ollama selections override that rule. These modes request one provider and never silently switch to paid APIs. The optional legacy automatic mode follows the server order and may use configured paid providers. The actual last response provider is displayed, with a manual health refresh. UI source changes here are not an automatic Floot deployment.

The corresponding provider controls and policy were separately saved through the Floot project editor and verified after a full editor reload. Floot's explicit/economical modes support text only: they reject attachments before paid preprocessing and do not execute browser actions. Its direct Hub client probes health to pick an address, but submits generation only once; provider errors are not retried through the second loopback alias. CPU responses request at most 512 output tokens. Source/checkpoint saves are distinct from publishing a production release.

The Floot copy's own 2D motion engine now smooths gaze, activity transitions and mouth movement, nods while listening, caps rendering at 30 frames per second, honors reduced-motion preferences on start, skips hidden-page computation and closes the mouth on stop. Five engine tests passed, along with routing and generation safeguards. It still uses 2D portraits and estimated visemes, not Vidy's proprietary real-time generative video, full-body generation or voice cloning. The original Growth Engine routes are not mounted in the current Hub (`/api/growth/nexus/org` and `/api/growth/status` return 404); conversational SEO recommendations do not constitute a live audit or CMS publishing integration.

### Independent company workspace (first integration stage)

The main screen includes a company onboarding form (name, description, website, goals, market/language). Saving creates a fresh company identifier, clears the visible conversation and selects a separate browser memory namespace. Reloading restores the saved profile and that company's memory. Each new save intentionally starts a new memory; returning to general mode preserves existing general memory. Previous company memories are not erased by removing the active profile. This is local browser separation, not server-side multi-tenant isolation or a cloud backup.

The avatar's existing conversation pipeline receives the validated company profile and a proposed Nexus -> SEO/Content/Growth -> QA -> owner approval hierarchy. These are planning roles in the current assistant, not separately running agents from the copied Ezostylia Growth Engine. Entering a website does not crawl it, verify its ownership, perform an SEO audit, connect Search Console or authorize changes. No production database, API key, publishing job or Emergent connection is transferred by this form. Never enter credentials in company fields.

The complete Ezostylia source copy is kept separately; its production application is untouched. Full engine neutralization, an independently configured backend/database, cloud deployment and real engine-to-avatar execution are subsequent stages, not implemented by this onboarding form.

This repository is the shared source bridge for VS Code/Codex work. Floot-specific source is preserved under its original virtual paths.

## Run locally

Install dependencies with `npm install`. Copy `.env.example` to `.env.local` if overrides are needed. The local defaults are Ollama at `http://127.0.0.1:11434` and Agent Hub at `http://127.0.0.1:8788`; `qwen2.5:1.5b` is preferred when installed because it is lighter than larger local models.

Optional Gemini access is configured only in the Agent Hub process environment with `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`). Do not put the key in any `VITE_*` variable. When a cloud provider fails, Nexus tries another available provider and then CPU Ollama when allowed. Quota and rate-limit failures trigger a cooldown to avoid repeatedly retrying an exhausted provider.

The Agent Hub also exposes a capability registry for local web search and read-only GitHub discovery, file reading, code search, branches, commits, pull requests, issues and release assets. GitHub access is optional and uses the server-only `NEXUS_GITHUB_TOKEN`.

Start the local services in separate terminals:

```powershell
npm run hub
npm run dev
```

Open `http://127.0.0.1:5173/`. The Hub stores runtime state under the user's local app data directory when started by the current Windows setup.

On Windows, `scripts\start-nexus-windows.bat` starts or reuses the Hub, UI and installed CPU-only Ollama and opens ordinary Edge. It never downloads models, installs provider CLIs or overwrites environment files. Missing dependencies and occupied/unresponsive ports are reported explicitly. Existing processes are not stopped. It reports provider availability separately; starting the UI does not configure an AI account.

## Local capabilities

### Own avatar presentation

The default Nexus cyborg uses a 4.04-second Colab LTX image-to-video clip as a
muted, looping avatar, with the selected Nexus TTS voice speaking replies
separately. Its prompt requests a subtle curl of the outstretched index finger;
generated limb motion is probabilistic and must be reviewed in the rendered
clip. The clip's mouth motion is not synchronized to arbitrary live replies.
Custom photos and Studio videos retain their existing paths.

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
- Advanced settings include Polish, US/UK English, German, French, Spanish, Italian and Ukrainian for recognition, reply language and TTS. Choose any matching voice reported by the browser or use automatic selection, which prefers natural/online voices when available. Language/voice preferences persist locally. Online voices may send reply text to their provider; no paid TTS service is configured. The default speed is 1.0. Ordinary replies are requested concisely and the UI no longer performs a redundant provider health request before the model router's own check. Model startup/network latency still applies; responses are not guaranteed instant.
- Speech prefers the exact regional language when available and never silently substitutes another language's voice. If no matching voice is installed, the text reply remains available with a clear notice. Each language has a native-language preview; the persistent read-aloud checkbox mutes speech. During playback, `Zatrzymaj odczyt` stops the current utterance. Sending a new message cancels old speech, and late callbacks from canceled utterances or submitted recognition sessions cannot overwrite the current conversation state.
- Optional downloaded Polish voice: run `powershell -ExecutionPolicy Bypass -File scripts\install-nexus-voice.ps1`. This installs pinned Piper in `%LOCALAPPDATA%\NexusAI\speech\venv`, downloads `pl_PL-darkman-medium` (~63 MB, dataset CC0) and retains its model card. Piper's runtime is GPL-3.0-or-later; see the upstream package license. The Hub uses CPUExecutionProvider only and two inference threads. The local worker stays warm for five minutes, then releases memory; first-load latency is higher. Polish automatic voice selection uses Piper when installed; explicit browser voice choices are preserved. Speech text is limited to 6000 characters and WAV output to 24 MB. No local GPU, cloud text upload or paid API is involved. The Clipchamp/CapCut shortcuts are separate video editors, not downloadable voice providers for Nexus.
- `Studio awatara` groups photo selection, a 1-300 character script, selected-voice preview, Polish Piper WAV download, cloud render status/consent, Colab JSON export and MP4 import/replay. Downloaded WAV is separate audio; it is not automatically muxed or used by the cloud renderer, whose own voice settings apply. Automatic rendering requires the existing server-only cloud configuration plus explicit photo/script consent; configured does not mean verified online. Polling has a five-minute deadline and can be stopped, but stopping the wait does not cancel a remote render. Imported/generated results can be reopened and saved; they are not a persistent video library and editing the script does not change an existing MP4. HeyGen is a workflow reference only, not an integrated backend or a guarantee of comparable animation quality. The Colab file workflow is now in Studio, not advanced settings.
- This desktop UI disables local GPU inference and local avatar rendering. It allows AI fallback only after the Hub explicitly confirms CPU-only Ollama and an installed model. Strict cloud-only clients may still send `allowLocalFallback: false` to generation and streaming. Restart the Hub after updating its source. `/api/ai/health` reports provider configuration without exposing credentials.
- Web search runs through DuckDuckGo from the local Hub and returns clickable source links/snippets.
- File import accepts one file up to 10 MB into `%LOCALAPPDATA%/NexusAI/workspace` (or `NEXUS_WORKSPACE_DIR`). Executable/installer extensions are blocked; imports are never launched.
- Windows software installs are restricted to the Hub's approved `winget` catalog and require an explicit UI confirmation for every app. The installer is disabled if `winget` is unavailable; Nexus does not install a package manager automatically.
- The separate Primary Agent connector remains `NOT_CONFIGURED`; this does not block the Hub's CLI-based model chat.
- Local avatar GPU rendering is disabled. Nexus has its own cloud worker based on FasterLivePortrait + JoyVASA, without HeyGen. Configure server-only `NEXUS_AVATAR_SERVER_URL` and `NEXUS_AVATAR_SERVER_TOKEN` after deploying the worker on your cloud server. The animation button explicitly submits portrait/text there; no automatic local render fallback is enabled. See `avatar-cloud/DEPLOY.md` for deployment and verification requirements.
- The Colab/Kaggle notebook also has an optional LTX image-to-video mode for full-body motion (arms, legs and torso), isolated from the face renderer. It produces batch clips, not a real-time 3D rig. Its attached Polish speech is not lip-synchronized; generated anatomy and limb movement require visual review. This mode is not a permanent Hub backend.
- Additional notebook modes import a collage into named character references for the existing face renderer and build a separate controllable, stylized 27-bone 3D prototype. The prototype exports GLB/BLEND and a cloud-CPU-rendered preview with body/face cameras and idle/wave/walk/showcase motion. It is not a photorealistic reconstruction of the supplied images, and the reference pack is not automatically fused into its mesh. See `avatar-cloud/DEPLOY.md`.

The local runtime API and provider/capability endpoints are documented in `docs/AGENT-HUB.md`. Avatar renderer limitations are documented in `architecture/VOICE-AVATAR.md`.
