# Floot snapshot

Source project: Astra Builder / visible brand Nexus
Floot project ID: 155877bd-a916-4527-8a1f-63d8e09ecf79

Current architecture includes:
- Nexus cinematic UI
- browser SpeechRecognition (pl-PL)
- browser SpeechSynthesis
- one built-in boy avatar; users may still select a custom portrait
- optional Nexus Image Engine portrait generation; generated default-avatar preferences are browser-local until the Floot project asset is explicitly updated and published
- Floot agent scaffold in helpers/ and endpoints/
- postgres + superjson dependencies injected by Floot

The local checkout no longer uses a mocked run(): `pages/_index.tsx` runs the existing `NexusOrchestrator` -> `NexusAgent` -> `ModelRouter` -> Agent Hub pipeline. The Hub enforces FREE / LOCAL FIRST, provides SSE streaming, local caching and optional local Headroom/Task Observer capabilities. This describes repository source, not a verified Floot deployment.

The Floot connector was visibly enabled in Claude's Connectors menu. Its resource menu is available, but this does not give this VS Code session direct Floot write tools or prove that current source changes have been synchronized. Do not send a paid Claude prompt, consume Floot credits or press Publish to perform source synchronization. Save source/draft only through an authorized free editor/import path, then verify by reloading the project.

The built-in avatar is `public/avatars/nexus-boy.png`. The older Floot CDN
portraits are no longer referenced by the application UI.

Note: this is a Floot virtual project, so a conventional local package.json/build scaffold is not part of the Floot source snapshot. Do not invent a replacement app merely to make it conventional; preserve the existing source and adapt deliberately.
