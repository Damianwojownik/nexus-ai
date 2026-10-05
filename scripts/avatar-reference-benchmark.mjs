import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function finiteNumber(value, label) {
  if (value === undefined || value === null || value === '') throw new Error(`Missing ${label}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}`);
  return number;
}

export function summarizeVideoTiming(probe, frames) {
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  if (!video || !audio) throw new Error('Reference needs both video and audio streams');
  const durationSeconds = finiteNumber(probe.format?.duration, 'container duration');
  const width = finiteNumber(video.width, 'video width');
  const height = finiteNumber(video.height, 'video height');
  if (durationSeconds <= 0 || width <= 0 || height <= 0) throw new Error('Reference dimensions and duration must be positive');
  const videoStartMs = finiteNumber(video.start_time, 'video start time') * 1000;
  const audioStartMs = finiteNumber(audio.start_time, 'audio start time') * 1000;
  if (!Array.isArray(frames) || frames.length < 2) throw new Error('At least two decoded frame timestamps are required');
  const times = frames.map(frame => finiteNumber(frame.best_effort_timestamp_time, 'frame timestamp') * 1000);
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  const positive = intervals.filter(interval => interval > 0).sort((left, right) => left - right);
  if (!positive.length) throw new Error('No increasing frame timestamps');
  const percentile = fraction => positive[Math.min(positive.length - 1, Math.floor((positive.length - 1) * fraction))];
  return {
    durationSeconds,
    width,
    height,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    audioStartOffsetMs: audioStartMs - videoStartMs,
    frameCount: times.length,
    frameTiming: {
      medianIntervalMs: percentile(0.5),
      p95IntervalMs: percentile(0.95),
      maxIntervalMs: positive[positive.length - 1],
      duplicateTimestamps: intervals.filter(interval => interval === 0).length,
      backwardTimestamps: intervals.filter(interval => interval < 0).length,
    },
    limitations: [
      'Container timestamp offsets are not phoneme-to-mouth synchronization measurements.',
      'Frame intervals describe the recording, not motion smoothness or renderer latency.',
      'Identity drift, articulation and perceived quality require separate measured visual/audio evaluation.',
    ],
  };
}

function probeJson(file, args) {
  const result = spawnSync('ffprobe', ['-v', 'error', ...args, '-of', 'json', file], {
    encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffprobe failed (${result.status}): ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

export function benchmarkReference(file) {
  const metadata = probeJson(file, [
    '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,start_time',
  ]);
  const timestamps = probeJson(file, [
    '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time',
  ]);
  return summarizeVideoTiming(metadata, timestamps.frames);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 3) {
    console.error('Usage: node scripts\\avatar-reference-benchmark.mjs <reference.mp4> [other-reference.mp4]');
    process.exitCode = 1;
  } else {
    for (const file of process.argv.slice(2)) {
      console.log(JSON.stringify({ file, ...benchmarkReference(file) }, null, 2));
    }
  }
}
