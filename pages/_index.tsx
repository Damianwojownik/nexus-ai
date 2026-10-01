import React, { useEffect, useRef, useState } from 'react';
import { Mic, Play, Sparkles, Code2, Brain, Send, Volume2, MessageCircle, ListChecks, Wrench, FolderKanban } from 'lucide-react';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import styles from './_index.module.css';
import { OllamaClient } from '../helpers/ollamaClient';
import { OllamaProvider, ModelRouter, AIModelMode } from '../helpers/modelRouter';
import { NexusAgent } from '../helpers/nexusAgent';
import { MemoryStore } from '../helpers/memoryStore';
import { ToolRegistry, registerDefaultTools } from '../helpers/toolRegistry';
import { VoiceEventBus } from '../helpers/voiceEventBus';
import { PrimaryAgentProvider } from '../helpers/primaryAgentProvider';
import { AgentHubClient, AgentHubClientError } from '../helpers/agentHubClient';
import type { AgentHubConnectionStatus } from '../helpers/agentHubClient';
import type { AgentEvent } from '../helpers/agentProtocol';
import { avatarMotionCssVars, createAvatarMotionFrame } from '../helpers/avatarMotion';
import type { VoiceEventType } from '../helpers/agentProtocol';

const ollamaClient = new OllamaClient();
const memoryStore = new MemoryStore();
const toolRegistry = new ToolRegistry();
registerDefaultTools(toolRegistry);
const ollamaProvider = new OllamaProvider(ollamaClient);
const primaryProvider = new PrimaryAgentProvider({ id: 'chatgpt-primary', name: 'chatgpt-primary' });
const modelRouter = new ModelRouter('AUTO', [ollamaProvider], ollamaProvider);
const nexusAgent = new NexusAgent(modelRouter, memoryStore, toolRegistry, {
  systemPrompt: 'You are Nexus, a local-first AI assistant for product work, coding, analysis and agentic task planning.',
});
const voiceEventBus = new VoiceEventBus();
const agentHubClient = new AgentHubClient();

export default function Home() {
  const avatars=[{name:'Kosmiczny',src:'/_cdn/static/8c1cadbc-855e-4488-a72b-e88cb715d899.png'},{name:'Luna',src:'/_cdn/static/cc2dde88-daa2-48c9-acc8-1ea16f85990d.png'},{name:'Kai',src:'/_cdn/static/6a74b8c4-e09a-4776-a01a-156edac8441f.png'},{name:'Nova',src:'/_cdn/static/364da496-a271-4b0c-b40e-e23f14fad3a2.png'},{name:'Orbit',src:'/_cdn/static/17f6bda3-9fc8-4e2d-9b46-fec5fc2d91d4.png'},{name:'Void',src:'/_cdn/static/2405769f-a406-4390-9af2-8b74c0fda46c.png'}];
  const [avatar,setAvatar]=useState(0);
  const [prompt,setPrompt]=useState('');
  const [status,setStatus]=useState('Gotowa do rozmowy');
  const [listening,setListening]=useState(false);
  const [speaking,setSpeaking]=useState(false);
  const [aiMode,setAiMode]=useState<AIModelMode>('AUTO');
  const [selectedModel,setSelectedModel]=useState<string>(ollamaClient.defaultModel);
  const [ollamaStatus,setOllamaStatus]=useState<'CONNECTED'|'OFFLINE'|'NO_MODEL'|'ERROR'>('OFFLINE');
  const [primaryStatus,setPrimaryStatus]=useState<'CONNECTED'|'DISCONNECTED'|'NOT_CONFIGURED'|'ERROR'>('NOT_CONFIGURED');
  const [memoryReady,setMemoryReady]=useState(false);
  const [hubStatus,setHubStatus]=useState<AgentHubConnectionStatus>('DISCONNECTED');
  const [hubAgents,setHubAgents]=useState<Array<Awaited<ReturnType<AgentHubClient['getAgents']>>[number]>>([]);
  const [hubTasks,setHubTasks]=useState<Array<Awaited<ReturnType<AgentHubClient['getTasks']>>[number]>>([]);
  const [hubEvents,setHubEvents]=useState<AgentEvent[]>([]);
  const [hubGoal,setHubGoal]=useState('');
  const [hubScope,setHubScope]=useState('workspace');
  const [hubAssignee,setHubAssignee]=useState('nexus-ui');
  const [hubActor,setHubActor]=useState('nexus-ui');
  const [hubError,setHubError]=useState('');
  const [hubBusy,setHubBusy]=useState(false);
  const [response,setResponse]=useState('');
  const [isThinking,setIsThinking]=useState(false);
  const recognitionRef=useRef<any>(null);
  const avatarRef=useRef<HTMLDivElement | null>(null);
  const motionStateRef=useRef<VoiceEventType>('IDLE');
  const speechStartedAtRef=useRef(0);
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

  const refreshHubState = async () => {
    const [agents, tasks] = await Promise.all([agentHubClient.getAgents(), agentHubClient.getTasks()]);
    setHubAgents(agents);
    setHubTasks(tasks);
  };

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
      window.clearInterval(heartbeatTimer);
      stopEvents();
    };
  }, []);

  const runHubMutation = async (operation: () => Promise<unknown>) => {
    setHubBusy(true);
    setHubError('');
    try {
      await operation();
      await refreshHubState();
    } catch (error) {
      setHubError(error instanceof Error ? error.message : 'Agent Hub request failed');
      setHubStatus(error instanceof AgentHubClientError && error.statusCode ? 'ERROR' : 'DISCONNECTED');
    } finally {
      setHubBusy(false);
    }
  };

  const submitHubTask = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hubGoal.trim() || !hubAssignee) return;
    await runHubMutation(async () => {
      await agentHubClient.submitTask({
        goal: hubGoal.trim(),
        createdBy: 'nexus-ui',
        assignedTo: hubAssignee,
        scope: hubScope.trim() || 'workspace',
      });
      setHubGoal('');
    });
  };

  const claimHubTask = (taskId: string) => runHubMutation(() => agentHubClient.claimTask(taskId, hubActor));
  const leaseHubTask = (taskId: string) => runHubMutation(() => agentHubClient.leaseTask(taskId, hubActor, 300000));

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
      const speechEnergy = speakingNow
        ? 0.35 + 0.35 * Math.abs(Math.sin(speechPhase * 11.7)) + 0.2 * Math.abs(Math.sin(speechPhase * 6.1 + 0.7))
        : 0;
      const frame = createAvatarMotionFrame({ state, nowMs, speechEnergy });
      frame.gazeX += pointerRef.current.x * 2.2;
      frame.gazeY += pointerRef.current.y * 1.4;
      const node = avatarRef.current;
      if (node) {
        const vars = avatarMotionCssVars(frame);
        Object.entries(vars).forEach(([name, value]) => node.style.setProperty(name, value));
        node.style.transform = `perspective(900px) rotateX(\${frame.headY.toFixed(2)}deg) rotateY(\${frame.headX.toFixed(2)}deg) translateY(\${(frame.breath * 1.5).toFixed(2)}px) scale(\${(1 + frame.breath * 0.003).toFixed(4)})`;
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

  const emitVoiceEvent = (type: 'LISTENING' | 'THINKING' | 'SPEAKING' | 'EXECUTING' | 'INTERRUPTED' | 'ERROR' | 'IDLE', message: string) => {
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
    u.onstart=()=>{setSpeaking(true);setStatus('Nexus mówi…')};
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
  const run = async () => {
    if(!prompt.trim()) return;
    setIsThinking(true);
    emitVoiceEvent('THINKING', 'Nexus analizuje wiadomość…');
    setStatus('Nexus analizuje wiadomość…');

    try {
      const result = await nexusAgent.send({
        text: prompt,
        mode: aiMode,
        projectContext: 'Nexus UI local agent; voice pipeline active; UI has avatar, memory, and task scaffolding.',
        history: [{ role: 'user', content: prompt }],
      });

      setResponse(result.text);
      setStatus(`Nexus — ${aiMode === 'LOCAL' ? 'lokalny' : aiMode === 'AUTO' ? 'auto' : 'cloud'} • ${selectedModel}`);
      setPrompt('');
      if (result.text.trim()) {
        speak(result.text);
      }
      emitVoiceEvent('EXECUTING', `Handled task with ${aiMode} mode`);
    } catch (error: any) {
      setStatus(error?.message || 'Błąd połączenia z lokalnym AI');
      setOllamaStatus('ERROR');
      emitVoiceEvent('ERROR', error?.message || 'Błąd połączenia z lokalnym AI');
    } finally {
      setIsThinking(false);
    }
  };
  return <main className={styles.shell}>
    <aside className={styles.side}><div className={styles.brand}><div className={styles.mark}>N</div><div><b>NEXUS</b><span>TWÓJ ASYSTENT AI</span></div></div>
      <nav className={styles.menu}><button><MessageCircle/><span>Czat</span></button><button className={styles.active}><Mic/><span>Rozmowa</span></button><button><Brain/><span>Pamięć</span></button><button><ListChecks/><span>Zadania</span></button><button><FolderKanban/><span>Projekty</span></button><button><Wrench/><span>Narzędzia</span></button></nav>
    </aside>
    <section className={styles.main}><header><div><span className={styles.dot}/> Agent online</div><div className={styles.model}>AUTO · lokalny / chmura</div></header>
      <div className={styles.stage}><div className={styles.avatarWrap}><div className={styles.orbit}/><div className={styles.particles}><i/><i/><i/><i/><i/><i/></div>
        <div ref={avatarRef} onPointerMove={trackPointer} onPointerLeave={resetPointer} className={styles.avatar+' '+(speaking?styles.speaking:'')+' '+(listening?styles.listening:'')}><div className={styles.scan}/><img key={avatars[avatar].src} className={styles.person} src={avatars[avatar].src} alt={'Nexus — '+avatars[avatar].name}/><div className={styles.faceRig} aria-hidden="true"><span className={styles.eye+' '+styles.eyeLeft}><i/></span><span className={styles.eye+' '+styles.eyeRight}><i/></span><span className={styles.mouthRig}/></div><div className={styles.wave}><i/><i/><i/><i/><i/></div></div></div>
        <div className={styles.speech}><Sparkles size={16}/> Cześć. Powiedz mi, co mam dla Ciebie zbudować.</div><div className={styles.status}>{status}</div>
        <div className={styles.composer}><Input value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&run()} placeholder="Np. Zbuduj aplikację do rezerwacji wizyt…"/><Button onClick={run} aria-label="Wyślij"><Send size={18}/></Button></div>
        <div className={styles.voiceRow}><Button variant="secondary" onClick={startVoice}><Mic size={18}/> {listening?'Zatrzymaj':'Rozmawiaj'}</Button><Button variant="secondary" onClick={()=>speak('Jestem Nexus. Słyszę Cię i jestem gotowy do rozmowy.')}><Volume2 size={18}/> Test głosu</Button></div>
      </div>
      <div className={styles.settingsPanel}>
        <h3>NEXUS</h3>
        <div className={styles.settingsRow}><span>Primary Agent</span><strong>{primaryStatus}</strong></div>
        <div className={styles.settingsRow}><span>Local AI</span><strong>Ollama • {selectedModel || 'not selected'}</strong></div>
        <div className={styles.settingsRow}><span>Memory</span><strong>{memoryReady ? 'ready' : 'loading'}</strong></div>
        <div className={styles.settingsRow}><span>Agents</span><strong>{hubAgents.filter(agent => agent.presence !== 'offline').length} online · Hub {hubStatus}</strong></div>
      </div>
      <section aria-labelledby="agent-hub-title" style={{borderTop:'1px solid rgba(143,162,186,.24)',borderBottom:'1px solid rgba(143,162,186,.24)',padding:'20px 0',margin:'20px 0',color:'var(--foreground,#edf4ff)'}}>
        <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,marginBottom:16}}>
          <div><h3 id="agent-hub-title" style={{margin:0}}>Agent Hub</h3><span style={{fontSize:13,opacity:.72}}>Presence, zadania i zdarzenia na żywo</span></div>
          <strong aria-live="polite" style={{color:hubStatus==='CONNECTED'?'#57d6a0':hubStatus==='ERROR'?'#ff7f8d':'#ffc66d'}}>{hubStatus}</strong>
        </header>
        <form onSubmit={submitHubTask} style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))',gap:10,marginBottom:18}}>
          <input aria-label="Cel zadania" value={hubGoal} onChange={event=>setHubGoal(event.target.value)} placeholder="Cel zadania" required style={{minWidth:0,padding:'10px 12px',borderRadius:6,border:'1px solid #263247',background:'#111927',color:'inherit'}}/>
          <input aria-label="Zakres zadania" value={hubScope} onChange={event=>setHubScope(event.target.value)} placeholder="Zakres" style={{minWidth:0,padding:'10px 12px',borderRadius:6,border:'1px solid #263247',background:'#111927',color:'inherit'}}/>
          <select aria-label="Agent docelowy" value={hubAssignee} onChange={event=>setHubAssignee(event.target.value)} style={{minWidth:0,padding:'10px 12px',borderRadius:6,border:'1px solid #263247',background:'#111927',color:'inherit'}}>
            {hubAgents.map(agent=><option key={agent.agentId} value={agent.agentId}>{agent.agentId} · {agent.presence}</option>)}
          </select>
          <button type="submit" disabled={hubBusy||hubStatus!=='CONNECTED'} style={{padding:'10px 14px',border:0,borderRadius:6,background:'#7ce7ff',color:'#041116',fontWeight:600,cursor:'pointer',opacity:hubBusy||hubStatus!=='CONNECTED'?.55:1}}>Wyślij zadanie</button>
        </form>
        {hubError&&<p role="alert" style={{color:'#ff7f8d',margin:'0 0 14px'}}>{hubError}</p>}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))',gap:24}}>
          <section aria-labelledby="hub-agents-title">
            <h4 id="hub-agents-title" style={{margin:'0 0 8px'}}>Agenci ({hubAgents.length})</h4>
            {hubAgents.length===0?<p style={{opacity:.72}}>Brak zarejestrowanych agentów.</p>:hubAgents.map(agent=><div key={agent.agentId} style={{padding:'9px 0',borderBottom:'1px solid rgba(143,162,186,.16)'}}>
              <div style={{display:'flex',justifyContent:'space-between',gap:12}}><strong>{agent.agentId}</strong><span>{agent.presence?.toUpperCase()??'UNKNOWN'}</span></div>
              <small style={{opacity:.72}}>{agent.kind} · {agent.capabilities.join(', ')||'bez capabilities'} · heartbeat {new Date(agent.lastHeartbeat).toLocaleTimeString()}</small>
            </div>)}
            {hubAgents.length>0&&<label style={{display:'grid',gap:5,marginTop:12,fontSize:13}}>Działaj jako
              <select value={hubActor} onChange={event=>setHubActor(event.target.value)} style={{padding:'8px 10px',borderRadius:6,border:'1px solid #263247',background:'#111927',color:'inherit'}}>
                {hubAgents.map(agent=><option key={agent.agentId} value={agent.agentId}>{agent.agentId}</option>)}
              </select>
            </label>}
          </section>
          <section aria-labelledby="hub-tasks-title">
            <h4 id="hub-tasks-title" style={{margin:'0 0 8px'}}>Zadania ({hubTasks.length})</h4>
            {hubTasks.length===0?<p style={{opacity:.72}}>Brak zadań.</p>:hubTasks.map(task=><div key={task.id} style={{padding:'10px 0',borderBottom:'1px solid rgba(143,162,186,.16)'}}>
              <div style={{display:'flex',justifyContent:'space-between',gap:12}}><strong>{task.goal}</strong><span>{task.status}</span></div>
              <small style={{opacity:.72}}>{task.scope} · przypisano: {task.assignedTo}{task.lease?` · lease: ${task.lease.owner} do ${new Date(task.lease.expiresAt).toLocaleTimeString()}`:''}</small>
              {task.error&&<div style={{color:'#ff7f8d',fontSize:13}}>{task.error}</div>}
              <div style={{display:'flex',gap:8,marginTop:8}}>
                <button type="button" disabled={hubBusy||hubStatus!=='CONNECTED'||task.status==='DONE'} onClick={()=>void claimHubTask(task.id)} style={{padding:'6px 9px',borderRadius:5,border:'1px solid #263247',background:'#1c2738',color:'inherit',cursor:'pointer'}}>Claim</button>
                <button type="button" disabled={hubBusy||hubStatus!=='CONNECTED'||task.status==='DONE'} onClick={()=>void leaseHubTask(task.id)} style={{padding:'6px 9px',borderRadius:5,border:'1px solid #263247',background:'#1c2738',color:'inherit',cursor:'pointer'}}>Lease 5 min</button>
              </div>
            </div>)}
          </section>
        </div>
        <section aria-labelledby="hub-events-title" style={{marginTop:18}}>
          <h4 id="hub-events-title" style={{margin:'0 0 8px'}}>Live events</h4>
          {hubEvents.length===0?<p style={{opacity:.72}}>Oczekiwanie na zdarzenia z Huba.</p>:hubEvents.map(event=><div key={event.id} style={{display:'flex',gap:10,padding:'5px 0',fontSize:13}}><time style={{opacity:.62}}>{new Date(event.at).toLocaleTimeString()}</time><strong>{event.type}</strong><span>{event.agentId}: {event.message}</span></div>)}
        </section>
      </section>
      <div className={styles.cards}><article><Brain/><div><b>Pamięć projektu</b><span>kontekst, decyzje, pliki</span></div><strong>ON</strong></article><article><Code2/><div><b>Agent Builder</b><span>kod → test → poprawka</span></div><strong>READY</strong></article><article><Play/><div><b>Podgląd aplikacji</b><span>uruchomienie na żywo</span></div><strong>LOCAL</strong></article></div>
      <div className={styles.characterBar}><b>Wybierz postać</b><div className={styles.characterList}>{avatars.map((a,i)=><button key={a.name} onClick={()=>chooseAvatar(i)} className={i===avatar?styles.selected:''}><img src={a.src} alt={a.name}/><span>{a.name}</span></button>)}</div></div>
    </section>
  </main>
}
