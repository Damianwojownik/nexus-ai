# Nexus development policy

- Use the existing local Ollama provider. Never automatically select a paid API,
  subscription, credits, cloud-tagged Ollama model or paid fallback.
- Keep `NEXUS_FREE_MODE=true`. The user's Colab render allowance does not authorize
  paid development models or disable this policy.
- Keep file changes and terminal commands subject to explicit human approval.
  Do not enable auto-approve or publish, deploy or merge to main.
- Work on the existing PR #10 rather than creating a competing PR.
- Never read, display, copy or commit API credentials. Do not read user DPAPI
  credential files or put credentials in browser code or `VITE_*` variables.
- Preserve Floot, Agent Hub, Ollama, Browser Bridge and ACE Music integrations.
- Luna is the current female avatar; Nexus AI is the application name. Do not
  replace avatar assets or claim exact lip-sync without checking the actual film.
- Verify changes with focused tests and `npm run build`. Never claim unperformed
  operations, successful installation or generation from a plan alone.
