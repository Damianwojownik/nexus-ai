# Nexus Voice and Avatar

Goal: one continuous conversation with a visible, responsive Nexus persona.

## Nexus Live: independent streaming foundation

`helpers/pcmStream.ts` schedules verified mono PCM16 packets as they arrive,
without waiting for a complete WAV. It checks per-packet SHA-256, sequence,
sample rate and bounded buffering. Its logical clock follows audio actually
scheduled in Web Audio and pauses across underruns; render-loop wall time is
not used as speech time. Cancellation stops only this stream's audio sources.

`helpers/characterStream.ts` adds incremental articulation to the existing
identity/capability core. It validates each timeline against the scheduled
PCM digest/position, preserves coarticulation across contiguous chunks,
returns to rest during underruns, and blocks late/stale generations. A batch
movie is explicitly refused as a realtime renderer. Estimated timing still
requires opt-in; a rig without tongue/teeth channels cannot claim them.
These control-plane checks do not prove neural visual identity or articulation.

The native Windows voice worker (`speech/paulina-stream.cs`,
`helpers/paulinaSpeechStream.ts`) keeps Microsoft Paulina Desktop warm and
emits raw PCM, actual System.Speech phoneme tokens and visemes. IPA combining
marks and SAPI boundary tokens retain their provenance; they are not guessed
from letters or promoted to clinically validated phoneme segmentation.
The browser-safe wire contract is `helpers/paulinaSpeechProtocol.ts`.
`GET /api/speech/stream/health` and `POST /api/speech/stream` are loopback-UI-only
Agent Hub routes. The POST response is bounded/backpressured NDJSON; disconnect
cancels the owned synthesis. Existing Piper/WAV and FREE routing guards remain.

One real Windows verification synthesized 4.43 seconds / 70,880 samples,
222 PCM chunks, 43 native phoneme tokens and 35 visemes. First PCM measured
1,619 ms cold including 1,532 ms worker warm-up, versus 5.72 ms warm;
these are speech-worker observations, not LLM-to-avatar latency. Native HTTP,
browser packet validation/playback, interruption and legacy speech tests passed.
The "Nexus Live" PCM client now offers a non-blocking audio-chunk callback.
When a warm persistent neural renderer is genuinely available, the browser
provider sends those PCM16LE chunks, sample-derived PTS and native Paulina
visemes over WebRTC/DataChannel plus its session control WebSocket. The local
Agent Hub proxies session creation, SDP offers and teardown without exposing
the upstream token. Audio playback remains master-clocked by
`PcmStreamPlayer.positionMs()`.

The Nexus librarian is now the default identity, pinned to the frontal JPEG and
two SHA-256-pinned expression references. Only the frontal image is used as the
conversation portrait; the expression images are not switched in as frames.
`faceRig`, `mouthRig`, CSS image deformation and automatic MP4 playback have
been removed from the main portrait renderer. Until a live video track produces
a decoded frame, the UI shows the unchanged portrait and the explicit message
"Live avatar unavailable". The live renderer server/model is NOT currently
configured, so no live video, FPS, first-frame latency or A/V offset has been
measured. The existing Paulina playback path is retained and remains separate
from hosted Floot.

### Neural renderer service contract and current limit

The browser talks only to loopback Agent Hub routes:
`GET /api/avatar/live/health`, `POST /api/avatar/live/sessions`,
`POST /api/avatar/live/sessions/:id/offer`, and
`DELETE /api/avatar/live/sessions/:id`. Agent Hub forwards them to the
server-only `NEXUS_LIVE_AVATAR_SERVER_URL` and
`NEXUS_LIVE_AVATAR_SERVER_TOKEN` contract. `services/avatar_live/` now provides
an authenticated gateway to a separate persistent renderer worker: it proxies
the worker's health, session creation, actual SDP answer, session cleanup and
control WebSocket, while WebRTC media flows directly between browser and worker.
The worker must report `available: true`, `warm: true` and
`mode: "persistent-neural-stream"` before a session can be created. Ordered
DataChannel messages carry length-prefixed JSON metadata followed by PCM16LE
bytes. Control messages carry state, emotion, PTS and native viseme intervals.
The adapter verifies the character ID and pinned face hash; batch renderers and
Colab URLs are not valid live providers.

No compatible neural worker is bundled or configured in this checkout. The
gateway returns `NOT_CONFIGURED`/`DISCONNECTED` and rejects session creation
without a real warm worker; it does not fake an SDP answer or claim that the
existing FasterLivePortrait batch API is live. The UI therefore deliberately
fails closed instead of displaying a fake speaking loop. Clicking the
microphone during native Paulina playback aborts the PCM player first, sends
`INTERRUPT` at the playback clock position and changes the session to
`LISTENING` when recognition starts. Automatic always-on VAD, a renderer-side
GPU/model and real five-turn/latency/FPS measurements remain unverified. Local
Windows and hosted gateway setup is documented in
`services/avatar_live/README.md`; GTX 970 compatibility with a persistent
photorealistic renderer has not been demonstrated.

The user explicitly cancelled the three-minute EchoMimic experiment to focus
on realtime. Its owned process was terminated; no completed long film is
claimed. The user subsequently lifted the earlier 30-unit development cap
for using existing Colab credits. This does not authorize new purchases,
subscriptions, paid API fallback or declaring paid Colab compute FREE.

An observed Vidu live page used separate MediaStream video/audio elements;
one video stream decoded at 768x1344. Browser playback statistics do not
reveal its model weights, server hardware, generation throughput or true
audio-to-mouth alignment. No Vidu model was copied or recovered.
Public model research found no off-the-shelf single-GPU model proven to meet
all of animal/full-body motion, reference fidelity, streaming and 25 FPS.
FlashHead Lite is a test candidate, not an approved replacement. Its official
pinned entrypoint defaults to `use_face_crop=False`; human detection is
optional, while animal visual quality remains unverified. Native output is
512x512, and vendor FPS numbers on RTX4090/5090 are not measured L4/A100 results.
`benchmark_flashhead_stream.py` measures audio encoding, model inference and
CPU transfer separately from encoding, reports the input-window latency floor,
and leaves all quality/live-readiness flags false pending actual comparison.
A pinned A100-SXM4-80GB run on 2026-10-05 produced a 3.12-second 512x512
H.264/AAC clip with 78 frames. Model startup took 32.46 seconds; the first
24-frame window took 181.13 seconds (a 182.09-second lower bound to the first
chunk for 960 ms of input), while later windows took 0.27-0.29 seconds.
Effective throughput including the first chunk was 0.528 FPS. The inspected
six-frame contact sheet kept the muzzle open throughout, with no apparent
speech-dependent change. `visualApproval`, `animalSupportVerified`,
`phonemeAlignmentVerified` and `liveConversationReady` remain false. This
measured result rules out FlashHead Lite as the current live-bear renderer.

## Shared character engine and reference evidence

`helpers/characterEngine.ts` is a renderer-independent articulation core.
It pins a character ID, reference image SHA-256, identity revision and rig
revision for a session. Loading cues for a different identity fails rather than
silently changing the character. This is input identity integrity, NOT proof
that a neural renderer preserves facial appearance in generated frames.
Each timeline also records the actual audio hash, duration, language (PL/EN/DE)
and timing provenance (`tts-phonemes`, `forced-alignment` or `estimated`).
The caller supplies phonemes and measured times; the engine does not infer
phonemes from letters or convert estimated timing into verified alignment.

Mouth channels cover jaw, width, rounding, lip closure, tongue tip/back and
teeth contact. Contiguous cues use bounded smooth transitions without advancing
the next phoneme before its audio time. Gaps, completion and interruption return
to rest. Frames are sampled at audio playback time, not accumulated render-loop
time. The current local WAV preview now uses the media element's `currentTime`;
browser SpeechSynthesis still uses estimated timing because it lacks a media clock.
The existing text-viseme sampler also returns to rest outside its cue intervals.

The new core is tested but is NOT yet connected to a neural mouth/tongue rig,
a PL/EN/DE forced aligner, a streaming audio buffer or haptic hardware.
Its numeric channels alone do not create a visible tongue or therapeutic
articulation. Existing MP4 playback remains unchanged. No Vidu weights or
characters have been copied or recovered.

Two user-supplied local reference recordings are available: a 23.83-second
368x464 clip and a 419.68-second 1078x1792 recording with nominal 60 FPS.
The latter's AAC stream starts 82.292 ms after the H.264 video stream.
Sparse frames show consistent character appearance and different mouth
shapes, but do not establish quantified identity drift, phoneme accuracy or
the claimed 360 ms motion lead. `measureTiming` summarizes explicitly supplied
measured offsets; it is not an automatic video/audio alignment detector.

LivePortrait's published code license is MIT, but its bundled InsightFace
detection weights are restricted to non-commercial research; commercial use
requires replacement detection weights. EchoMimicV3 Flash Pro's upstream
README describes 8-step generation, up to 768x768 and 12 GB VRAM requirements.
Neither source guarantees reference-level quality or therapeutic articulation.
No additional weights have been downloaded in this step. Model and dependency
licenses and a real render comparison must be checked before adoption.

Studio now offers separate reference profiles for Luna and the user's original
bear portrait through `helpers/characterProfiles.ts`. The bear original is
stored unchanged at `public/avatars/bear-original.png`; both images have pinned
SHA-256 digests checked before cloud-batch export. A mismatch fails explicitly.
Selecting a batch profile does not replace Luna, change her voice, claim a
trained rig, or upload to Colab automatically. The existing batch request format
is preserved. A generated bear video must be reviewed before live use.

The main screen now has an explicit `activeCharacterId` selector. The
`nexus-librarian` identity is the default on a fresh profile; prior custom
portraits are preserved and can be explicitly selected. The three reference
images have pinned hashes, but only the frontal face is displayed during the
conversation. Older prototype switching/overlay behavior is retired from the
main view and is not an accepted live renderer.

The first original-bear speech test has now rendered successfully through the
existing EchoMimic adapter on Colab L4. Output: 672x848, 78 frames at 25 FPS,
3.12 seconds, H.264/AAC. Both streams start at zero and report 3.12 seconds.
The downloaded MP4 passed full local FFmpeg decoding and matches cloud SHA-256
`af8be202117241262e6a8371462c73bc1e194f8ca35ed234aca3e804ad04e3cc`.
The input portrait was verified against the profile's original digest.
Speech is locally synthesized Microsoft Paulina saying "Czesc! Milo cie widziec."
(Polish spelling with diacritics in the actual synthesis input), mono 16 kHz.
A job-specific runner adds a bear prompt without modifying the shared adapter.
Six sampled frames show blinking, several muzzle shapes and paw movement, but
also generated teeth not supplied by the original. This is a batch preview,
not exact therapeutic articulation, measured phoneme alignment, a trained bear
model, or proof of identity stability over minutes. At the time of that
historical render no default avatar replacement or Floot deployment was
performed; the current default profile is documented above.

The user increased the total authorized allowance to 30 existing Colab compute
units, with no purchases or paid API authorization. The initial balance was
155.16; after this render/review the panel showed 148.70 (approximately 6.46
used across the session). The L4 runtime reports approximately 1.54 units/hour,
including idle time. This authorization does not classify it as a FREE backend.

An authorized original-voice experiment now exists separately from EchoMimic:
`avatar-cloud/clone_character_voice.py` uses pinned Chatterbox Multilingual V3
source/model revisions and requires explicit voice consent. The user confirmed
rights/consent for new speech; the candidate reference is 0:30-0:50 from the
supplied long film. The original AAC was extracted without re-encoding, and the
candidate was converted to mono 24 kHz PCM for conditioning. The chosen fragment
is not independently verified to contain only one speaker.

The first new Polish sentence generated a 4.76-second WAV. Its 21.18-second
generation measurement included reference conditioning, but excluded model
loading. The saved WAV matches SHA-256
`d5502a6ff05d33c3d51dff25d8c0940a8e1c1111cc6167fa10f2b728ece29bc3`.
The user subsequently compared the newer cached-session sample with the
original reference and explicitly chose to preserve this voice. This is
subjective listening approval, not a quantified voice-identity measurement.
Keep the private reference WAV unchanged: SHA-256
`3ccaf941865b39e81c5b8fd0e1aa4c44e708737d7a7dedfbfebbc614bf27358f`.
Generation watermarking remains enabled.

A separate same-process L4 benchmark loaded the model once (15.83 seconds)
and conditioned the reference once (1.30 seconds). Three different sentences
then generated 2.00/2.84/4.24 seconds of audio in 2.63/3.03/4.18 seconds.
The speaker-conditioning fingerprint remained unchanged for all three calls.
This supports keeping voice state warm across turns; it does not establish
audible voice similarity, streaming first-audio latency, hour-long stability or
end-to-end conversation latency. `CharacterVoiceSession` retains that state
with serialized calls and reference/conditioning checks. The main UI's imported
MP4 remains a muted looping preview, not lipsync for these new sentences.
Continuous high-quality live bear rendering is still outstanding.

The shipped cached-session CLI was subsequently exercised on L4 with two
`--text` arguments in one process: audio durations 2.64/2.76 seconds and
generation times 3.03/2.86 seconds, excluding model/reference loading.
Both outputs reported unchanged conditioning and reuse of the prepared session.
The second WAV was saved locally and matched the cloud SHA-256
`30b9add19a85fe05fd07cc0f7f7b76a3af51dc6403a99c7d40fac0ae1ed5a321`.
Budget at this verification: 147.54 units remaining from 155.16 initially,
or 7.62 consumed within the user-authorized 30-unit total. This is a finite
Colab allowance, not an indefinite free conversational backend.

`helpers/characterSession.ts` connects the core to injected playback-clock,
renderer and scheduler interfaces. It checks audio hash/duration and rig
capabilities, rejects estimated timing unless opted in, and blocks stale
callbacks after replacement. Unsupported tongue/teeth channels are refused by
default; explicit suppression reports which channels were omitted. Real browser
clock adapters and a visible neural/articulatory renderer are still required.
`scripts/avatar-reference-benchmark.mjs` reads local FFprobe metadata and frame
timestamps for one or more reference recordings. Its report deliberately does
not equate container timing with measured phoneme synchronization.

## Pipeline

A faster original-bear offline render now passes on Colab L4 through animal
v1.1 + JoyVASA + TensorRT 8.6.1 in a third isolated environment. For the accepted
2.76-second WAV, learned motion took 0.546 seconds and 69 warm frames took
2.573 seconds (26.813 FPS). First warm drawing frame: 34.3 ms; model/source
startup: 9.118 seconds. The saved 768x960 H.264/AAC clip has 69 frames at 25 FPS,
matching 2.76-second audio/video durations; cloud and local full decoding and
the downloaded SHA-256 were verified. Sampled frames show blinking and changing
muzzle shapes while retaining the bear's original costume and paws.
These measurements exclude TTS and encoding, and do not establish streaming,
clinical articulation, long conversations, user visual approval or FREE hosting.
No production UI/default voice/Floot replacement was made.
The user subsequently required a return to Microsoft Paulina narration if
reference-film quality cannot be matched. That quality has not been established
by the short animal benchmark. The local Nexus browser now explicitly selects
Paulina and disables conversation-film rendering, restoring ordinary local
read-aloud without waiting for a cloud video. The voice preview completed;
the experimental bear voice/renderer remains separate and is not production-approved.

After the long-conversation engine is operational, the user requests 100
calibrated views of the same character for expression, behavior, movement and
pronunciation/word-learning examples in PL/EN/DE. Cover Polish l-with-stroke,
alveolar R, fricatives/affricates SZ/CZ/RZ and context-sensitive nasal vowels
E/A-ogonek, as well as language-specific English/German articulation.
These are reference poses, not a claim that 100 still images guarantee perfect
speech. Pair them with synchronized audio/video, verified phoneme timing,
coarticulation, tongue/lip/jaw control and explicit voicing/airflow distinctions.
Therapeutic teaching examples require qualified speech-language review;
dataset selection and annotation remain pending until the preceding engine
work is complete.

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

Local FasterLivePortrait rendering remains batch-only in the Agent Hub: its
`run_audio_driving(...)` integration produces a completed MP4, not incremental
frames. EchoMimic and the legacy android/Luna videos remain available only for
explicit batch, Studio or legacy/demo flows. None is a fallback for the default
Nexus Live session. Browser-local custom portraits remain selectable, while
fresh installs use the verified librarian reference.

## Per-reply conversation rendering

The current default assistant identity is `nexus-librarian`, a professional
photorealistic woman matching the fixed frontal reference. Conversation and
company agents use the Nexus identity and feminine Polish self-reference.
Nexus AI remains the application name; Paulina remains the local speech voice,
not the assistant's name. Luna, bear and user-provided portraits remain
separately selectable; switching the active character does not change the
canonical librarian's pinned identity.
The conversation prompt asks for contextual warmth, compassion for sadness and
calm acknowledgement of frustration, without aggression or emotion labels in
speech. This governs wording, not facial animation. Automatic facial emotion
selection and reviewed sadness/displeasure clips are not yet available.

Non-Nexus characters retain a separate opt-in batch lip-sync mode. It is
disabled for the canonical Nexus Live identity and never substitutes a
pre-rendered clip when its neural renderer is unavailable.
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

Polish chat guidance asks for natural, concise spoken sentences, feminine
self-reference and a simple greeting without repeated introductions. This is
model guidance, not a guarantee of grammatical accuracy from small local models.
Speech preparation preserves the on-screen response and factual values, removes
Markdown headings/emphasis/list markers, reads link labels and inline code,
and replaces fenced code blocks with a localized notice that the code is in the
written response. Raw URLs and numbers are not rewritten. The same helper is
used for browser speech, local Polish WAV and per-reply Paulina synthesis, so
the supplied lip-sync audio still matches the words actually spoken.
Disabling per-reply video clears its previous error and persists ordinary TTS
selection; it does not enable a paid renderer or claim exact live lip-sync.

An explicitly authorized manual Colab L4 test rendered the original Paulina
audio with EchoMimicV3 Flash Pro: 11.12 seconds, 768x768, 25 FPS, 278 frames,
H.264/AAC, approximately 986 seconds to render. Full decoding and matching
audio/video duration passed. This does not establish perfect phoneme-level
lip-sync. That audio predates the Luna rename and still says Nexus; the new Luna
greeting audio has not been rendered into a replacement speech clip.
The session consumes existing compute units under a separate 10-unit allowance;
it is not free compute and the Nexus FREE flag was not disabled. Automatic
per-reply rendering is still unconfigured. Do not set the free-confirmed flag
merely to bypass this restriction.

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
