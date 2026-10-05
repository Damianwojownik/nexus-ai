import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVideoTiming } from './avatar-reference-benchmark.mjs';

const metadata = () => ({
  format: { duration: '419.682959' },
  streams: [
    { codec_type: 'audio', codec_name: 'aac', start_time: '0.082292' },
    { codec_type: 'video', codec_name: 'h264', width: 1078, height: 1792, start_time: '0' },
  ],
});

test('reference report separates timestamp evidence from visual quality claims', () => {
  const report = summarizeVideoTiming(metadata(), [0, 0.02, 0.04, 0.04, 0.03, 0.10].map(time => ({ best_effort_timestamp_time: String(time) })));
  assert.equal(report.audioStartOffsetMs, 82.292);
  assert.equal(report.frameCount, 6);
  assert.equal(report.frameTiming.duplicateTimestamps, 1);
  assert.equal(report.frameTiming.backwardTimestamps, 1);
  assert.ok(report.frameTiming.maxIntervalMs > 60);
  assert.equal(report.limitations.length, 3);
});

test('missing evidence and invalid timelines fail rather than becoming zero-offset success', () => {
  const frames = [{ best_effort_timestamp_time: '0' }, { best_effort_timestamp_time: '0.02' }];
  const noAudio = metadata();
  noAudio.streams.shift();
  assert.throws(() => summarizeVideoTiming(noAudio, frames), /both video and audio/);
  const noStart = metadata();
  delete noStart.streams[0].start_time;
  assert.throws(() => summarizeVideoTiming(noStart, frames), /Missing audio start/);
  assert.throws(() => summarizeVideoTiming(metadata(), []), /two decoded/);
  assert.throws(() => summarizeVideoTiming(metadata(), [{ best_effort_timestamp_time: 'NaN' }, frames[1]]), /Invalid frame/);
});
