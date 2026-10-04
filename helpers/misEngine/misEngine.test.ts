import assert from 'node:assert/strict';
import test from 'node:test';

import { articulationAt, articulationTarget } from './articulationEngine.ts';
import { classifyHaptic } from './hapticsEngine.ts';
import { IdentityLock } from './identityLock.ts';
import { buildEstimatedPhonemeTimeline } from './phonemeEngine.ts';
import { selectMisRenderer } from './rendererRegistry.ts';
import { composeMisFrame } from './runtime.ts';
import { validateTimeline } from './benchmark.ts';
import { MisRenderCoordinator } from './renderCoordinator.ts';
import { normaliseAlignedPhone } from './phoneNormalization.ts';

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


test('runtime samples articulation motion and haptics from one clock', () => {
  const timeline=[
    {phoneme:'m',startMs:0,endMs:100,confidence:1,source:'aligned-audio' as const},
    {phoneme:'a',startMs:100,endMs:250,confidence:1,source:'aligned-audio' as const},
  ];
  const frame=composeMisFrame(timeline,'pl',125,'SPEAKING');
  assert.equal(frame.phoneme.phoneme,'a');
  assert.ok(frame.articulation.jawOpen>.7);
  assert.equal(frame.motion.state,'SPEAKING');
  assert.equal(frame.haptic.kind,'vowel');
});

test('timeline validator accepts ordered aligned phones', () => {
  const timeline=[
    {phoneme:'p',startMs:0,endMs:80,confidence:.9,source:'aligned-audio' as const},
    {phoneme:'a',startMs:80,endMs:220,confidence:.95,source:'aligned-audio' as const},
  ];
  assert.deepEqual(validateTimeline(timeline),[]);
});


test('quality render uses Codex media engine when configured', async () => {
  const live={
    configured:()=>true,
    render:async()=>({contentType:'video/mp4',data:Buffer.from('live')}),
  };
  const quality={
    configured:()=>true,
    render:async()=>({contentType:'video/mp4',data:Buffer.from('quality'),engine:'flp+ltx+composite'}),
  };
  const coordinator=new MisRenderCoordinator(live,quality);
  const result=await coordinator.render('quality',{
    sourceImageBase64:Buffer.from('image').toString('base64'),
    audioBase64:Buffer.from('audio').toString('base64'),
  });
  assert.equal(result.renderer,'nexus-media-flp-ltx');
  assert.equal(result.fallbackUsed,false);
  assert.equal(result.data.toString(),'quality');
});

test('quality render falls back to animal FasterLivePortrait when media engine is unavailable', async () => {
  let receivedMode:string|undefined;
  const live={
    configured:()=>true,
    render:async(input:{subjectMode?:string})=>{
      receivedMode=input.subjectMode;
      return {contentType:'video/mp4',data:Buffer.from('live')};
    },
  };
  const quality={
    configured:()=>false,
    render:async()=>{ throw new Error('must not be called'); },
  };
  const coordinator=new MisRenderCoordinator(live,quality);
  const result=await coordinator.render('quality',{
    sourceImageBase64:Buffer.from('image').toString('base64'),
    audioBase64:Buffer.from('audio').toString('base64'),
  });
  assert.equal(result.renderer,'faster-liveportrait');
  assert.equal(result.fallbackUsed,true);
  assert.equal(receivedMode,'animal');
});


test('MFA phone variants normalize into Miś articulation inventory', () => {
  assert.equal(normaliseAlignedPhone('s̪'),'s');
  assert.equal(normaliseAlignedPhone('pʰ'),'p');
  assert.equal(normaliseAlignedPhone('ɡ'),'g');
  assert.equal(normaliseAlignedPhone('aw'),'aʊ');
  assert.equal(normaliseAlignedPhone('sp'),'sil');
});
