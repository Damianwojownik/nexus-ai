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
import { registerConversationTools } from '../helpers/nexusConversationTools';
import { VoiceEventBus } from '../helpers/voiceEventBus';
import { HubCloudProvider } from '../helpers/hubCloudProvider';
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
const agentHubClient = new AgentHubClient();
const localCapabilitiesClient = new LocalCapabilitiesClient(agentHubClient.baseUrl);
registerConversationTools(toolRegistry, localCapabilitiesClient);
const ollamaProvider = new OllamaProvider(ollamaClient);
const cloudProvider = new HubCloudProvider();
const modelRouter = new ModelRouter('AUTO', [ollamaProvider], cloudProvider);
const nexusAgent = new NexusAgent(modelRouter, memoryStore, toolRegistry, {
  systemPrompt: 'You are Nexus, a Polish-first independent AI assistant. You coordinate tools safely, explain limitations honestly, and never claim actions that were not verified.',
});
const voiceEventBus = new VoiceEventBus();
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
  const [generatedImageUrl,setGeneratedImageUrl]=useState('');
  const [isThinking,setIsThinking]=useState(false);
  const [conversationHistory,setConversationHistory]=useState<Array<{role:'user'|'assistant';content:string}>>(()=>{
    if(typeof window==='undefined') return [];
    try {
      const saved=window.localStorage.getItem('nexus-chat-history-v1');
      const parsed=saved?JSON.parse(saved):[];
      return Array.isArray(parsed)
        ? parsed.filter((item):item is {role:'user'|'assistant';content:string} =>
            item && (item.role==='user'||item.role==='assistant') && typeof item.content==='string'
          ).slice(-100)
        : [];
    } catch {
      return [];
    }
  });
  const [lastSources,setLastSources]=useState<Array<{title:string;url:string;snippet:string}>>([]);
  const [seoUrl,setSeoUrl]=useState('');
  const [seoBusy,setSeoBusy]=useState(false);
  const [seoError,setSeoError]=useState('');
  const [seoReport,setSeoReport]=useState<any>(null);
  const [seoPageSpeed,setSeoPageSpeed]=useState<any>(null);
  const [seoIntegrations,setSeoIntegrations]=useState<any>(null);
  const [seoDataReport,setSeoDataReport]=useState<any>(null);
  const [semrushPaidApproval,setSemrushPaidApproval]=useState(false);
  const [semrushKeyword,setSemrushKeyword]=useState('');
  const [semrushCountry,setSemrushCountry]=useState('DE');
  const recognitionRef=useRef<any>(null);
  const attachmentInputRef=useRef<HTMLInputElement|null>(null);
  const hubSseConnectedRef=useRef(false);
  const avatarRef=useRef<HTMLDivElement | null>(null);
  const motionStateRef=useRef<VoiceEventType>('IDLE');
  const speechStartedAtRef=useRef(0);
  const speechBoundaryRef=useRef({at:0,intensity:0});
  const speechVisemePlanRef=useRef<VisemeCue[]>([]);
  const pointerRef=useRef({x:0,y:0});
  const generatedImageUrlRef=useRef('');
  const googleOAuthPopupRef=useRef<Window|null>(null);

  useEffect(() => () => {
    if (generatedImageUrlRef.current) URL.revokeObjectURL(generatedImageUrlRef.current);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem('nexus-chat-history-v1', JSON.stringify(conversationHistory.slice(-100)));
    } catch {
      // Local history is best-effort; chat remains usable when storage is unavailable.
    }
  }, [conversationHistory]);

  useEffect(() => {
    void localCapabilitiesClient.getSeoIntegrations()
      .then(setSeoIntegrations)
      .catch(() => setSeoIntegrations(null));
  }, []);

  useEffect(() => {
    const onGoogleOAuthMessage = (event: MessageEvent) => {
      try {
        const hubOrigin = new URL(agentHubClient.baseUrl).origin;
        if (event.origin !== hubOrigin || event.source !== googleOAuthPopupRef.current) return;
        if (event.data?.type !== 'nexus-google-oauth-complete' || event.data?.ok !== true) return;
        googleOAuthPopupRef.current = null;
        void localCapabilitiesClient.getSeoIntegrations().then(setSeoIntegrations).catch(() => undefined);
      } catch {
        // Ignore OAuth messages from unknown origins.
      }
    };
    window.addEventListener('message', onGoogleOAuthMessage);
    return () => window.removeEventListener('message', onGoogleOAuthMessage);
  }, []);

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

      const primaryHealth = await cloudProvider.checkHealth();
      setPrimaryStatus(primaryHealth.status === 'CONNECTED' ? 'CONNECTED' : primaryHealth.status === 'ERROR' ? 'ERROR' : primaryHealth.status === 'OFFLINE' ? 'DISCONNECTED' : 'NOT_CONFIGURED');
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
    if (generatedImageUrlRef.current) URL.revokeObjectURL(generatedImageUrlRef.current);
    generatedImageUrlRef.current = '';
    setGeneratedImageUrl('');
    const nextHistory = [...conversationHistory, { role: 'user' as const, content: messageText }].slice(-100);
    setConversationHistory(nextHistory);
    try {
      const result = await nexusOrchestrator.start({
        text: messageText,
        history: conversationHistory.slice(-20),
        projectContext: 'Nexus local-first workspace. Route through available local capabilities; do not claim unavailable access.',
        attachments,
      }, publishWorkflowProgress);
      setResponse(result.text);
      if (result.status === 'DONE' && result.image) {
        const nextImageUrl = URL.createObjectURL(result.image.blob);
        generatedImageUrlRef.current = nextImageUrl;
        setGeneratedImageUrl(nextImageUrl);
      }
      setLastSources(result.searchResults);
      setConversationHistory(result.status === 'DONE'
        ? [...nextHistory, { role: 'assistant' as const, content: result.text }].slice(-100)
        : nextHistory);
      setPrompt('');
      setAttachments([]);
      if (result.status === 'WAITING_FOR_APPROVAL') setApprovalRequest(result.approval);
      else if (result.text.trim()) speak(result.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nexus nie mógł wykonać zadania';
      setResponse(message);
      setConversationHistory([...nextHistory, { role: 'assistant' as const, content: message }].slice(-100));
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
        setConversationHistory((history) => [...history, { role: 'assistant' as const, content: result.text }].slice(-100));
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
    setConversationHistory((history) => [...history, { role: 'assistant' as const, content: 'Anulowałem tę operację.' }].slice(-100));
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

  const runSeoAudit = async () => {
    if (!seoUrl.trim()) { setSeoError('Wpisz adres strony do audytu.'); return; }
    setSeoBusy(true);
    setSeoError('');
    setSeoReport(null);
    try {
      const result = await localCapabilitiesClient.auditSeo(seoUrl.trim(), 30);
      setSeoReport(result);
      setSeoIntegrations(await localCapabilitiesClient.getSeoIntegrations().catch(() => seoIntegrations));
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się wykonać audytu SEO.');
    } finally {
      setSeoBusy(false);
    }
  };

  const runSeoPageSpeed = async () => {
    if (!seoUrl.trim()) { setSeoError('Wpisz adres strony do pomiaru.'); return; }
    setSeoBusy(true);
    setSeoError('');
    setSeoPageSpeed(null);
    try {
      setSeoPageSpeed(await localCapabilitiesClient.runPageSpeed(seoUrl.trim(), 'mobile'));
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się uruchomić PageSpeed.');
    } finally {
      setSeoBusy(false);
    }
  };

  const runSeoDataReport = async (provider: 'gsc' | 'ga4') => {
    setSeoBusy(true);
    setSeoError('');
    setSeoDataReport(null);
    try {
      const result = provider === 'gsc'
        ? await localCapabilitiesClient.searchConsoleReport()
        : await localCapabilitiesClient.ga4Report();
      setSeoDataReport(result);
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się pobrać raportu analitycznego.');
    } finally {
      setSeoBusy(false);
    }
  };

  const connectGoogleOAuth = async () => {
    const popup = window.open('about:blank', 'nexus-google-oauth', 'popup,width=560,height=720');
    if (!popup) { setSeoError('Przeglądarka zablokowała okno Google OAuth. Zezwól na popupy dla Nexusa i spróbuj ponownie.'); return; }
    googleOAuthPopupRef.current = popup;
    setSeoBusy(true);
    setSeoError('');
    try {
      const authorization = await localCapabilitiesClient.startGoogleOAuth();
      popup.location.href = authorization.authorizationUrl;
    } catch (error) {
      popup.close();
      googleOAuthPopupRef.current = null;
      setSeoError(error instanceof Error ? error.message : 'Nie udało się rozpocząć Google OAuth.');
    } finally {
      setSeoBusy(false);
    }
  };

  const disconnectGoogleOAuth = async () => {
    setSeoBusy(true);
    setSeoError('');
    try {
      await localCapabilitiesClient.disconnectGoogleOAuth();
      setSeoIntegrations(await localCapabilitiesClient.getSeoIntegrations());
      setSeoDataReport(null);
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się rozłączyć Google OAuth.');
    } finally {
      setSeoBusy(false);
    }
  };

  const runGoogleBusinessProfileAudit = async () => {
    setSeoBusy(true);
    setSeoError('');
    setSeoDataReport(null);
    try {
      setSeoDataReport(await localCapabilitiesClient.googleBusinessProfileAudit());
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się odczytać Google Business Profile.');
    } finally {
      setSeoBusy(false);
    }
  };

  const runSemrushCompetitors = async () => {
    if (!semrushPaidApproval) { setSeoError('Zaznacz jawną zgodę na maksymalnie 200 jednostek API.'); return; }
    if (!seoUrl.trim()) { setSeoError('Wpisz adres domeny do porównania.'); return; }
    setSeoBusy(true);
    setSeoError('');
    setSeoDataReport(null);
    try {
      setSeoDataReport(await localCapabilitiesClient.semrushBacklinkCompetitors(seoUrl.trim(), true));
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się pobrać podobnych domen z Semrush.');
    } finally {
      setSeoBusy(false);
      setSemrushPaidApproval(false);
    }
  };

  const runSemrushBacklinks = async () => {
    if (!semrushPaidApproval) { setSeoError('Zaznacz jawną zgodę na koszt 45 jednostek API.'); return; }
    setSeoBusy(true);
    setSeoError('');
    setSeoDataReport(null);
    try {
      setSeoDataReport(await localCapabilitiesClient.semrushBacklinksOverview(seoUrl.trim(), true));
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się pobrać backlinków z Semrush.');
    } finally {
      setSeoBusy(false);
      setSemrushPaidApproval(false);
    }
  };

  const runSemrushKeyword = async () => {
    if (!semrushPaidApproval) { setSeoError('Zaznacz jawną zgodę na koszt 20 jednostek API.'); return; }
    if (!semrushKeyword.trim()) { setSeoError('Wpisz słowo kluczowe do analizy.'); return; }
    setSeoBusy(true);
    setSeoError('');
    setSeoDataReport(null);
    try {
      setSeoDataReport(await localCapabilitiesClient.semrushKeywordMetrics(semrushKeyword.trim(), semrushCountry.trim(), true));
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się pobrać metryk słowa kluczowego z Semrush.');
    } finally {
      setSeoBusy(false);
      setSemrushPaidApproval(false);
    }
  };

  const refreshSeoIntegrations = async () => {
    setSeoBusy(true);
    setSeoError('');
    try {
      setSeoIntegrations(await localCapabilitiesClient.getSeoIntegrations());
    } catch (error) {
      setSeoError(error instanceof Error ? error.message : 'Nie udało się sprawdzić integracji.');
    } finally {
      setSeoBusy(false);
    }
  };

  const exportSeoCsv = () => {
    if (!seoReport?.issues?.length) return;
    const columns = ['severity', 'code', 'page', 'title', 'detail', 'recommendation'];
    const quote = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    const csv = [columns.join(','), ...seoReport.issues.map((issue: any) => columns.map((key) => quote(issue[key])).join(','))].join('\\r\\n');
    const url = URL.createObjectURL(new Blob(['\\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'nexus-seo-audit.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const run = runNexusConversation;
  return <main className={styles.shell}>
    <section className={styles.main}><header><div className={styles.brand}><div className={styles.mark}>N</div><div><b>NEXUS</b><span>ASYSTENT</span></div></div><div className={styles.model}><span className={styles.dot}/> {status}</div></header>
      <div className={styles.stage}><div className={styles.avatarWrap}><div className={styles.orbit}/><div className={styles.particles}><i/><i/><i/><i/><i/><i/></div>
        <div ref={avatarRef} onPointerMove={trackPointer} onPointerLeave={resetPointer} className={styles.avatar+' '+(speaking?styles.speaking:'')+' '+(listening?styles.listening:'')}><div className={styles.scan}/><img key={avatars[avatar].src} className={styles.person} src={avatars[avatar].src} alt={'Nexus — '+avatars[avatar].name} onError={event=>{event.currentTarget.style.display='none'}}/><div className={styles.faceRig} aria-hidden="true"><span className={styles.eye+' '+styles.eyeLeft}><i/></span><span className={styles.eye+' '+styles.eyeRight}><i/></span><span className={styles.mouthRig}/></div><div className={styles.wave}><i/><i/><i/><i/><i/></div></div></div>
        <div className={styles.speech}><Sparkles size={16}/> Cześć. Powiedz mi, co mam dla Ciebie zbudować.</div>
        {(conversationHistory.length>0||response||isThinking)&&<section className={styles.chatTranscript} role="log" aria-live="polite" aria-relevant="additions text">
          {conversationHistory.map((message,index)=><article key={`${index}-${message.role}`} className={styles.chatMessage} data-role={message.role}>
            <span>{message.role==='user'?'TY':'NEXUS'}</span>
            <p>{message.content}</p>
          </article>)}
          {response&&!conversationHistory.some(message=>message.role==='assistant'&&message.content===response)&&<article className={styles.chatMessage} data-role="assistant">
            <span>NEXUS</span><p>{response}</p>
          </article>}
          {isThinking&&<article className={styles.chatMessage} data-role="assistant" data-pending="true">
            <span>NEXUS</span><p>{workflowProgress?.message||'Analizuję Twoje polecenie…'}</p>
          </article>}
        </section>}
        {generatedImageUrl&&<img className={styles.generatedImage} src={generatedImageUrl} alt="Obraz wygenerowany przez Nexus Image Engine"/>}
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
      <details className={styles.seoPanel}>
        <summary>SEO i AEO · audyt strony, PageSpeed i integracje</summary>
        <div className={styles.seoPanelBody}>
          <div className={styles.seoControls}>
            <Input value={seoUrl} onChange={event=>setSeoUrl(event.target.value)} placeholder="https://twoja-domena.pl"/>
            <div className={styles.seoActions}>
              <Button onClick={()=>void runSeoAudit()} disabled={seoBusy||!seoUrl.trim()}>{seoBusy?'Pracuję…':'Audyt SEO/AEO · do 30 stron'}</Button>
              <Button variant="secondary" onClick={()=>void runSeoPageSpeed()} disabled={seoBusy||!seoUrl.trim()}>PageSpeed mobile</Button>
            </div>
          </div>
          {seoError&&<p role="alert" className={styles.capabilityError}>{seoError}</p>}
          {seoReport&&<section className={styles.seoReport}>
            <div className={styles.seoReportHeader}>
              <div><b>Raport techniczny</b><small>{seoReport.site} · {seoReport.pagesScanned}/{seoReport.maxPages} stron · {new Date(seoReport.crawledAt).toLocaleString('pl-PL')}</small></div>
              <div className={styles.seoActions}>
                <Button variant="secondary" onClick={exportSeoCsv} disabled={!seoReport.issues?.length}>Eksport CSV</Button>
                <Button variant="secondary" onClick={()=>window.print()}>Drukuj / PDF</Button>
              </div>
            </div>
            <div className={styles.seoMetrics}>
              <div><b>{seoReport.summary.critical}</b><span>Krytyczne</span></div>
              <div><b>{seoReport.summary.high}</b><span>Wysokie</span></div>
              <div><b>{seoReport.summary.medium}</b><span>Średnie</span></div>
              <div><b>{seoReport.summary.low}</b><span>Niskie</span></div>
            </div>
            <div className={styles.seoReportHeader}><b>AEO / gotowość treści</b><small>{seoReport.aeo.directAnswerReadiness.toUpperCase()} · średnio {seoReport.aeo.averageWordsPerPage} słów / stronę</small></div>
            <div className={styles.seoMeta}>{seoReport.aeo.notes?.map((note:string,index:number)=><p key={index}>{note}</p>)}</div>
            <div className={styles.seoIssues}>
              <b>Problemy i zalecenia</b>
              {seoReport.issues?.length
                ? seoReport.issues.slice(0,30).map((issue:any,index:number)=><article key={issue.code+'-'+index}>
                    <div><span data-severity={issue.severity}>{issue.severity.toUpperCase()}</span><b>{issue.title}</b></div>
                    <small>{issue.page}</small><p>{issue.detail}</p><p>{issue.recommendation}</p>
                  </article>)
                : <p>Nie wykryto problemów w zakresie tej próbki crawla.</p>}
            </div>
            <p className={styles.seoMeta}>{seoReport.limitations?.join(' ')}</p>
          </section>}
          {seoPageSpeed&&<section className={styles.seoReport}>
            <div className={styles.seoReportHeader}><b>Google PageSpeed Insights · {seoPageSpeed.strategy}</b><small>{seoPageSpeed.url}</small></div>
            <div className={styles.seoMetrics}>
              {Object.entries(seoPageSpeed.scores||{}).map(([key,value]:[string,any])=><div key={key}><b>{value}</b><span>{key}</span></div>)}
            </div>
            <div className={styles.seoMeta}><p>Laboratorium Lighthouse: LCP {seoPageSpeed.lab.lcpMs??'—'} ms · FCP {seoPageSpeed.lab.fcpMs??'—'} ms · CLS {seoPageSpeed.lab.cls??'—'} · TBT {seoPageSpeed.lab.tbtMs??'—'} ms</p>
              <p>Dane terenowe: {seoPageSpeed.field?.source||'niedostępne'} {seoPageSpeed.field?.overallCategory||''}</p>
            </div>
            <div className={styles.seoIssues}><b>Najważniejsze możliwości poprawy</b>{seoPageSpeed.opportunities?.map((item:any)=><article key={item.id}><div><b>{item.title}</b><span>{item.savingsMs===undefined?'':item.savingsMs+' ms potencjalnej oszczędności'}</span></div><p>{item.description}</p></article>)}</div>
            <p className={styles.seoMeta}>{seoPageSpeed.limitations?.join(' ')}</p>
          </section>}
          <section className={styles.seoIntegrations}>
            <div className={styles.seoReportHeader}><b>Integracje danych</b><Button variant="secondary" onClick={()=>void refreshSeoIntegrations()} disabled={seoBusy}>Odśwież statusy</Button></div>
            {seoIntegrations?.googleOAuth&&<div className={styles.seoGoogleOAuth}>
              <div><b>Konto Google · OAuth 2.0</b><small>{seoIntegrations.googleOAuth.connected?'Połączone':seoIntegrations.googleOAuth.clientConfigured&&seoIntegrations.googleOAuth.redirectUriConfigured?'Gotowe do autoryzacji':'Wymaga konfiguracji po stronie serwera'}</small></div>
              <div className={styles.seoActions}>
                <Button onClick={()=>void connectGoogleOAuth()} disabled={seoBusy||seoIntegrations.googleOAuth.connected||!seoIntegrations.googleOAuth.clientConfigured||!seoIntegrations.googleOAuth.redirectUriConfigured}>Połącz konto Google</Button>
                <Button variant="secondary" onClick={()=>void disconnectGoogleOAuth()} disabled={seoBusy||!seoIntegrations.googleOAuth.connected}>Rozłącz Google</Button>
              </div>
              {!seoIntegrations.googleOAuth.clientConfigured&&<p className={styles.seoMeta}>Dodaj GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET i GOOGLE_OAUTH_REDIRECT_URI w środowisku serwera Nexusa.</p>}
            </div>}
            {seoIntegrations?<div className={styles.seoIntegrationGrid}>
              <div><b>Google Search Console</b><span>{seoIntegrations.searchConsole.status}</span><small>Wymaga OAuth · webmasters.readonly</small><Button variant="secondary" onClick={()=>void runSeoDataReport('gsc')} disabled={seoBusy||seoIntegrations.searchConsole.status!=='CONFIGURED'}>Pobierz raport GSC</Button></div>
              <div><b>Google Analytics 4</b><span>{seoIntegrations.ga4.status}</span><small>Wymaga OAuth · analytics.readonly</small><Button variant="secondary" onClick={()=>void runSeoDataReport('ga4')} disabled={seoBusy||seoIntegrations.ga4.status!=='CONFIGURED'}>Pobierz raport GA4</Button></div>
              <div className={styles.seoSemrush}>
                <b>Semrush API v4</b>
                <span>{seoIntegrations.backlinks.status}</span>
                <small>Backlink Overview: 45 jednostek. Metryki 1 słowa: 20 jednostek. Podobne domeny: 40 jednostek za wiersz, maksymalnie 5 wierszy (do 200). Każde zapytanie płatne wymaga osobnej zgody.</small>
                <Input value={semrushKeyword} onChange={event=>setSemrushKeyword(event.target.value)} placeholder="Słowo kluczowe do sprawdzenia"/>
                <Input value={semrushCountry} onChange={event=>setSemrushCountry(event.target.value.toUpperCase())} placeholder="Kod kraju, np. DE"/>
                <label className={styles.seoPaidConsent}>
                  <input type="checkbox" checked={semrushPaidApproval} onChange={event=>setSemrushPaidApproval(event.target.checked)} disabled={seoBusy||seoIntegrations.backlinks.status!=='CONFIGURED'}/>
                  <span>Zgadzam się na zużycie jednostek Semrush dla jednego klikniętego zapytania.</span>
                </label>
                <div className={styles.seoActions}>
                  <Button variant="secondary" onClick={()=>void runSemrushKeyword()} disabled={seoBusy||!semrushPaidApproval||seoIntegrations.backlinks.status!=='CONFIGURED'||!semrushKeyword.trim()}>Metryki słowa · 20 jednostek</Button>
                  <Button variant="secondary" onClick={()=>void runSemrushBacklinks()} disabled={seoBusy||!semrushPaidApproval||seoIntegrations.backlinks.status!=='CONFIGURED'||!seoUrl.trim()}>Backlinki · 45 jednostek</Button>
                  <Button variant="secondary" onClick={()=>void runSemrushCompetitors()} disabled={seoBusy||!semrushPaidApproval||seoIntegrations.backlinks.status!=='CONFIGURED'||!seoUrl.trim()}>Podobne domeny · max 200 jednostek</Button>
                </div>
                {seoIntegrations.backlinks.status!=='CONFIGURED'&&<small>Dodaj SEMRUSH_API_KEY w środowisku serwera. Nexus nie pobiera ani nie rozlicza niczego, dopóki samodzielnie nie włączysz tej integracji i nie zatwierdzisz zapytania.</small>}
              </div>
              <div><b>Google Business Profile</b><span>{seoIntegrations.localSeo.status}</span><small>Odczyt nazwy, adresu, telefonu, strony i godzin otwarcia.</small><Button variant="secondary" onClick={()=>void runGoogleBusinessProfileAudit()} disabled={seoBusy||seoIntegrations.localSeo.status!=='CONFIGURED'}>Audyt wizytówki</Button></div>
            </div>:<p className={styles.seoMeta}>Status integracji pojawi się po połączeniu z Agent Hub.</p>}
            {seoDataReport&&<div className={styles.seoDataOutput}>
              <b>{seoDataReport.provider||'Raport integracji'}</b>
              <pre>{JSON.stringify(seoDataReport,null,2)}</pre>
            </div>}
            <p className={styles.seoMeta}>Tokeny OAuth i klucze API są odczytywane wyłącznie po stronie serwera. Nie wpisuj ich w rozmowie ani w przeglądarce.</p>
          </section>
        </div>
      </details>
    </section>
  </main>
}
