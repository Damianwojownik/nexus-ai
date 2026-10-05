# Nexus Brain

## Product invariant

Nexus owns the durable memory. Models and agents are replaceable workers.

The user interacts with one primary Nexus persona. The orchestrator delegates work to subagents and tools without forcing the user to manage them individually.

## Layers

1. Experience
   - voice input
   - speech output
   - avatar state and animation
   - interruption / listening / thinking / speaking states

2. Orchestrator
   - accepts the user's goal
   - retrieves only relevant memory
   - creates a plan
   - delegates bounded tasks
   - verifies results
   - produces the final response

3. Agent Hub
   - primary agent: ChatGPT-compatible bridge when officially available
   - coding subagent: Codex
   - local subagents: Ollama roles
   - future research/review/specialist agents

4. Model Router
   - configured cloud provider first in AUTO/CLOUD
   - immediate local Ollama fallback on quota, points/credits exhaustion, rate limit or provider outage
   - cooldowns prevent repeatedly retrying exhausted providers
   - LOCAL: Ollama only
   - provider outages must not destroy task state

5. Nexus Memory
   - durable and provider-independent
   - project facts, decisions, preferences, tasks and summaries
   - retrieval is scoped; subagents do not receive the entire memory by default

6. Tool Runtime
   - verified, permissioned operations
   - file, git, tests, search and project tools
   - destructive operations require an explicit policy/approval boundary

## Cost rule

Ollama has no per-token cloud charge and is the automatic fallback. Paid API providers are optional and credentials stay in the local Hub process. A real Copilot adapter is not currently present; do not infer Copilot quota status without a provider response.

## Voice/avatar contract

The avatar renders Nexus state, not model identity. At minimum:
idle -> listening -> thinking -> speaking -> idle/error.

Realistic animation is a separate renderer driven by speech timing/visemes, gaze, blink, expression and gesture signals. A static image transform is only a temporary MVP.

## Reliability

Every long task has a durable task id and state. Agent/provider changes must be resumable. No agent may rely on hidden conversational context as the only copy of important project state.
