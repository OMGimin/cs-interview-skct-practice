import type { PracticeInput } from './contracts';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9]+$/.test(value);
}
function slackTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{10,}\.[0-9]+$/.test(value)) return null;
  const result = Number(value) * 1000;
  return Number.isFinite(result) ? Math.round(result) : null;
}

export function normalizePayload(payload: unknown, allowedTeam: string): PracticeInput | null {
  if (!allowedTeam) return null;
  const body = record(payload);
  if (body.type === 'event_callback') {
    if (body.team_id !== allowedTeam || typeof body.event_id !== 'string') return null;
    const event = record(body.event);
    if (!id(event.user) || !id(event.channel) || !event.channel.startsWith('D')) return null;
    // Slack documents app_home_opened with an integer microsecond event_ts.
    // Message/action timestamps retain their stricter seconds.fraction format.
    const atMs = event.type === 'app_home_opened' && typeof event.event_ts === 'string' && /^\d{16}$/.test(event.event_ts)
      ? Math.floor(Number(event.event_ts) / 1000)
      : slackTime(event.ts ?? event.event_ts);
    if (atMs === null) return null;
    const base = { teamId: allowedTeam, userId: event.user, channelId: event.channel, eventId: `event:${body.event_id}`, atMs };
    if (event.type === 'app_home_opened') {
      return event.tab === 'messages' ? { ...base, kind: 'menu' } : null;
    }
    if (event.type !== 'message' || event.channel_type !== 'im' || event.bot_id || event.subtype || event.thread_ts) return null;
    if (typeof event.text !== 'string' || !event.text.trim()) return null;
    const text = event.text.trim();
    if (['시작', '도움말', 'start', 'help'].includes(text.toLowerCase())) return { ...base, kind: 'menu' };
    return { ...base, kind: 'answer', text };
  }
  if (body.type === 'block_actions') {
    const team = record(body.team), user = record(body.user), channel = record(body.channel);
    if (team.id !== allowedTeam || !id(user.id) || !id(channel.id) || !channel.id.startsWith('D')) return null;
    if (!Array.isArray(body.actions) || body.actions.length !== 1) return null;
    const action = record(body.actions[0]);
    const atMs = slackTime(action.action_ts);
    if (atMs === null) return null;
    const base = { teamId: allowedTeam, userId: user.id, channelId: channel.id,
      eventId: `action:${allowedTeam}:${user.id}:${action.action_ts}:${action.action_id}`, atMs };
    if (action.action_id === 'practice_cs') return { ...base, kind: 'request', area: 'CS' };
    if (action.action_id === 'practice_ct') return { ...base, kind: 'request', area: 'CT' };
    if (action.action_id === 'practice_reveal' && typeof action.value === 'string' && /^[\w-]{1,100}$/.test(action.value)) {
      return { ...base, kind: 'reveal', attemptId: action.value };
    }
  }
  return null;
}
