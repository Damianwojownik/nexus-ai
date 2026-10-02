import React, { useEffect, useRef, useState } from 'react';
import { Mic, Play, Sparkles, Code2, Brain, Send, Volume2, MessageCircle, ListChecks, Wrench, FolderKanban, Plus } from 'lucide-react';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import styles from './_index.module.css';
import { OllamaClient } from '../helpers/ollamaClient';
import { OllamaProvider, ModelRouter } from '../helpers/modelRouter';
import { NexusAgent } from '../helpers/nexusAgent';
import { NexusOrchestrator } from '../helpers/nexusOrchestrator';
import type { NexusApprovalRequest, NexusWorkflowProgress, NexusWorkflowState } from '../helpers/nexusOrchestrator';
import { MemoryStore } from '../helpers/memoryStore';
import { ToolRegistry, registerDefaultTools } from '../helpers/toolRegistry';
import { VoiceEventBus } from '../helpers/voiceEventBus';
import { PrimaryAgentProvider } from '../helpers/primaryAgentProvider';
import { AgentHubClient, AgentHubClientError } from '../helpers/agentHubClient';
import type { AgentHubConnectionStatus } from '../helpers/agentHubClient';
import type { AgentEvent } from '../helpers/agentProtocol';
import { LocalCapabilitiesClient } from '../helpers/localCapabilitiesClient';
import { avatarMotionCssVars, createAvatarMotionFrame } from '../helpers/avatarMotion';
import { estimateVisemePlan, mouthShapeForViseme, sampleVisemeAt } from '../helpers/visemeEngine';
import type { VisemeCue } from '../helpers/visemeEngine';
import type { VoiceEventType } from '../helpers/agentProtocol';

const ollamaClient = new OllamaClient();
const memoryStore = new MemoryStore();
const toolRegistry = new ToolRegistry();
registerDefaultTools(toolRegistry);
const ollamaProvider = new OllamaProvider(ollamaClient);
const primaryProvider = new PrimaryAgentProvider({ id: 'chatgpt-primary', name: 'chatgpt-primary' });
const modelRouter = new ModelRouter('AUTO', [ollamaProvider]);
const nexusAgent = new NexusAgent(modelRouter, memoryStore, toolRegistry, {
  systemPrompt: 'You are Nexus, a local-first AI assistant for product work, coding, analysis and agentic task planning.',
});
const voiceEventBus = new VoiceEventBus();
const agentHubClient = new AgentHubClient();
const localCapabilitiesClient = new LocalCapabilitiesClient(agentHubClient.baseUrl);
const nexusOrchestrator = new NexusOrchestrator(nexusAgent, agentHubClient, memoryStore, localCapabilitiesClient);

export default function Home() {
  const avatars=[{name:'Kosmiczny',src:'/_cdn/static/8c1cadbc-855e-4488-a72b-e88cb715d899.png'},{name:'Luna',src:'/_cdn/static/cc2dde88-daa2-48c9-acc8-1ea16f85990d.png'},{name:'Kai',src:'/_cdn/static/6a74b8c4-e09a-4776-a01a-156edac8441f.png'},{name:'Nova',src:'/_cdn/static/364da496-a271-4b0c-b40e-e23f14fad3a2.png'},{name:'Orbit',src:'/_cdn/static/17f6bda3-9fc8-4e2d-9b46-fec5fc2d91d4.png'},{name:'Void',src:'/_cdn/static/2405769f-a406-4390-9af2-8b74c0fda46c.png'}];
  const [avatar,setAvatar]=useState(0);
  const [prompt,setPrompt]=useState('');
  const [status,setStatus]=useState('Gotowa do rozmowy');
  const [listening,setListening]=useState(false);
  const [speaking,setSpeaking]=useState(false);
  const [selectedModel,setSelectedModel]=useState<string>(ollamaClient.defaultModel);
  const [ollamaStatus,setOllamaStatus]=useState<'CONNECTED'|'OFFLINE'|'NO_MODEL'|'ERROR'>('OFFLINE');
  const [primaryStatus,setPrimaryStatus]=useState<'CONNECTED'|'DISCONNECTED'|'NOT_CONFIGURED'|'ERROR'>('NOT_CONFIGURED');
  const [memoryReady,setMemoryReady]=useState(false);
  const [hubStatus,setHubStatus]=useState<AgentHubConnectionStatus>('DISCONNECTED');
  const [hubAgents,setHubAgents]=useState<Array<Awaited<ReturnType<AgentHubClient['getAgents']>>[number]>>([]);
  const [hubTasks,setHubTasks]=useState<Array<Awaited<ReturnType<AgentHubClient['getTasks']>>[number]>>([]);
  const [hubEvents,setHubEvents]=useState<AgentEvent[]>([]);
  const [hubError,setHubError]=useState('');
  const [workflowProgress,setWorkflowProgress]=useState<NexusWorkflowProgress|null>(null);
  const [approvalRequest,setApprovalRequest]=useState<NexusApprovalRequest|null>(null);
  const [approvalBusy,setApprovalBusy]=useState(false);
  const [attachments,setAttachments]=useState<File[]>([]);
  const [response,setResponse]=useState('');
  const [isThinking,setIsThinking]=useState(false);
  const [conversationHistory,setConversationHistory]=useState<Array<{role:'user'|'assistant';content:string}>>([]);
  const [lastSources,setLastSources]=useState<Array<{title:string;url:string;snippet:string}>>([]);
  const recognitionRef=useRef<any>(null);
  const attachmentInputRef=useRef<HTMLInputElement|null>(null);
  const hubSseConnectedRef=useRef(false);
  const avatarRef=useRef<HTMLDivElement | null>(null);
  const motionStateRef=useRef<VoiceEventType>('IDLE');
  const speechStartedAtRef=useRef(0);
  const speechBoundaryRef=useRef({at:0,intensity:0});
  const speechVisemePlanRef=useRef<VisemeCue[]>([]);
  const pointerRef=useRef({x:0,y:0});

  useEffect(()=>{
    const saved=localStorage.getItem('nexus-avatar');
    if(saved){const i=avatars.findIndex(a=>a.name===saved);if(i>=0)setAvatar(i)};

    void (async () => {
      const available = await ollamaClient.listModels();
      if (available.length > 0) {
        setSelectedModel(available[0].name);
      }

      const health = await ollamaClient.checkHealth(selectedModel || ollamaClient.defaultModel);
      setOllamaStatus(health.status);
      if (health.status === 'CONNECTED' && health.model) {
        setSelectedModel(health.model);
        setStatus(`Ollama — połączono (${health.model})`);
      }

      const primaryHealth = await primaryProvider.health();
      setPrimaryStatus(primaryHealth.status);
      setMemoryReady(true);
    })();
  }, []);

  useEffect(() => {
    let disposed = false;
    let registered = false;

    const refresh = async () => {
      try {
        const [agents, tasks] = await Promise.all([agentHubClient.getAgents(), agentHubClient.getTasks()]);
        if (!disposed) {
          setHubAgents(agents);
          setHubTasks(tasks);
          setHubError('');
        }
      } catch (error) {
        if (!disposed) {
          setHubError(error instanceof Error ? error.message : 'Agent Hub request failed');
          if (error instanceof AgentHubClientError && error.statusCode) setHubStatus('ERROR');
        }
      }
    };

    const registerNexusUi = async () => {
      try {
        await agentHubClient.registerAgent({
          agentId: 'nexus-ui',
          kind: 'orchestrator',
          capabilities: ['conversation', 'task-submit', 'task-claim', 'task-lease'],
        });
        await agentHubClient.heartbeat('nexus-ui');
        await refresh();
      } catch (error) {
        registered = false;
        if (!disposed) {
          setHubError(error instanceof Error ? error.message : 'Nexus UI registration failed');
          setHubStatus(error instanceof AgentHubClientError && error.statusCode ? 'ERROR' : 'DISCONNECTED');
        }
      }
    };

    const stopEvents = agentHubClient.subscribeEvents((event) => {
      if (disposed) return;
      if (event.message !== 'Heartbeat') setHubEvents((current) => [event, ...current].slice(0, 8));
      void refresh();
    }, (status) => {
      if (disposed) return;
      hubSseConnectedRef.current = status === 'CONNECTED';
      setHubStatus(status);
      if (status === 'CONNECTED') {
        if (!registered) {
          registered = true;
          void registerNexusUi();
        }
      } else {
        registered = false;
      }
    });

    const heartbeatTimer = window.setInterval(() => {
      if (!registered || disposed) return;
      void agentHubClient.heartbeat('nexus-ui').catch((error) => {
        registered = false;
        if (!disposed) {
          setHubError(error instanceof Error ? error.message : 'Agent Hub heartbeat failed');
          setHubStatus(error instanceof AgentHubClientError && error.statusCode ? 'ERROR' : 'DISCONNECTED');
        }
      });
    }, 15000);

    return () => {
      disposed = true;
      registered = false;
      hubSseConnectedRef.current = false;
      window.clearInterval(heartbeatTimer);
      stopEvents();
    };
  }, []);

  useEffect(() => {
    if (!approvalRequest || approvalRequest.kind !== 'INSTALLER_SETUP') return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void nexusOrchestrator.refreshApproval(approvalRequest.taskId).then((approval) => {
        if (!disposed && approval?.kind === 'INSTALL_APP') setApprovalRequest(approval);
      }).catch(() => undefined);
    }, 4000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [approvalRequest?.taskId, approvalRequest?.kind]);

  const publishWorkflowProgress = (progress: NexusWorkflowProgress) => {
    setWorkflowProgress(progress);
    setStatus(progress.message);
    const eventType: VoiceEventType = progress.state === 'SEARCHING'
      ? 'THINKING'
      : progress.state === 'TESTING' || progress.state === 'WORKING'
        ? 'EXECUTING'
        : progress.state === 'DONE' ? 'IDLE' : progress.state;
    voiceEventBus.emit(eventType, 'nexus', progress.message, progress.taskId, { source: 'orchestrator' });
  };

  const runNexusConversation = async () => {
    const messageText = prompt.trim() || (attachments.length ? 'Przeanalizuj załączone pliki i zdjęcia.' : '');
    if (!messageText) return;
    setIsThinking(true);
    setApprovalRequest(null);
    setResponse('');
    const nextHistory = [...conversationHistory, { role: 'user' as const, content: messageText }].slice(-12);
    try {
      const result = await nexusOrchestrator.start({
        text: messageText,
        history: conversationHistory.slice(-10),
        projectContext: 'Nexus local-first workspace. Route through available local capabilities; do not claim unavailable access.',
        attachments,
      }, publishWorkflowProgress);
      setResponse(result.text);
      setLastSources(result.searchResults);
      setConversationHistory(result.status === 'DONE'
        ? [...nextHistory, { role: 'assistant' as const, content: result.text }].slice(-12)
        : nextHistory);
      setPrompt('');
      setAttachments([]);
      if (result.status === 'WAITING_FOR_APPROVAL') setApprovalRequest(result.approval);
      else if (result.text.trim()) speak(result.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nexus nie mógł wykonać zadania';
      setResponse(message);
      setStatus('Wystąpił błąd');
      voiceEventBus.emit('ERROR', 'nexus', message, workflowProgress?.taskId, { source: 'orchestrator' });
    } finally {
      setIsThinking(false);
    }
  };

  const approveNexusRequest = async () => {
    if (!approvalRequest) return;
    setApprovalBusy(true);
    try {
      const result = await nexusOrchestrator.approve(approvalRequest.taskId, publishWorkflowProgress);
      setResponse(result.text);
      if (result.status === 'WAITING_FOR_APPROVAL') {
        setApprovalRequest(result.approval);
      } else {
        setApprovalRequest(null);
        setConversationHistory((history) => [...history, { role: 'assistant' as const, content: result.text }].slice(-12));
        if (result.text.trim()) speak(result.text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Zatwierdzona operacja nie powiodła się';
      setResponse(message);
      setStatus('Wystąpił błąd');
      voiceEventBus.emit('ERROR', 'nexus', message, approvalRequest.taskId, { source: 'orchestrator' });
    } finally {
      setApprovalBusy(false);
    }
  };

  const cancelNexusRequest = async () => {
    if (!approvalRequest) return;
    await nexusOrchestrator.cancel(approvalRequest.taskId);
    setApprovalRequest(null);
    setResponse('Anulowałem tę operację.');
    setStatus('Gotowe');
    setConversationHistory((history) => [...history, { role: 'assistant' as const, content: 'Anulowałem tę operację.' }].slice(-12));
  };

  const addAttachments = (files: FileList|null) => {
    if (!files?.length) return;
    setAttachments((current) => [...current, ...Array.from(files)].slice(0, 8));
  };

  useEffect(() => {
    const unsubscribe = voiceEventBus.subscribe((event) => {
      motionStateRef.current = event.type as VoiceEventType;
      if (event.type === 'SPEAKING') speechStartedAtRef.current = performance.now();
    });

    let frameId = 0;
    const animate = (nowMs: number) => {
      const state = motionStateRef.current;
      const speakingNow = state === 'SPEAKING';
      const speechPhase = Math.max(0, nowMs - speechStartedAtRef.current) / 1000;
      const boundaryAge = Math.max(0, nowMs - speechBoundaryRef.current.at);
      const boundaryPulse = boundaryAge < 180 ? speechBoundaryRef.current.intensity * (1 - boundaryAge / 180) : 0;
      const speechEnergy = speakingNow
        ? Math.min(1, 0.18 + boundaryPulse + 0.22 * Math.abs(Math.sin(speechPhase * 9.7)) + 0.12 * Math.abs(Math.sin(speechPhase * 5.3 + 0.7)))
        : 0;
      const visemeCue = speakingNow
        ? sampleVisemeAt(speechVisemePlanRef.current, Math.max(0, nowMs - speechStartedAtRef.current))
        : undefined;
      const mouthShape = visemeCue ? mouthShapeForViseme(visemeCue.viseme) : undefined;
      const frame = createAvatarMotionFrame({
        state,
        nowMs,
        speechEnergy,
        visemeOpen: mouthShape ? mouthShape.open * visemeCue!.intensity : undefined,
      });
      frame.gazeX += pointerRef.current.x * 2.2;
      frame.gazeY += pointerRef.current.y * 1.4;
      const node = avatarRef.current;
      if (node) {
        const vars = avatarMotionCssVars(frame);
        Object.entries(vars).forEach(([name, value]) => node.style.setProperty(name, value));
        node.style.setProperty('--nexus-mouth-wide', (mouthShape?.wide ?? 0.15).toFixed(3));
        node.style.setProperty('--nexus-mouth-round', (mouthShape?.round ?? 0.05).toFixed(3));
        node.style.setProperty('--nexus-mouth-press', (mouthShape?.press ?? 0.1).toFixed(3));
        node.style.transform = `perspective(900px) rotateX(${frame.headY.toFixed(2)}deg) rotateY(${frame.headX.toFixed(2)}deg) translateY(${(frame.breath * 1.5).toFixed(2)}px) scale(${(1 + frame.breath * 0.003).toFixed(4)})`;
        node.style.transformOrigin = '50% 58%';
        node.style.willChange = 'transform';
        node.dataset.motionState = state.toLowerCase();
        node.dataset.expression = frame.expression;
      }
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => { unsubscribe(); cancelAnimationFrame(frameId); };
  }, []);

  const emitVoiceEvent = (type: VoiceEventType, message: string) => {
    voiceEventBus.emit(type, 'nexus', message, undefined, { source: 'ui' });
  };

  const chooseAvatar=(i:number)=>{setAvatar(i);localStorage.setItem('nexus-avatar',avatars[i].name)};
  const trackPointer=(e:React.PointerEvent<HTMLDivElement>)=>{const r=e.currentTarget.getBoundingClientRect();pointerRef.current={x:Math.max(-1,Math.min(1,(e.clientX-(r.left+r.width/2))/(r.width/2))),y:Math.max(-1,Math.min(1,(e.clientY-(r.top+r.height/2))/(r.height/2)))};};
  const resetPointer=()=>{pointerRef.current={x:0,y:0};};
  const speak=(text:string)=>{
    if(!('speechSynthesis' in window)) return;
    emitVoiceEvent('SPEAKING', 'Nexus mówi…');
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    u.lang='pl-PL'; u.rate=.96;
    speechVisemePlanRef.current=estimateVisemePlan(text,{charactersPerSecond:14/u.rate});
    u.onstart=()=>{speechStartedAtRef.current=performance.now();setSpeaking(true);setStatus('Nexus mówi…')};
    u.onboundary=(event:any)=>{const span=Math.max(1,event.charLength||1);speechBoundaryRef.current={at:performance.now(),intensity:Math.min(1,.42+span*.035)};};
    u.onend=()=>{setSpeaking(false); emitVoiceEvent('IDLE', 'Nexus ready'); setStatus('Gotowy do rozmowy')};
    window.speechSynthesis.speak(u);
  };
  const startVoice=()=>{
    const w:any=window, SR=w.SpeechRecognition||w.webkitSpeechRecognition;
    if(!SR){emitVoiceEvent('ERROR','Rozpoznawanie mowy nie jest dostępne w tej przeglądarce');setStatus('Rozpoznawanie mowy nie jest dostępne w tej przeglądarce');return;}
    if(listening){recognitionRef.current?.stop(); emitVoiceEvent('INTERRUPTED','Voice input stopped');return;}
    emitVoiceEvent('LISTENING','Nexus słucha…');
    window.speechSynthesis?.cancel();
    const r=new SR(); recognitionRef.current=r;
    r.lang='pl-PL'; r.continuous=false; r.interimResults=true;
    r.onstart=()=>{setListening(true);setStatus('Nexus słucha…')};
    r.onresult=(e:any)=>{let t=''; for(let i=0;i<e.results.length;i++) t+=e.results[i][0].transcript; setPrompt(t); if(e.results[e.results.length-1].isFinal){setStatus('Rozpoznano mowę');}};
    r.onerror=(e:any)=>{emitVoiceEvent('ERROR', e.error==='not-allowed'?'Zezwól Nexusowi na dostęp do mikrofonu':'Błąd mikrofonu — spróbuj ponownie'); setStatus(e.error==='not-allowed'?'Zezwól Nexusowi na dostęp do mikrofonu':'Błąd mikrofonu — spróbuj ponownie');};
    r.onend=()=>{setListening(false); emitVoiceEvent('IDLE','Voice input ended');}; r.start();
  };
  const run = runNexusConversation;
  return <main className={styles.shell}>
    <section className={styles.main}><header><div className={styles.brand}><div className={styles.mark}>N</div><div><b>NEXUS</b><span>ASYSTENT</span></div></div><div className={styles.model}><span className={styles.dot}/> {status}</div></header>
      <div className={styles.stage}><div className={styles.avatarWrap}><div className={styles.orbit}/><div className={styles.particles}><i/><i/><i/><i/><i/><i/></div>
        <div ref={avatarRef} onPointerMove={trackPointer} onPointerLeave={resetPointer} className={styles.avatar+' '+(speaking?styles.speaking:'')+' '+(listening?styles.listening:'')}><div className={styles.scan}/><img key={avatars[avatar].src} className={styles.person} src={avatars[avatar].src} alt={'Nexus — '+avatars[avatar].name} onError={event=>{event.currentTarget.style.display='none'}}/><div className={styles.faceRig} aria-hidden="true"><span className={styles.eye+' '+styles.eyeLeft}><i/></span><span className={styles.eye+' '+styles.eyeRight}><i/></span><span className={styles.mouthRig}/></div><div className={styles.wave}><i/><i/><i/><i/><i/></div></div></div>
        <div className={styles.speech}><Sparkles size={16}/> Cześć. Powiedz mi, co mam dla Ciebie zbudować.</div>
        {response&&<div className={styles.response} role="status" aria-live="polite">{response}</div>}
        <div className={styles.status}>{status}</div>
        <input ref={attachmentInputRef} type="file" multiple hidden accept="image/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.xlsx,.pptx" onChange={event=>{addAttachments(event.target.files);event.currentTarget.value=''}}/>
        {attachments.length>0&&<div className={styles.attachmentList}>{attachments.map((file,index)=><span key={`${file.name}-${index}`} className={styles.attachmentChip}>{file.name}<button type="button" aria-label={`Usuń ${file.name}`} onClick={()=>setAttachments(current=>current.filter((_,itemIndex)=>itemIndex!==index))}>×</button></span>)}</div>}
        <div className={styles.composer}><Button variant="secondary" onClick={()=>attachmentInputRef.current?.click()} aria-label="Dodaj załączniki"><Plus size={18}/> Dodaj</Button><Input value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&run()} placeholder="Powiedz Nexusowi, co chcesz osiągnąć…"/><Button onClick={run} disabled={isThinking||(!prompt.trim()&&!attachments.length)} aria-label="Wyślij"><Send size={18}/></Button></div>
        {approvalRequest&&<section className={styles.approvalCard} role="alertdialog" aria-labelledby="approval-title"><h3 id="approval-title">Potrzebuję Twojej zgody</h3><p>{approvalRequest.message}</p><div><Button variant="secondary" disabled={approvalBusy} onClick={()=>void cancelNexusRequest()}>Anuluj</Button><Button disabled={approvalBusy} onClick={()=>void approveNexusRequest()}>{approvalBusy?'Wykonuję…':approvalRequest.kind==='INSTALLER_SETUP'?'Otwórz Microsoft Store':'Zainstaluj '+approvalRequest.app.name}</Button></div></section>}
        <div className={styles.voiceRow}><Button variant="secondary" onClick={startVoice}><Mic size={18}/> {listening?'Zatrzymaj':'Rozmawiaj'}</Button></div>
      </div>
      <details className={styles.nexusDetails}>
        <summary>Co robi Nexus</summary>
        <div className={styles.workflowSummary}>
          <p>{workflowProgress?.message??'Brak aktywnego zadania.'}</p>
          {workflowProgress&&<ol>{workflowProgress.plan.map(step=><li key={step.id} data-step-state={step.state}>{step.label} · {step.state}</li>)}</ol>}
          {lastSources.length>0&&<div className={styles.workflowSources}><b>Źródła sprawdzone przez Nexusa</b>{lastSources.map(source=><a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} · {new URL(source.url).hostname}</a>)}</div>}
        </div>
        <div className={styles.diagnosticsContent} inert={true}>
          <section className={styles.settingsPanel}>
            <h3>NEXUS</h3>
            <div className={styles.settingsRow}><span>Primary Agent</span><strong>{primaryStatus}</strong></div>
            <div className={styles.settingsRow}><span>Local AI</span><strong>Ollama · {selectedModel} · {ollamaStatus}</strong></div>
            <div className={styles.settingsRow}><span>Memory</span><strong>{memoryReady?'ready':'loading'}</strong></div>
            <div className={styles.settingsRow}><span>Hub</span><strong>{hubStatus} · {hubAgents.filter(agent=>agent.presence!=='offline').length} online</strong></div>
          </section>
          <section className={styles.diagnosticLists}>
            <div><h4>Agenci</h4>{hubAgents.map(agent=><p key={agent.agentId}>{agent.agentId} · {agent.presence} · {agent.kind}</p>)}</div>
            <div><h4>Zadania</h4>{hubTasks.map(task=><p key={task.id}>{task.status} · {task.goal}</p>)}</div>
            <div><h4>Zdarzenia</h4>{hubEvents.slice(0,6).map(event=><p key={event.id}>{event.type} · {event.agentId}: {event.message}</p>)}</div>
          </section>
          {hubError&&<p role="alert" className={styles.capabilityError}>{hubError}</p>}
        </div>
      </details>
    </section>
  </main>
}
