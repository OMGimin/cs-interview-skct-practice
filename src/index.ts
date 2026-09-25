import { normalizePayload } from './payload';
import { verifySlackRequest } from './security';
import { SlackMessenger } from './slack';
import { PracticeService } from './practice';
import type { PracticeInput } from './contracts';

export interface Env {
  DB: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_TEAM_ID: string;
}
interface Service {
  handle(input: PracticeInput): Promise<void>;
  cleanup(nowMs?: number): Promise<void>;
}

export function createWorker(serviceFactory: (env: Env) => Service) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') return Response.json({ status: 'ok', service: 'cs-interview-skct-practice' });
      if (!['/slack/events', '/slack/interactions'].includes(path)) return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      if (!env.SLACK_SIGNING_SECRET || !env.SLACK_BOT_TOKEN || !env.SLACK_TEAM_ID) {
        return new Response('Service configuration required', { status: 503 });
      }
      const raw = await request.text();
      if (raw.length > 65_536) return new Response('Request too large', { status: 413 });
      if (!await verifySlackRequest(raw, request.headers, env.SLACK_SIGNING_SECRET)) return new Response('Unauthorized', { status: 401 });
      let body: unknown;
      try {
        const contentType = request.headers.get('content-type') ?? '';
        body = contentType.includes('application/x-www-form-urlencoded')
          ? JSON.parse(new URLSearchParams(raw).get('payload') ?? 'null')
          : JSON.parse(raw);
      } catch { return new Response('Invalid payload', { status: 400 }); }
      if (body && typeof body === 'object' && 'type' in body && body.type === 'url_verification') {
        if (!('challenge' in body) || typeof body.challenge !== 'string') return new Response('Invalid challenge', { status: 400 });
        return Response.json({ challenge: body.challenge });
      }
      const input = normalizePayload(body, env.SLACK_TEAM_ID);
      if (input) {
        // Acknowledge within Slack's deadline. This is bounded best-effort work,
        // not a durable queue: the next DM/button retries recoverable state.
        ctx.waitUntil(serviceFactory(env).handle(input).catch(() => {
          // Never log payloads, user answers, identifiers, tokens or response URLs.
          console.error('practice_processing_failed');
        }));
      }
      return new Response(null, { status: 200 });
    },
    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      ctx.waitUntil(serviceFactory(env).cleanup());
    },
  };
}

export default createWorker((env) => new PracticeService(env.DB, new SlackMessenger(env.SLACK_BOT_TOKEN)));
