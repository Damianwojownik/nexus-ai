# Own Nexus avatar engine

## Supplied conversation audio

The authenticated worker also accepts `audio` (base64 WAV) and
`audioMime: "audio/wav"` with the existing `image`, `mime`, `text` job payload.
It validates mono 16 kHz, 16-bit PCM lasting 0.2-30 seconds and saves the supplied
bytes as `speech.wav`, never synthesizing a replacement voice. Set
`NEXUS_AVATAR_ENGINE=echomimic-v3`, `NEXUS_NOSI_DIR` and
`NEXUS_RENDER_PYTHON_ECHOMIMIC_V3` to the verified isolated environment.
The EchoMimic worker listens on loopback, for an authenticated HTTPS reverse
proxy on an authorized host. Existing text-only JoyVASA jobs remain unchanged.
Selecting an incompatible engine for supplied audio fails explicitly.

The local Hub requires server-only `NEXUS_AVATAR_SERVER_URL`,
`NEXUS_AVATAR_SERVER_TOKEN`, and `NEXUS_AVATAR_FREE_CONFIRMED=true`.
Only confirm after independently verifying no credits, subscription or paid
compute are consumed. The worker reports zero cost only with
`NEXUS_FREE_MODE=true`; this configuration assertion is not a billing audit.
The Hub rejects unknown/nonzero cost or missing supplied-audio capability.
Tokens never enter browser bundles, notebooks committed to Git, or logs.

Do not expose a free Colab runtime as a persistent remote service or bypass its
notebook UI restrictions. Use an authorized zero-cost host for automatic jobs;
ordinary Colab file-based rendering remains a manual notebook workflow.
The currently shared Colab Pro L4 session reports compute-unit usage and is
not a verified free rendering backend. No new conversation render has been
validated there under FREE constraints.

## Experimental EchoMimicV3 / nosi adapter

`nexus_render_engine.py` accepts `echomimic-v3` in its existing sequential
queue. This is an experimental batch adapter, not a production-quality
live stream, trained Nexus model, or VRM/Anima integration.
Existing engines and defaults are unchanged.

Set `NEXUS_NOSI_DIR` to a nosi checkout at commit
`a6bdb2a93ce2754dcbb1de74ac89c513b655f99f`, and
`NEXUS_RENDER_PYTHON_ECHOMIMIC_V3` to its isolated Python interpreter.
The job needs exactly one `portrait.png` or `portrait.jpg` and a non-silent,
mono 16 kHz `speech.wav` lasting 0.2-30 seconds. No voice is cloned or
substituted automatically. Queue example:

```json
{"version":1,"jobs":[{"engine":"echomimic-v3","directory":"echo-preview"}]}
```

Install the nosi requirements separately, then install
`requirements-echomimic.txt` in that isolated environment. The unconstrained
nosi resolver can install Transformers 5, whose Wav2Vec2 encoder does not
return the hidden states required by the vendored EchoMimic audio encoder.
Do not apply these compatibility pins to existing face/body/studio environments.
Upload `configure_echomimic.py` and `echomimic-low-vram.patch` alongside the
adapter. Apply the patch explicitly on the cloud worker:

```bash
NEXUS_CLOUD_WORKER=1 python configure_echomimic.py /content/nexus-nosi-test/repo
```

Setup verifies the source revision and patch applicability before modification,
and is idempotent. The adapter refuses inference if the patch is absent.
The patch keeps inactive model weights on CPU: text encoding, VAE encoding,
CLIP conditioning, denoising and VAE decoding use GPU in separate stages.
It does not reduce resolution, inference steps or frame count.
Under its `models/echomimic`,
provide the complete `Wan2.1-Fun-V1.1-1.3B-InP` backbone including tokenizer,
text and image encoders, `EchoMimicV3/echomimicv3-flash-pro` weights, and
`chinese-wav2vec2-base` encoder. Downloading only Flash weights is insufficient.
Model licenses are separate from code and training-data licenses.

The adapter rejects missing weights (no backbone-only substitution), wrong
source revision, invalid frames and existing output files. It verifies
animation and audio before publishing `video.mp4`, then records metadata with
`visualApproval=false`. Review identity, hands, lip sync and chunk transitions
before use. Upstream chunk blending is not persistent live pose memory.
Failed intermediate files remain for diagnosis; retry in a new job directory.

Colab validation on 2026-10-04 passed the adapter/queue tests, including
Linux/FFmpeg integration. A short L4 GPU render passed at 384x480
(51 frames at 25 FPS, H.264 + AAC, no decode errors, duration delta <0.1 s).
After applying `configure_echomimic.py`, the same job shape also passed at
672x848 through `nexus_render_engine.py` with the preserved portrait and the
same speech clip. Queue output probe reported 51 decoded video frames and
SHA-256 `4d33161a85447d1e12509f72eef899cfa1a35730c95331bb35bc52c9f0754378`.
Sampled frames show facial motion and hand gestures, not proof of anatomical
correctness or precise lip sync throughout. Longer clips remain unverified.

## Colab: Portrait Studio image to experimental avatar movie

Portrait Studio on `feat/portrait-studio` edits still photographs using
Qwen-Image-Edit-2511. Use a separate Python environment for its requirements;
do not upgrade the existing face/body environments in place. Run image editing
as a separate process and let it exit before loading either video model.

Review the edited image, especially finger count, joints, wrist alignment and
identity. Then pass the approved PNG directly to the existing cloud renderers:

```bash
export NEXUS_CLOUD_WORKER=1
python /content/nexus-avatar/portrait_avatar.py \
  /content/approved-portrait.png /content/new-avatar-job \
  --text "Cześć, jestem Nexus." --approved \
  --face-box 0.30 0.04 0.40 0.27
```

The normalized face box is specific to the supplied image, not a universal
default. The output directory must not already exist. Each stage writes its
own log and stops on failure. Successful output is `body/video.mp4`, with
`workflow.json` recording the approved input and the need for video review.
Display it with Colab `Video(..., embed=True)` and download it with
`google.colab.files.download(...)`.

This connects the image/face/body batch workflow, not a live worker or Floot
integration. Speech still uses the existing technical test voice. Image
approval does not guarantee correct fingers after diffusion motion generation:
review the entire final video before choosing it as an avatar. The layered
animation remains the opt-in prototype described below, not a coherent
stateful full-body engine.

## Two-engine boundary: unified character, separate background

The requested character engine must animate **one anatomically coherent body**:
head, neck, shoulders, torso, hands and legs respond together to commands.
It is not satisfied merely by placing independently generated face and body
clips on one timeline. The background is a separate engine/output.
The scene compositor does not regenerate either output.
Internal modules may be used, but they must share a coherent pose and motion
state; there must not be an independently pinned head during body movement.

**The current face/body layer prototype does not meet this requirement.**
It is retained only as an opt-in research experiment, not the production
character engine. The accepted Pro portrait is still a head-animation result,
not proof of a finished full-body command-controlled avatar.

`compose_scene.py JOB` consumes this explicit `scene.json` on the cloud worker:

```json
{
  "characterClip": "/content/character-job/video.mp4",
  "backgroundClip": "/content/background-job/video.mp4",
  "matteClip": "/content/character-job/matte.mp4"
}
```

The per-frame grayscale matte must follow the moving character, including
hands, hair and translucent glow (white = character, black = background).
Every clip must have the same resolution and frame rate, and cover the full
character duration. Missing/short layers, colored masks and mismatched timing
fail explicitly; no rectangular-crop fallback or frozen last frame is used.
Audio comes only from the unified character clip. Output is a separate
`scene.mp4`; the source clips are not overwritten.

The compositor interface and pixel invariants are tested. Automatic temporal
matting and an autonomous AI background generator are **not implemented** by
this adapter. Current LTX experiments still contain their original background
until a reviewed matte and separate background clip are supplied; do not label
them transparent cutouts or a completed live scene system.

### Commands and voice: target behavior versus verified features

The user's target is stateful command-driven animation: raise/lower hands,
walk/stop, sit/stand, with the current pose retained between commands.
Recognizing words is not sufficient evidence that the body executes them.
A motion controller must keep pose/action state and dispatch verified motions;
the present batch previews do not implement that controller or persistent
live scene state. Do not mark a command completed merely because its prompt
was passed to an image-to-video model.

The [Vidu S2-Avatar feature guide](https://shengshu.feishu.cn/wiki/XrROwZ7f9iFqRakNqWiclDhHnYf),
reviewed in the browser on 2026-10-03, documents voice/text control of behavior,
expressive large-scale movements and reference-image choices for handheld
objects, clothing and background replacement. It does **not** disclose the
underlying skeleton/IK/matting architecture, confirm a separate background
engine, or specify persistent posture memory across sessions. Other Vidu
motion-control marketing pages are not evidence of those internals in S2-Avatar.

Each character should have a stable natural voice profile with matching
lip-sync audio. The cosmic previews currently use Polish espeak-ng as a
technical test voice, not a finished natural voice. No real person's voice is
inferred or cloned from their photograph.

## Experimental fixed-portrait body layer

Upload `body_layers.py` alongside the renderer even for unlayered whole-image
trials; it contains the shared timeline helpers. No independent head layer is
used unless a job explicitly supplies `body-layers.json`.

`render_body.py` accepts an optional per-job `body-layers.json`:

```json
{"protectedTop": 0.32, "feather": 0.06}
```

This retains the top 32% of the padded source image exactly before video
encoding, blends through the next 6%, and uses generated motion below that.
It is an explicitly **static source-portrait layer**, not a moving FlashHead
face, identity-conditioned generation, lip sync or guaranteed blinking.
Choose boundaries for each source image; these example fractions are not a
face detector. No settings file means the original full-image behavior.
Invalid settings fail before GPU inference.

To use the **independent approved face engine** instead of a static portrait:

```json
{
  "protectedTop": 0.32,
  "feather": 0.06,
  "faceClip": "/content/approved-face-job/video.mp4",
  "faceCrop": "upper-square"
}
```

The square face clip must have been made from the upper square of the same
uncropped body image. It is resized to body width, sampled at matching times,
and supplies the protected top region and the audio. A short, non-square,
undecodable or missing face clip fails explicitly before GPU inference.
The entire face timeline is preserved: the generated 97-frame body gesture
is deliberately retimed across the face clip's frame count/rate. Audio is
copied from that face clip without trimming its final spoken sentence.
Repeated body samples during retiming are intentional rate conversion, not
a fallback when a face clip fails to decode. All face frames must decode.
This is layered composition of two independent engine outputs, not a merged
model. The face clip itself remains unchanged. Mouth/neck regions outside the
chosen protected boundary are not guaranteed to be face-engine pixels.

### Experimental tracked face layer

Opt in with `"mode": "tracked"` and a manually selected normalized
`faceBox` (`x`, `y`, `width`, `height`) enclosing the head in the padded output
image, not the original upload:

```json
{
  "mode": "tracked",
  "protectedTop": 0.32,
  "feather": 0.10,
  "faceClip": "/content/approved-face-job/video.mp4",
  "faceCrop": "upper-square",
  "faceBox": [0.25, 0.08, 0.50, 0.35]
}
```

These box coordinates are examples, not a detected face. The entire box must
fit inside the upper-square face crop. `protectedTop` remains required for
configuration compatibility but does not control the tracked mask.
In this mode `feather` is a fraction of the elliptical face radius, not of
frame height. Optical flow tracks textured upper-face features independently
in the body and face clips. Checked similarity transforms align the face
to the body head; a moving elliptical mask leaves the rest of the body intact.
The interior uses the aligned face pixels without blending. Geometric
resampling can still soften pixels; this is not lossless face preservation.

Feature loss, poor forward/backward agreement, insufficient RANSAC inliers,
excessive scale/rotation, or a head leaving the frame stops composition
explicitly. The tracker supports modest in-plane motion, not large 3D head
turns, hand-over-face occlusions, or recovery after the head disappears.
It does not perform semantic hand segmentation or fix generated anatomy.
Synthetic alignment tests do not certify a real GPU render: review the full
video before use. Omitting `mode` retains the original fixed-layer behavior.

Optional `body-motion.json` with `{"returnToSourcePose": true}` selects the
installed LTX conditioning pipeline with the original body image at frame 0
and frame 96, both strength 1.0 and image conditioning noise 0. This asks the
gesture to return to the original pose; it does not guarantee correct fingers
between those frames. Without this file the existing image-to-video pipeline
is unchanged. No extra model weights are needed for this conditioning mode.
An optional `poseStrength` in `(0, 1]` controls only the final image condition,
for example `{"returnToSourcePose": true, "poseStrength": 0.65}`. Frame 0 stays
at strength 1. Lower final strength is an experimental compromise between
appearance drift and frozen motion, not a verified sharpness/gesture fix.

Use only small motions that stay below the protected region. Inspect every
clip for doubled contours, disconnected shoulders, camera drift, distorted
fingers and insufficient movement. Pixel protection does not make a bad body
render acceptable. Two earlier cosmic-character full-image LTX tests were
rejected: one lacked clear hand articulation; the stronger one moved the hand
but blurred/changed the face and fingers. Preserve the approved FlashHead Pro
portrait rather than replacing it with those experiments.

On 2026-10-03, an additional L4 trial combined the approved cosmic Pro clip
with a separately generated pose-anchored LTX body gesture. The retained result
was 512x768, 125 frames at 25 fps and approximately 5.017 seconds including
audio. Full browser playback completed. The copied audio packet hash matched
the original Pro clip exactly, so the last sentence was not cut off.
Across all encoded frames, the maximum per-frame mean absolute pixel error
in the protected top 276 rows was 1.377 on a 0-255 scale versus the corresponding
Pro frames. The small error is video encoding, not re-generation by LTX.
Visual inspection showed restrained movement with less distortion than the
unconstrained gesture; this is not a validated walking/sitting/finger controller
or a transparent character. The original approved portrait remains unchanged.
The user subsequently clarified that head and body must move as one continuous
anatomical character, not as protected horizontal layers. Consequently this
trial is **not accepted as the target body engine**, despite its face-preservation
and audio checks. Those checks validate only the experiment's narrower invariants.

A subsequent whole-image wrist/finger trial used no independent face layer.
The model returned a decodable 512x768, 97-frame clip, but review of eight
time-separated frames and the user's playback assessment found no clearly
visible hand articulation. This trial was **rejected**, not a successful gesture.
Strong identical start/end pose conditioning preserved appearance but did not
produce the requested movement. The generic moving-frame validator is not a
hand-action validator and must never be presented as one.
Further hand trials should use a clear reference showing all fingers, wrist
and forearm, without major occlusion/glow. A clearer input alone does not
guarantee motion quality; visible articulation and anatomical continuity must
still be reviewed before accepting the result.

## Separate SoulX-FlashHead cloud backend

### Quality selection

Lite remains the default. Set `NEXUS_FLASHHEAD_MODEL=pro` explicitly for the
quality-oriented Pro variant; both renderer and health metadata identify the
selected model. Run `setup_flashhead_models.py` with that same setting and
`NEXUS_MODEL_DOWNLOAD_CONSENT=1` to download `Model_Pro` and `VAE_Wan` on the
cloud host. Missing Pro weights raise an error instead of falling back to Lite.
For the notebook preview, set `FLASH_QUALITY = 'pro'` and upload
`setup_flashhead_models.py` as well. Pro is slower and uses additional GPU/disk
resources. Both upstream variants target 512x512 at 25 fps by default; Pro is a
model-quality change, not native Full HD. Compare the same portrait and audio
before choosing it for a character.

The Pro variant was rendered and visually compared on the same Colab L4 on
2026-10-03 with the same Nexus boy image and Polish script as the Lite test.
Browser playback completed at 512x512, 25 fps and approximately 3.56 seconds;
the motion/audio validator passed. Matching-time review frames showed better
hair/eye definition in Pro for this portrait; this is a visual assessment, not
a universal model-quality guarantee. Cold first-chunk compilation took about
299 seconds, and subsequent internal chunks took approximately 7.2 seconds,
versus approximately 0.67 seconds for Lite. Pro on this L4 is not a real-time
conversation backend. Both preview files and the notebook were saved, and Lite
remains the default to avoid an unrequested latency/cost change.

`Dockerfile.flashhead` and `flashhead_worker.py` provide an isolated alternative
to the existing LivePortrait/JoyVASA worker. The adapter uses the official
[SoulX-FlashHead](https://github.com/Soul-AILab/SoulX-FlashHead) Lite model
(code pinned to `9bc03de06bb0de82cd6bc477804512ae06144bf2`), public model weights
and Polish espeak-ng speech. Both code and the published FlashHead model card
declare Apache-2.0; check the separate wav2vec2 dependency's terms too.
Model downloads require an explicit cloud setup step and do not run on the desktop.

Use a Linux NVIDIA GPU host with an Ampere-or-newer GPU, at least 16 GiB VRAM
and sufficient disk for the image, build cache and model weights. RTX 4090 with
24 GiB is the upstream Lite benchmark target; do not infer identical performance
on Colab A100/L4 or compatibility with T4. This guard is a minimum compatibility
check, not a measured real-time performance guarantee.

From this directory **on the cloud host**, build and download the Lite weights:

```sh
docker build -f Dockerfile.flashhead -t nexus-flashhead .
docker run --rm \
  -v nexus-flashhead-models:/opt/SoulX-FlashHead/models \
  -e NEXUS_MODEL_DOWNLOAD_CONSENT=1 \
  nexus-flashhead python setup_flashhead_models.py
```

Supply a private environment file containing a randomly generated
`NEXUS_AVATAR_SERVER_TOKEN` (at least 32 characters), then run:

```sh
docker run --rm --gpus all \
  --env-file /private/nexus-avatar.env \
  -v nexus-flashhead-models:/opt/SoulX-FlashHead/models \
  -v nexus-flashhead-jobs:/data/jobs \
  -p 127.0.0.1:8000:8000 nexus-flashhead
```

Put this private port behind an authenticated HTTPS reverse proxy; do not expose
plain HTTP publicly. The worker retains the existing `/jobs`, `/jobs/{id}` and
`/jobs/{id}/video` protocol, so the Hub's `NEXUS_AVATAR_SERVER_URL` and
`NEXUS_AVATAR_SERVER_TOKEN` configuration can point to it without sending the
server token to the browser. `/health` reports `soulx-flashhead-lite`, `mode: batch`.
Only after a real health check and visually inspected render should the endpoint
be configured in Nexus/Floot. No endpoint or hosting account is provisioned here.

This first adapter is **batch MP4**, not a persistent low-latency stream.
It limits previews to 300 characters / 30 seconds, rejects overwritten jobs,
and validates moving frames plus an audio track before completing a job.
Upstream's `audio_encode_mode=stream` chunks inference internally; it does not
make this HTTP adapter a WebRTC streaming server. A resident model, streaming
transport, synchronized audio, interruption and per-user sessions remain separate
work before it can replace the live avatar. Colab may be used for notebook-based
experiments with compatible GPUs, not a tunneled always-on backend.

The existing `Nexus_Colab_Kaggle.ipynb` now includes independent FlashHead setup
and preview cells at the end. Upload the scripts specified in that section and
run only those cells, not the older face/body cells. `setup_flashhead_cloud.py`
creates an isolated Python 3.10 environment and records package installation
output in `/content/nexus-flashhead-lite/setup.log`. An installation, missing GPU
or invalid render stops with an error; no different engine is silently substituted.
The pinned upstream requirements have a resolver conflict: NCCL 2.27.3 versus
PyTorch 2.7.1/xformers 0.0.31 requiring NCCL 2.26.2. The cloud setup and container
derive a separate requirements file using 2.26.2, without modifying upstream code.

On 2026-10-03, the Lite adapter rendered the Nexus boy in a remote Colab Pro L4
runtime (23034 MiB GPU memory), using its isolated Python 3.10 environment.
The resulting MP4 decoded in the browser: 512x512, 25 fps, approximately 3.56
seconds, H.264 plus AAC Polish espeak-ng speech. The moving-frame/audio validator
passed and the portrait was visually inspected. First-chunk compilation took
about 205 seconds; subsequent internal chunks took approximately 0.67 seconds
each. These are model-chunk timings, not measured conversational latency.
The Docker image itself and a permanent HTTPS/Floot live deployment are not yet
tested. Colab's temporary disk does not persist the installed environment/weights;
the saved notebook/scripts recreate them, and the rendered MP4 must be retained.

## Colab / Kaggle batch alternative

Open `Nexus_Colab_Kaggle.ipynb` by uploading it to Google Colab or importing it into
a Kaggle Notebook. Choose a **remote** T4/P100 GPU runtime with Internet enabled.
Also upload this directory's `render.py`, `download_models.py`, `requirements.txt`
and the portrait when the notebook requests them; use private input storage in Kaggle.
Follow the cells in order. They create an isolated Python environment, download
public models, generate one short clip, then offer preview/download.

No notebook is connected as a permanent Hub backend. Free Colab disallows bypassing
its notebook interface with a generation web UI, remote-control use and deepfakes.
Use only your fictional character and comply with platform terms; no tunnels,
limit bypass or local runtime fallback is implemented. GPU availability is not
guaranteed. Check Kaggle's account verification requirements, accelerator quota
and Internet setting in your own account; no fixed free quota is promised here.

### Google AI plans, storage and quotas

Eligible **paid** Google AI plans now include premium Colab benefits and a monthly
compute-unit grant, applied to the same Google Account. Free promotional trials
do not include these compute benefits; rollout and allocation depend on the plan.
Read [Colab's AI-plan FAQ](https://research.google.com/colaboratory/faq.html)
and check the actual balance in Colab's Resources panel. Do not infer an unlimited
GPU server, guaranteed GPU type, permanent runtime or background execution from
the Pro subscription.

Google One's 5 TB storage allowance is shared by Drive, Gmail and Photos. It does
**not** increase Colab's temporary VM disk, system RAM or GPU VRAM. Save important
artifacts outside the temporary runtime (download them, or copy them to Drive
after authorizing the official Drive mount). Do not assume the notebook's saved
location on Drive also saves files under `/content`.

Google Flow's image/reference-to-video features and AI credits are separate from
Colab compute units. See [Flow model capabilities](https://support.google.com/flow/answer/16352836)
and check generation costs in its UI. They can help produce cloud video assets,
but are not integrated into this worker and are not a downloadable 3D skeleton.
Likewise, subscription benefits are not an API key or unlimited API allowance:
[Gemini API billing](https://ai.google.dev/gemini-api/docs/billing) is managed per
project. Eligible Developer Program Cloud credits need to be claimed/linked to
the appropriate account before use.

Optional LTX downloads can occupy tens of GB in the Hugging Face model cache,
in addition to the separate body environment. Deleting only their cache does not
affect LivePortrait/JoyVASA or Blender, but the next LTX render must download those
models again. Preserve portraits, accepted videos, rigs and face-model files;
inspect exact paths before any cleanup. Never delete the runtime root or a whole
cache containing unrelated models.

The notebook has generated a short clip on a remote Colab T4: 768x960, 25 fps,
3.64 seconds, H.264 video and AAC Polish speech. Sampled frames differed and the
browser decoded the full-frame preview. Kaggle is not yet tested. Each new portrait
still requires visual/lip-timing inspection. The notebook creates an isolated Python 3.11 with uv even when Colab's
kernel uses Python 3.13. The engine dependencies target CUDA 11.8-era GPUs.

This is a self-hosted batch rendering service, **not HeyGen**. It uses the upstream
FasterLivePortrait ONNX detection/motion models, original LivePortrait PyTorch
warping/decoder and JoyVASA audio-to-motion model with local Polish
espeak-ng synthesis on the server. No source photo is sent to a commercial avatar API.
The Windows desktop Hub does not import or start the models.

## Infrastructure prerequisite

### App-to-Colab batch bridge (no permanent server)

The Nexus frontend's **Silnik Colab** panel exports a versioned JSON request with
the selected portrait and a Polish script of 1-300 characters. It downloads the
file locally; no cloud upload happens until you explicitly upload it to Colab.
Treat this file as private. There are no tokens, machine paths or shell commands
inside the request.

Upload `batch_job.py`, `worker.py` and the request alongside the existing face
engine files. After notebook environment setup, run **Zadanie z aplikacji Nexus**.
This cell is independent of the earlier manual portrait-render cell. Alternatively,
on the configured Linux cloud runtime:

```text
NEXUS_CLOUD_WORKER=1 /path/to/venv/bin/python batch_job.py nexus-face-REQUEST_ID.json /path/to/jobs
```

The batch adapter reuses the worker's image validation, rejects unknown fields,
invalid IDs and oversized requests, and creates `batch-REQUEST_ID`. It never
overwrites an earlier job: export again for a new ID if you need a retry.
`render.log` records inference; a subprocess error or missing MP4 stops execution.
The same face engine performs speech/video validation before completing.

Inspect and download the resulting MP4, then choose **Wczytaj film z Colab** in
Nexus. The browser checks that the file decodes as a video (up to 120 seconds and
256 MB), plays it with sound/controls and can replay it. The imported film is
available only during the page session; retain the downloaded MP4 and reimport
after a reload. Import does not prove identity or lip-sync quality, associate a
film with a particular reply, or start any inference on the desktop.

This bridge does not make Colab an HTTP service, bypass limits, use a tunnel or
claim real-time animation. The existing authenticated HTTPS worker remains the
separate option for an actual permanently deployed cloud backend.
An actual app-exported boy request was rendered in Colab and imported back into
Nexus: 768x768, 25 fps, 3.64 seconds, H.264 with AAC Polish speech. Reviewed frames
kept the boy's identity with mouth movement, and the browser decoded the entire
clip and restored the portrait. An invalid MP4 produced an explicit error and did
not discard the previously imported film. This verifies the file bridge, not an
always-on service or guaranteed quality for every source/script.

### Optional character references and skeletal prototype

The notebook has two additional, independent modes. Neither replaces the verified
face renderer or changes the Hub HTTP protocol:

- `reference_pack.py` imports a collage into individual PNGs and `character.json`.
  The supplied layout is 6 columns by 2 rows; labels are assigned by position,
  not inferred expressions. Other grids use `--columns` / `--rows` and generic
  role names. Inspect crops/labels before use. Choose one role for LivePortrait;
  the pack is **not** a reconstructed 3D model or an automatic expression blend.
  Existing pack directories and existing job portraits are never overwritten.
  The supplied 6x5 cosmic boards have explicit positional templates:
  `--layout cosmic-expressions` (30 moods, default `calm`) and
  `--layout cosmic-storyboard` (30 shots, default `eye_contact`).
  Scene/logo entries are rejected as face sources. Use `--bottom PIXELS`
  (0-64) to exclude each panel's caption strip; inspect the exact crop first.
  Cropping must retain at least 96 pixels of panel height; it cannot restore
  detail lost in these small source images.
  Templates are only valid for the supplied ordering, not arbitrary collages.
- `render_rig.py`, `blender_rig.py`, `rig_motion.py` and `verify_rig.py` create a
  controllable **stylized blue-hoodie boy prototype**, not a faithful reconstruction
  of the boy or woman in the reference photos. It has 27 bones, skinned meshes,
  fingers, eyes and audio-energy mouth opening. Motions are procedural, without
  motion capture, foot-contact IK or phoneme lip sync. The photo reference pack
  and this procedural mesh are separate assets; they are not fused.

Upload those scripts in addition to `render.py` and run the corresponding optional
notebook cells after the face environment setup. Blender is installed **only in
the remote runtime**. Cycles uses two cloud CPU threads, not the desktop GPU and
not CUDA. The distro Blender lacks OpenImageDenoiser; the prototype uses 32 samples
without denoising. Resource limits still apply.
Diffuse/glossy bounce limits keep the cloud CPU workload bounded; high resolutions
can still take many minutes. For a quick verification, use 256x384 and four seconds.
For a single framing preview, the cloud Blender script also accepts
`blender --background --python blender_rig.py -- /path/to/job --still`; provide
`rig.json` and a mono PCM16 `speech.wav` and inspect `preview.png`.

For a skeletal job, create `script.txt` with a short Polish phrase and `rig.json`:

```json
{"camera": "body", "action": "showcase", "fps": 12, "seconds": 6, "width": 384, "height": 512}
```

Run `python render_rig.py /path/to/job` with `NEXUS_CLOUD_WORKER=1` on that Linux
cloud runtime. `camera` is `body` or `face`; `action` is `idle`, `wave`, `walk` or
`showcase` (wave then steps in place). Supported bounds: 12-30 fps, 4-10 seconds,
even dimensions 256-768. Speech longer than the clip is rejected, not truncated.
Invalid settings and render errors stop the job explicitly.

Outputs: `video.mp4`, `character.glb` with skeleton/animation, editable
`character.blend`, normalized `rig.json`, `rig-report.json` and
`export-verification.json`. The validator reads actual GLB skin and quaternion
tracks; static joints are not accepted in place of the requested motion. MP4
validation also requires changing frames and speech. Visual inspection is still
required for gesture direction, cropping, anatomy and foot sliding.
The notebook offers a ZIP for download. Save it before a free runtime expires.
The corrected cloud smoke test produced a 256x384, four-second H.264/AAC clip
at 12 fps, plus a 256x256 face-camera still. The downloaded GLB was independently
checked: one skin, 27 joints and changing head, hand, finger, thigh and calf
tracks. Sampled frames showed the greeting and subsequent steps; the camera
still framed the same prototype's face. This confirms the rig path, not
photorealistic reconstruction or natural foot contact.
There is no local 3D renderer, automatic photo-to-body reconstruction, app GLB
viewer, persistent cloud backend or guarantee of photorealistic quality.

Reference CLI example on the cloud:

```text
python reference_pack.py import collage.png new-character-pack --columns 6 --rows 2
python reference_pack.py select new-character-pack neutral new-face-job
python render.py new-face-job
```

For the supplied WhatsApp boards, preserve two separate packs:

```text
python reference_pack.py import expressions.jpeg cosmic-moods --layout cosmic-expressions --bottom 20
python reference_pack.py import storyboard.jpeg cosmic-story --layout cosmic-storyboard --bottom 20
python reference_pack.py select cosmic-moods calm new-cosmic-face-job
```

The 20-pixel caption inset is an example, not automatic text detection. Adjust it
to the actual panel resolution. Panel numbers are not recognized or removed.
Do not replace the accepted blue-boy portrait with any of these separate assets.

Create the face job directory and its `script.txt` first. Strong profiles, closed
eyes and occluded faces are unsuitable sources for some face detectors; choose
a clear frontal reference for the first render. More images do not automatically
supply an unseen body or motion.

### Optional full-body notebook mode

Upload `render_body.py`, `body_layers.py` and `requirements-body.txt` in addition
to the original files and run the optional body cells at the end of the notebook. This creates
an isolated environment for LTX-Video image-to-video, with an 8-bit T5 encoder
and cloud CPU offload to reduce GPU memory usage. It does not use desktop CUDA.
The prompt requests alternating knee lifts/steps, arm swings and torso rotation,
with a stationary full-body camera. A job's optional `motion.txt` overrides the
prompt (1-2000 English characters), for example gentle head and wrist motion
on a close portrait. The quality path generates with a 768-pixel long side and
dimensions divisible by 32, padding rather than cropping the source. A 768x1152
portrait produces 512x768, not an enlargement of the old 384x480 preview.
It uses LTX 0.9.5 with consistent
float16 diffusion/VAE precision and high-quality MP4 encoding. Blank/non-finite
frames are rejected. The previous float32 0.9.5 load exceeded free Colab's host
memory; reduced precision is necessary on that runtime. Larger dimensions alone
do not guarantee sharp detail or correct limb motion; compare with the source.
Generation is probabilistic: inspect each limb, anatomy and identity manually.
An MP4 with changing pixels alone does not prove correct whole-body motion.
Speech is muxed in, **without lip synchronization**; the earlier face-only
renderer remains available separately. Use a short phrase (up to 4.04 seconds);
longer synthesized speech is rejected before model loading rather than cut off.
This mode is notebook-only and is not
automatically exposed through the Hub or HTTP worker. Model loading may take
several minutes and requires additional disk space. Review the LTX open-weights
license before commercial use. The earlier 384x480 tests did not demonstrate
adequate leg motion and lost fine detail. They are not accepted full-body results.
The 512x768 close-portrait head/hand test moved the wrist and head, but replaced
the face with distorted hair/crystalline texture after the first frame. It is
also rejected as a finished avatar. For a talking close portrait, use the
separate LivePortrait/JoyVASA face renderer rather than this full-image mode.

Transparent RGBA/LA/palette inputs are alpha-composited onto black before model
conditioning, not converted directly to RGB with hidden background pixels.
The original image and alpha remain untouched. This prepares a neutral preview;
the generated H.264 MP4 is opaque, not a temporally matted transparent character.

For a short single-action trial, use `body-motion.json` containing
`{"returnToSourcePose": false, "frames": 49}` (about 2.04 seconds).
Supported preview counts are 33-97 of the form 8k+1; the default remains 97.
Speech must fit the selected duration and is rejected rather than truncated.
A per-job `negative.txt` overrides the existing negative prompt explicitly.
This is useful for a hand-only request where the old walking-oriented
`static body` negative would conflict with keeping the torso still.
LTX does not expose Vidu's Small/Medium/Large motion-amplitude setting in this
adapter; `poseStrength` is final-image conditioning, **not** motion amplitude.
Neither two independent test images nor crops are multi-reference conditioning.

Two supplied green-android references were tested independently on the L4.
Unconstrained 97-frame trials produced visible arm movement but face/hand
deformation later in the clip. Final-pose conditioning at strength 0.65
preserved appearance but produced no clearly usable hand gesture on either
image. Both variants were rejected.

A further frontal-reference trial used 49 frames, one short wrist-only prompt,
an explicit hand-focused negative prompt, and no end-pose/head-layer constraint.
It decoded at 608x768, 24 fps and 2.042 seconds; full playback completed.
Five time-separated frames retained the face better over this short duration,
but did not demonstrate a clear controlled wrist turn. It is **not an accepted
hand-animation result**. Prompt simplicity/short duration did not establish
Vidu-equivalent motion control; further work needs a genuinely controllable
motion/pose pipeline rather than claiming changing pixels as a successful gesture.

The subsequent RGBA android reference with a clear full hand produced a restrained
forearm/palm preview at 512x768, 65 frames/24 fps (2.708 seconds), without a separate
head layer or final-pose lock. Full playback completed. Forward/backward-consistent
tracking found median hand-region displacement 6.665 px versus face displacement
0.131 px; these measurements support the visual review, not finger/control guarantees.
The original transparent source is retained, but the MP4 has an opaque black background.

Adding a blink and smile by regenerating the whole character from the same still
produced eye closure/reopening and a smile, but also changed the hand anatomy.
The 73-frame combined trial is **rejected as a complete character**. A shorter
49-frame constrained prompt suppressed facial expression rather than solving the
interaction. Do not replace the accepted hand-motion base with either result.

### Experimental cooperative expression editing

`render_expression.py` uses native masked whole-video editing with
`Wan-AI/Wan2.1-VACE-1.3B-diffusers`, pinned revision
`ec4d2cb062b548996b179d493fdd05340de702a1`. It uses the existing
`requirements-body.txt` environment, with additional cloud-only model downloads.
This is not a new independent talking-head clip: the accepted body video is the
master motion/pose/timeline and the editor conditions on that same full video.

Upload `render_expression.py`, `expression_edit.py`, `scene_layers.py` alongside
the body renderer dependencies. In a new job, supply `expression-edit.json`:

```json
{
  "sourceClip": "/data/accepted-body.mp4",
  "maskClip": "/data/face-edit-mask.mkv",
  "faceRegion": [170, 150, 180, 160]
}
```

The example region is calibrated only for the stable-headed 512x768 android
preview, **not** a universal face location. Supply a same-resolution, same-FPS,
same-frame-count grayscale mask video: white requests edits, black protects the
master frame, and feathered edges blend the local edit. A lossless grayscale
FFV1 mask avoids accidentally activating pixels outside the authorized region.
Temporal masks can confine eyelid edits to a short blink interval and lip edits
to a later smile; all-black individual frames are allowed. All-black clips,
colored masks, out-of-region pixels and mismatched timelines fail before GPU
loading. Source dimensions must be divisible by 16; supported counts are 33-97
of form 4k+1. Optional `expression.txt` and `negative.txt` override prompts.

Run `NEXUS_CLOUD_WORKER=1 python render_expression.py /data/new-expression-job`
on Linux CUDA after installing `requirements-body.txt` (including `ftfy`,
required by the stock VACE prompt cleaner). After inference, `expression_edit.py` restores every unmasked
pixel from the **corresponding master frame**, including any incorrect hand/body
pixels the diffusion model might have generated. These pixels are asserted
identical before encoding. Final H.264 CRF 12 introduces small compression/color
differences; do not claim bit-exact decoded MP4 pixels. The master source hash is
checked for mutation, its audio is copied, and FPS/count/resolution are retained.
Existing output files are refused rather than overwritten.

This path needs an explicitly calibrated mask and visual expression/seam review;
it does not yet track a freely moving head or create masks automatically.
Protected hands do not prove a successful blink/smile. It is an experimental
cooperation mechanism, not audio-driven lip sync, a pose-command controller,
transparent video or a live Floot backend.

The stock string-prompt/offload path has now completed a real L4 inference:
65 frames, 512x768, 24 FPS, 30 steps (8 minutes 38 seconds for denoising alone).
The full 2.708-second output decoded in the browser and the source SHA256 stayed
unchanged. This is **batch inference, not real-time**. The first blink/smile
trial did not show a convincing full blink and is not an accepted expression result.
Decoded H.264 comparison measured maximum per-frame mean error of 1.736/255
outside the mask and 2.882/255 in the tested hand ROI. A strict hand-error
threshold of 2/255 failed; do not describe the final MP4 as pixel-perfect.
An unchanged-source control encode itself measured 2.881/255 maximum hand-ROI
error, demonstrating that RGB/chroma conversion is material. Pre-encoding
protected-pixel equality and decoded-video compression errors are distinct checks.
The accepted body master remains the reference, not the unapproved facial edit.
One further blink-only trial used larger eyelid masks on frames 16-31, without
the smile request. It also completed on L4 and retained the 65-frame timeline
and source hash, but reviewed frames still showed open green irises rather than
a full blink. It is **rejected as a blink result**. Its maximum decoded hand-ROI
mean error was 2.879/255. Do not promote either trial or keep running expensive
prompt variations as if they provided verified eyelid control. A dedicated,
tracked facial-control integration is still needed.
Both outputs decoded fully in the browser. All 60 compressed audio-packet
SHA256 hashes matched their respective source tracks; source videos remained
unchanged. These technical invariants do not override the failed visual blink review.

### Distinct static expression references

`expression_references.py` prepares **static** PNG references for `eyes_open`,
`eyes_closed` and `smile`, not a talking-head/body animation. It reuses the reviewed
master frame and transfers only explicitly masked eyes or mouth from a
same-identity, same-size, aligned donor video. Unmasked pixels (including hands,
neck, armor and background) are preserved exactly in the lossless PNG.
Donor body frames are never promoted: a video with rejected hands can supply
a separately reviewed facial state, without those hands being copied.

Prepare a new job with grayscale PNG masks and `expression-references.json`:

```json
{
  "masterClip": "/data/accepted-body.mp4",
  "masterFrame": 0,
  "faceRegion": [170, 150, 180, 170],
  "variants": [
    {"role": "eyes_closed", "sourceClip": "/data/facial-trial.mp4", "frame": 34, "maskImage": "/data/eyes-mask.png"},
    {"role": "smile", "sourceClip": "/data/facial-trial.mp4", "frame": 68, "maskImage": "/data/mouth-mask.png"}
  ]
}
```

Run `NEXUS_CLOUD_WORKER=1 python expression_references.py /data/new-job`.
The adapter records provenance/hashes in `references/references.json`, rejects
empty/out-of-region masks and nearly unchanged variants, and refuses an existing
output directory. A pixel-difference threshold only detects unchanged output;
it does **not** verify eyelid closure, smile semantics, alignment or mask seams.
Inspect the exported references before marking them approved. It does not infer
expressions or automatically align a different head pose.

For the green android, donor frames 34 and 68 from the earlier 73-frame LTX
facial trial supplied closed eyelids and a smile respectively. The earlier
trial remains rejected as a whole-body video. The resulting three localized
static references were visually reviewed: open green eyes, closed eyelids
without visible green irises, and a clearly different smile with the open
eyes retained. These are reused generated facial details, **not** a new VACE
success or three fresh model inferences. Animation, natural blink timing,
tracked facial controls and lip-sync still require separate implementation.

For the existing **portrait HTTP service**, an accessible Linux cloud server is
required. Provision a modern NVIDIA GPU server
with at least 8 GB VRAM and enough storage for dependencies/models (allow 15 GB).
That earlier portrait sizing is not a VACE/Wan2.2 memory or disk guarantee.
Cloud hardware is not supplied by this repository; rental may cost money.
Do not build or render this container on the affected desktop.

## Independent Nexus Render Engine

The target stack is **VACE + Wan2.2 + FasterLivePortrait + MuseTalk**, controlled
by our own adapters rather than a commercial avatar API. This is a migration
direction, not a claim that all four are deployed:

| Engine | Actual integration |
| --- | --- |
| VACE 1.3B | Experimental masked edit of an existing video; not a tested pose-command/body generator |
| FasterLivePortrait | Existing cloud portrait adapter with JoyVASA and original LivePortrait PyTorch warper |
| MuseTalk 1.5 | Not installed/integrated; requires isolated setup and lip-sync review |
| Wan2.2 TI2V-5B | Not installed/integrated; deferred until an actual L4 memory test |
| FlashHead Pro | Preserve accepted face results; optional adapter, not silently replaced |
| LTX body | Existing experimental whole-character motion preview adapter, not a skeleton controller |

`nexus_render_engine.py` adds a persistent sequential batch controller. Prepare
distinct job folders using each existing adapter's documented input contract,
then place this file in their common parent as `render-plan.json`:

```json
{
  "version": 1,
  "jobs": [
    {"engine": "faster-liveportrait", "directory": "face"},
    {"engine": "vace-expression", "directory": "expression"}
  ]
}
```

Run `NEXUS_CLOUD_WORKER=1 python nexus_render_engine.py /data/new-batch`.
Only one batch can hold that root's exclusive `render.lock`; jobs run sequentially
in separate processes, releasing GPU model allocations when the process exits.
This is not a global lock across different batch roots or a permanent web service.
For isolated environments, set absolute interpreter paths in
`NEXUS_RENDER_PYTHON_FASTER_LIVEPORTRAIT`, `NEXUS_RENDER_PYTHON_FLASHHEAD`,
`NEXUS_RENDER_PYTHON_LTX_BODY`, `NEXUS_RENDER_PYTHON_VACE_EXPRESSION` or
`NEXUS_RENDER_PYTHON_SCENE_COMPOSER`. Model caches remain managed by each adapter.

The batch writes atomic `render-state.json` checkpoints and per-job
`nexus-render.log`. Failure/timeout stops the remaining jobs and propagates the
error. Existing outputs and batch histories are preserved. Retry in a **new**
batch/job directory after inspecting logs; no automatic OOM retry, resolution
downgrade or renderer substitution is performed. A crash can leave a lock:
inspect its PID and history before manually removing that exact stale lock.
Each output is checked with FFprobe for decodable frames and hashed.
Status `rendered` deliberately does not mean visually approved, correctly
articulated hands or verified speech alignment.
The controller passed a real Linux/FFmpeg integration with two queued scene
jobs, rendered videos, copied audio and FFprobe/hash validation. The targeted
cloud suite passed all 24 tests; the desktop suite passed 83 tests with two
Linux/FFmpeg-only integrations skipped. Scene timeline validation counts actual
decoded frames rather than container estimates that can include audio padding.

These are **independent prepared jobs**, not an automatic Body -> Face -> Lips
composition. In particular, never paste the standalone portrait output onto the
body as a claimed coherent result. For expression jobs, `sourceClip` must be
the reviewed body master and masks must share its timeline. The existing scene
composer still requires a reviewed temporal matte. Identity packs remain
`reference_pack.py`'s `character.json`; no unseen angles or 3D geometry are inferred.
Joint-plan translation, persistent pose state, tracked FaceLock, MuseTalk
composition, automatic masks and automatic quality/OOM policy remain unimplemented.

Verified upstream sources:

- [Official VACE](https://github.com/ali-vilab/VACE): native reference/video/masked
  conditioning, not guaranteed hand anatomy.
- [Official Wan2.2](https://github.com/Wan-Video/Wan2.2): TI2V-5B 720p/24 FPS;
  its single-GPU example uses 1280x704 (or portrait 704x1280) and claims at least
  24 GB VRAM with offload/dtype/T5 CPU options. These are hardware-sensitive.
  The current L4 reports
  23,034 MiB, not proof of a successful 5B inference or real-time throughput.
- [FasterLivePortrait](https://github.com/warmshao/FasterLivePortrait): 30+ FPS
  TensorRT benchmark on RTX 3090, not a measured result on this L4. Existing
  adapter uses the documented PyTorch warper workaround, not that benchmark path.
- [Official MuseTalk](https://github.com/TMElyralab/MuseTalk): version 1.5,
  localized 256x256 face processing; 30+ FPS claim on Tesla V100 is not an L4
  deployment measurement. Upstream declares MIT code and trained-model use
  for any purpose, while dependent models retain their own terms and supplied
  test data is non-commercial research only. Review **all dependent model**
  licenses before deployment.
- [Official Kokoro weights](https://huggingface.co/hexgrad/Kokoro-82M) and
  [voice list](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md):
  Apache-licensed weights, but Polish is not a declared supported voice language.
  Do not replace Polish speech with another language or claim native Polish TTS.
- Later optional modules: [official SAM2](https://github.com/facebookresearch/sam2)
  and [official Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN), neither
  installed by this controller.

## Cloud-server setup

Copy this directory to the server. Build with `docker build -t nexus-avatar .`
on that server. Docker/NVIDIA Container Toolkit must already be installed.

Mount a persistent model directory at `/opt/FasterLivePortrait/checkpoints` and
job directory at `/data/jobs`. First run `python3 download_models.py` inside the image
with the model mount. This downloads only the relevant ONNX, JoyVASA and HuBERT models.
Upstream code and motion/audio/warping checkpoint revisions are pinned. Stock
ONNX Runtime does not support the renderer's 5D GridSample; the original PyTorch
warper/decoder runs that stage on the cloud GPU instead. HuBERT's old weight-norm
keys are converted to PyTorch's current names to avoid randomly initialized weights.
Retain upstream
licenses and review model-use terms, including face detection model restrictions,
before commercial deployment.

Then start the container using `--gpus all`, those mounts and a cryptographically
random `NEXUS_AVATAR_SERVER_TOKEN` (at least 32 characters). Inject this secret via
your deployment secret manager, not an image or committed file.
Expose port 8000 only behind an HTTPS reverse proxy; allow access only from your Hub
where possible. Configure proxy body limit >=8 MB and request timeout >=60 seconds.
Models initialize inside the remote render subprocess, not in the HTTP frontend.
One render runs at a time; two more can queue. Render timeout is 30 minutes.

Jobs are ephemeral, expire one hour after submission once complete/failed, and are
cleaned when the server receives another job/status request. Restarting the worker
loses job records. Remove orphaned job directories during controlled server maintenance.
Do not scale this in-memory worker to multiple replicas behind an unpinned load balancer.

## Connect the desktop Hub

Set `NEXUS_AVATAR_SERVER_URL=https://your-avatar-server.example/` and the matching
`NEXUS_AVATAR_SERVER_TOKEN` in the Hub environment, then restart the Hub.
This is **your own server password**, not a HeyGen API key.

Select the portrait and click **Animuj odpowiedz — silnik Nexusa**. Only that click
sends portrait and text to your server. The Hub polls status and proxies video,
keeping the server token out of browser storage.

## Verification status and acceptance

Protocol/unit tests can run on the desktop without importing AI libraries:
`python -m unittest discover -s avatar-cloud -p "test_*.py"` and
`node --experimental-strip-types --test helpers/remoteAvatar.test.ts`.

The container has **not** been built, but the batch renderer has generated a verified
short clip in Colab. The HTTP deployment is a candidate, not a live hosted service.
On the server, verify authenticated `/health`, submit a short Polish sentence plus
the intended portrait, wait for `complete`, and inspect the MP4 for visible face
motion, intact full portrait, speech, lip timing and correct duration.
Check server logs if face detection fails or CUDA/ONNX providers are incompatible.
Do not substitute a black/static video or report success for missing output.

The HTTP face renderer does not generate full-body poses or hand gestures.
The optional notebook body mode is generative image-to-video, not a controllable
3D skeleton. Photorealistic voice and real-time streaming are not implemented.
Neither mode is guaranteed to match HeyGen's quality.
