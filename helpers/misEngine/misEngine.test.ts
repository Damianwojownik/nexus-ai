import assert from 'node:assert/strict';
import test from 'node:test';

import { articulationAt, articulationTarget } from './articulationEngine.ts';
import { classifyHaptic } from './hapticsEngine.ts';
import { IdentityLock } from './identityLock.ts';
import { buildEstimatedPhonemeTimeline } from './phonemeEngine.ts';
import { selectMisRenderer } from './rendererRegistry.ts';

test('Polish estimated timeline keeps MBP closure and vowel opening separate', () => {
  const timeline=buildEstimatedPhonemeTimeline('mama','pl');
  assert.equal(timeline[0].phoneme,'m');
  assert.equal(timeline[1].phoneme,'a');
  assert.equal(articulationTarget('m').lipPress,1);
  assert.ok(articulationTarget('a').jawOpen>.8);
});

test('English TH exposes tongue tip target', () => {
  const timeline=buildEstimatedPhonemeTimeline('thin','en');
  assert.equal(timeline[0].phoneme,'θ');
  assert.equal(articulationTarget('θ').tongueTip,1);
});

test('German Ü is rounded while tongue stays high/front', () => {
  const target=articulationTarget('y');
  assert.ok(target.lipRound>.9);
  assert.ok(target.tongueY>.8);
  assert.ok(target.tongueX<.4);
});

test('coarticulation anticipates next vowel before phone boundary', () => {
  const timeline=[
    {phoneme:'m',startMs:0,endMs:100,confidence:1,source:'aligned-audio' as const},
    {phoneme:'a',startMs:100,endMs:250,confidence:1,source:'aligned-audio' as const},
  ];
  const middle=articulationAt(timeline,50);
  const late=articulationAt(timeline,95);
  assert.ok(late.jawOpen>middle.jawOpen);
  assert.ok(late.lipPress<middle.lipPress);
});

test('haptic classes distinguish nasal, plosive and vowel', () => {
  assert.equal(classifyHaptic('m'),'nasal');
  assert.equal(classifyHaptic('p'),'plosive');
  assert.equal(classifyHaptic('a'),'vowel');
});

test('identity lock requires front and both three-quarter references', () => {
  const lock=new IdentityLock({
    id:'mis-master',
    label:'Miś master TEST',
    subject:'bear',
    version:1,
    references:[
      {id:'front',uri:'front.png',view:'front'},
      {id:'left',uri:'left.png',view:'three-quarter-left'},
      {id:'right',uri:'right.png',view:'three-quarter-right'},
    ],
  });
  assert.equal(lock.validate().ok,true);
  assert.equal(lock.validate().coverage,1);
});

test('live renderer defaults to self-hosted FasterLivePortrait', () => {
  assert.equal(selectMisRenderer('live').id,'faster-liveportrait');
});
