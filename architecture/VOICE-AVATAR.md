# Nexus Voice and Avatar

Goal: one continuous conversation with a visible, responsive Nexus persona.

## Pipeline

microphone -> endpointing/VAD -> speech-to-text -> orchestrator -> streamed response -> speech synthesis -> animation timing -> avatar

## Interaction states

- listening: microphone active, attentive gaze
- thinking: speech stopped, subtle processing motion
- speaking: streamed TTS plus mouth/face/body animation
- interrupted: stop TTS/generation where possible and return to listening
- error/offline: visible recoverable state

## Animation signals

The renderer should consume semantic signals rather than model-specific UI state:
- viseme/mouth timing
- blink
- gaze target
- head motion
- breathing
- expression
- gesture cue
- speech energy

Browser SpeechSynthesis and Web Speech can remain the zero-cost MVP where supported. High-fidelity lip sync requires timing/viseme data or a dedicated avatar renderer; moving a single PNG is not considered final lip sync.

Local FasterLivePortrait rendering is disabled in the Agent Hub: the avatar API never starts Python, CUDA or a local inference process. This prevents avatar rendering from competing for GPU memory on the desktop. Browser portrait display, lightweight CSS motion and speech synthesis remain available; they are not generative lip sync.

The default Nexus avatar is `public/avatars/nexus-android.mp4`, the accepted
`android-face-test-9ebe69ed` EchoMimicV3 Flash Pro result (768x768, 25 FPS,
3.2 seconds). The exact video was recovered from its embedded Colab preview
and checked against the saved SHA256; no new render was performed.
`public/avatars/nexus-android.png` is its original first-frame poster and
fallback if video decoding fails. Older working assets remain for rollback. The MP4
plays muted in an animated preview when conversation-render mode is disabled.
Idle motion is enabled by default and can be disabled to move only during TTS.
Its mouth is not synchronized to arbitrary live replies. Browser-local default-
avatar preferences can override the built-in image; custom photos and Studio-
rendered videos retain their existing paths.

## Per-reply conversation rendering

The default android's voice settings offer a separate opt-in batch lip-sync mode.
It is off by default so an unavailable renderer does not freeze the ordinary
animated preview or prevent local TTS.
`POST /api/avatar/conversation` accepts the actual current reply and explicit
cloud consent. The Hub checks `NEXUS_AVATAR_FREE_CONFIRMED=true` and a healthy
zero-cost EchoMimic worker with supplied-audio support before starting synthesis.
Windows SAPI Microsoft Paulina generates mono 16 kHz, 16-bit PCM locally.
The exact WAV is hashed and uploaded with the approved android poster; the
worker preserves it byte-for-byte and invokes the existing EchoMimic adapter.
Its MP4 muxes that same audio. Playback is unmuted, non-looping and exclusive:
no second browser utterance or prerecorded stock animation runs alongside it.
The player has controls for browsers that block delayed audible autoplay.

This is batch rendering, not real-time streaming. Audio must last 0.2-30 seconds;
long replies fail visibly rather than being truncated or silently reworded.
Stop/replacement aborts local synthesis and polling, pauses video and prevents
late results taking over; a job already submitted to the cloud may still finish.
Missing consent, voice, free configuration, renderer or playback leaves the
reply readable as text with an error, not a simulated lip-sync success.
Older voice/video behavior is available by disabling this setting.

Current validation proves actual local Paulina WAV synthesis, audio preservation,
FREE blocking, polling and build. It does NOT prove a new rendered conversation
or visual lip-sync accuracy. The shared Colab L4 session reports compute-unit
consumption, so no new inference was started there. Do not set the free-confirmed
flag merely to bypass this restriction.

The avatar studio exports the notebook-compatible
`nexus-ai-avatar-job.json`, links to the existing Colab notebook, and imports
its downloaded MP4. Colab videos loop muted as the live visual avatar while
Nexus TTS reads the current reply; a prerecorded clip's speech is not reused
or claimed to be synchronized with new text.

## Colab-generated avatar video

The desktop Nexus plays the MP4 produced from the source portrait using the
Colab video-generation workflow. It does not overlay guessed eye or mouth
positions on the face. For live speech, browser TTS remains separate from the
looping video; exact per-utterance lip sync requires generating a new clip or
connecting a live avatar renderer.

The saved Floot project uses the same rig core in `nexusAvatarRenderer` for
Nexus and Luna. Their existing expression atlases supply feathered mouth and
eyelid patches. Luna retains the existing 30-expression selector. The character
is rendered at at most 30 FPS with a capped backing resolution. Hidden idle
portraits pause; an audible TTS session continues through a 30 Hz timer when
an embedded preview reports itself hidden. Cancellation publishes idle
immediately and removes the mouth patch, including in a hidden preview.

Floot speech articulation is owned by the actual `useNexusSpeech` session,
not a page-level animation loop. It starts with the utterance, adjusts the
estimated text timing at available word-boundary events, respects speech rate,
and clears its timer on finish, error, replacement or cancellation. This is
estimated viseme animation, not measured phoneme timing or generative video.
The UI exposes loading/render errors and a retry action rather than leaving
a blank canvas. This is an original procedural portrait engine using the
project's existing characters; it does not copy Vidy's characters, models or
voice. No model downloads, paid video API or local GPU inference are introduced.

The **Silnik Colab** panel is the batch connection when no persistent cloud server
is configured. `helpers/avatarBatch.ts` validates/export a versioned portrait/text
JSON (1-300 script characters). `avatar-cloud/batch_job.py` validates the same
request and invokes the existing face engine only in a Linux cloud worker.
The notebook's optional app-batch cell accepts that request and offers the MP4.
The frontend imports the downloaded MP4 after checking browser decoding, with
session-only replay and explicit error messages. It never automatically sends
that file to a third-party service or substitutes an old film for a new reply.
This workflow needs manual upload/download; it is not an always-on Colab API.

Cloud rendering uses the own Nexus worker in `avatar-cloud`, backed by FasterLivePortrait and JoyVASA. No HeyGen account/key is required. Deploy on a Linux cloud server, configure server-only `NEXUS_AVATAR_SERVER_URL` (HTTPS) and `NEXUS_AVATAR_SERVER_TOKEN`, then restart the Hub. Never use `VITE_*` variables for credentials. Custom portraits are uploaded as PNGs to the local Hub; the built-in boy is uploaded automatically when an animation is requested. The animation button explicitly submits that portrait and the current response to your server. Ordinary conversation does not submit render jobs. Missing configuration and render failures are surfaced; there is no local GPU fallback.

`GET /api/avatar/config` reports configuration presence and `localRenderingEnabled: false`, never credentials. `POST /api/avatar/animate` requires `provider: "nexus-cloud"`, `cloudConsent: true`, a local `portraitPath` and a script of at most 5000 characters. Poll `GET /api/avatar/result/:jobId`, then fetch the video through the local Hub proxy; the browser never receives the cloud token. Video playback includes generated Polish speech and browser controls. Jobs are batch renders, not real-time conversation. The worker moves faces/head, not a full-body 3D rig; quality is not equivalent to proprietary HeyGen models. Actual inference/container compatibility and output quality must be validated on the remote server before claiming a working rendered avatar.

Voice identity and avatar identity are settings owned by Nexus, so changing an underlying model does not change the user's Nexus persona.

The optional notebook-only full-body mode uses LTX-Video image-to-video instead
of deforming only a detected face. It asks for arm/hand articulation, torso
rotation and leg movement while retaining a full-body frame. It runs in a
separate remote Python environment with quantized text encoding and CPU offload;
no desktop GPU fallback is allowed. Generated motion is probabilistic, can alter
identity/details, and must be reviewed per limb. Polish speech is attached without
lip synchronization. This mode does not change the HTTP face-rendering protocol
and is not automatically triggered by conversation or the Hub animation button.

The notebook also supports named image-reference packs (explicit collage grid,
one selected source per face job) and a separate deterministic Blender skeletal
prototype. The latter creates a stylized blue-hoodie boy with 27 bones and exported
GLB skin/animation. Head, wrist, fingers, arms and knees can be controlled through
idle/wave/walk/showcase motions; camera framing is body/face. It renders on cloud
CPU only and does not use the affected desktop GPU. Mouth opening follows audio
energy, not visemes. Procedural steps have no foot-contact IK. Reference photos do
not reconstruct or texture that mesh; the photorealistic face and stylized rig
remain distinct rendering modes. This is a reusable offline engine, not a
live 3D scene in the application or an automatically hosted backend.
