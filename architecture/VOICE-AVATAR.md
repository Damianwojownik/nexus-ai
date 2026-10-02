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

FasterLivePortrait is an optional local ONNX renderer for generating a video from a source image and driving audio/video. The verified upstream WebUI is batch-oriented; it does not expose continuous real-time camera streaming. Nexus must not present this renderer as true real-time lip sync until a streaming interface is implemented and measured. The existing CSS/viseme avatar remains the responsive conversation fallback; amplitude-only mouth motion is not true lip sync.

Voice identity and avatar identity are settings owned by Nexus, so changing an underlying model does not change the user's Nexus persona.
