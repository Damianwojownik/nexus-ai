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

Important: pages/_index.tsx currently has a mocked run() function. Ollama integration should replace this mock through NexusAgent/ModelRouter, not by coupling UI directly to Ollama.

The built-in avatar is `public/avatars/nexus-boy.png`. The older Floot CDN
portraits are no longer referenced by the application UI.

Note: this is a Floot virtual project, so a conventional local package.json/build scaffold is not part of the Floot source snapshot. Do not invent a replacement app merely to make it conventional; preserve the existing source and adapt deliberately.
