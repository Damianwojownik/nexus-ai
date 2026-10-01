# Floot snapshot

Source project: Astra Builder / visible brand Nexus
Floot project ID: 155877bd-a916-4527-8a1f-63d8e09ecf79

Current architecture includes:
- Nexus cinematic UI
- browser SpeechRecognition (pl-PL)
- browser SpeechSynthesis
- six selectable avatars persisted in localStorage
- Floot agent scaffold in helpers/ and endpoints/
- postgres + superjson dependencies injected by Floot

Important: pages/_index.tsx currently has a mocked run() function. Ollama integration should replace this mock through NexusAgent/ModelRouter, not by coupling UI directly to Ollama.

Floot-hosted avatar paths used by the UI:
- /_cdn/static/8c1cadbc-855e-4488-a72b-e88cb715d899.png
- /_cdn/static/cc2dde88-daa2-48c9-acc8-1ea16f85990d.png
- /_cdn/static/6a74b8c4-e09a-4776-a01a-156edac8441f.png
- /_cdn/static/364da496-a271-4b0c-b40e-e23f14fad3a2.png
- /_cdn/static/17f6bda3-9fc8-4e2d-9b46-fec5fc2d91d4.png
- /_cdn/static/2405769f-a406-4390-9af2-8b74c0fda46c.png

Note: this is a Floot virtual project, so a conventional local package.json/build scaffold is not part of the Floot source snapshot. Do not invent a replacement app merely to make it conventional; preserve the existing source and adapt deliberately.
