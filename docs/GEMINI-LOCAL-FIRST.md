# Optional Gemini Free Tier and local development agent

Nexus remains the application's API layer: browser -> loopback Agent Hub.
The optional Gemini launcher sets `NEXUS_PRIMARY_PROVIDER=google-gemini`:
verified Gemini Free Tier first, then local Ollama and llama.cpp. Without that
override, the existing LOCAL FIRST order is preserved. The Gemini
web app and its subscription are not API credentials or proof of free pricing.

## Key and billing verification

Revoke any key shared in chat. Create a replacement in
[Google AI Studio](https://aistudio.google.com/api-keys).
On the [Projects page](https://aistudio.google.com/projects), verify the key's
project is **Free Tier**, with **no billing account linked**. Confirm the current
[pricing](https://ai.google.dev/gemini-api/docs/pricing) offers standard text
generation free of charge for `gemini-2.5-flash`. Do not enable billing, buy credits
or use a paid project. Free Tier data may be used to improve Google's products;
do not send private project data without appropriate authorization.

On Windows, run these in your own terminal from the repository:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\set-nexus-gemini-key.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-nexus-gemini-hub.ps1 -FreeTierConfirmed
```

The first command securely prompts for the NEW key. It stores only Windows
user-DPAPI ciphertext at `%LOCALAPPDATA%\NexusAI\gemini-key.dpapi`, outside git.
The second refuses an occupied Hub port; stop only your own previous Hub first.
It decrypts the key into the Hub process environment, not frontend storage.
Start the UI separately with `npm run dev` or the existing launcher.

`-FreeTierConfirmed` is the operator's explicit verification, **not automatic
billing verification**. The generate API cannot prove the project's billing
state. Remove confirmation and stop this Hub BEFORE linking a billing account.
Without confirmation, Gemini health/generation/stream are blocked in FREE mode.
The moving `gemini-flash-latest` alias and all other unverified models stay blocked.
HTTP 429 triggers existing local/free fallback and cooldown, never purchases or
upgrades. No remote request was made merely by preparing this integration.

Other hosts may provide server-only `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-2.5-flash`
and `NEXUS_GEMINI_FREE_CONFIRMED=true` in the Hub environment after the same
verification. Set `NEXUS_PRIMARY_PROVIDER=google-gemini` for Gemini-first routing.
Never use `VITE_*` or browser localStorage for a key.

Rollback: stop this optional Hub and start the normal FREE Hub without Gemini
confirmation. Delete only the named DPAPI credential file if removing the key.

## Cline instead of discontinued Roo Code

The [official Roo Code listing](https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline)
announces its shutdown and points to alternatives. The optional development
extension [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev)
is installed using `code --install-extension saoudrizwan.claude-dev`.
It does not replace the Nexus runtime or automatically connect itself to it.

In the Cline sidebar select **Ollama**, URL `http://127.0.0.1:11434`, and an already
installed local model (currently `qwen2.5:1.5b`). Do not choose Cline's paid cloud
provider or enable auto-approve. Enable **Use Compact Prompt** as described in
[Cline's local-model guide](https://docs.cline.bot/running-models-locally/overview).
Small models may not handle complex coding
reliably; validate every change. The `.clinerules` policy preserves FREE mode,
secrets, human approval and the existing PR. Cline provider selection is a
manual editor step, not a completed runtime connection.
