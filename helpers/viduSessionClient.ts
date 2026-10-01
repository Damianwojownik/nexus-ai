import type { ViduSession } from './viduAvatarProvider.ts';

export type ViduRtcProvider = 'artc' | 'trtc' | 'agora' | 'volcengine';

export type CreateViduAvatarSessionInput = {
  imageUri?: string;
  avatarId?: string;
  rtcInfo: {
    provider: ViduRtcProvider;
    appId?: string;
    channelId?: string;
    userId?: string;
    token: string;
  };
};

type CreateSessionResponse = {
  live: { id: string; status: string; trace_id?: string };
  client_secret: string;
  ws_base_url: string;
};

export class ViduSessionClient {
  constructor(private readonly endpoint = '/api/avatar/vidu/session') {}

  async create(input: CreateViduAvatarSessionInput): Promise<ViduSession & { wsBaseUrl: string }> {
    if (!input.imageUri && !input.avatarId) throw new Error('Vidu requires imageUri or avatarId');
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Vidu session creation failed (${response.status})`);
    const data = await response.json() as CreateSessionResponse;
    if (!data.live?.id || !data.client_secret || !data.ws_base_url) throw new Error('Invalid Vidu session response');
    return {
      liveId: data.live.id,
      clientSecret: data.client_secret,
      traceId: data.live.trace_id,
      status: data.live.status,
      wsBaseUrl: data.ws_base_url,
    };
  }
}
