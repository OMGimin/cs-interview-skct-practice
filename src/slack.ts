import type { Actor, Messenger, Question, ResultView } from './contracts';

type Block = Record<string, unknown>;
const numerals = ['①', '②', '③', '④'];
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text } });
const button = (text: string, actionId: string, value: string): Block => ({
  type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value,
});
const next = (): Block => ({ type: 'actions', elements: [
  button('CS 질문 받기', 'practice_cs', 'CS'), button('CT 문제 받기', 'practice_ct', 'CT'),
] });

export class SlackDeliveryError extends Error {
  constructor() { super('Slack message delivery failed'); this.name = 'SlackDeliveryError'; }
}

export class SlackMessenger implements Messenger {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch.bind(globalThis)) {}

  private async post(actor: Actor, text: string, blocks: Block[]): Promise<string> {
    // A timeout is an ambiguous send; do not blindly resend and duplicate a question.
    const response = await this.fetcher('https://slack.com/api/chat.postMessage', {
      method: 'POST', signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: actor.channelId, text, blocks, unfurl_links: false, unfurl_media: false }),
    });
    if (!response.ok) throw new SlackDeliveryError();
    const result = await response.json() as { ok?: boolean; ts?: string };
    if (!result.ok || typeof result.ts !== 'string' || !/^\d+\.\d+$/.test(result.ts)) throw new SlackDeliveryError();
    return result.ts;
  }

  async menu(actor: Actor): Promise<void> {
    const text = '원하는 문제를 한 개씩 풀어보세요.\n답변을 채팅으로 보내거나, 생각만 해본 뒤 바로 답안을 확인해도 됩니다.';
    await this.post(actor, text, [section(text), next()]);
  }

  async notice(actor: Actor, text: string): Promise<void> {
    await this.post(actor, text, [section(escape(text)), next()]);
  }

  async question(actor: Actor, question: Question, attemptId: string): Promise<string> {
    const choices = question.options?.map((option, index) => `${numerals[index]} ${escape(option)}`).join('\n');
    const text = `*${question.area} · ${escape(question.subject)}*\n${escape(question.prompt)}${choices ? `\n\n${choices}` : ''}`;
    const hint = question.area === 'CT'
      ? '답이라고 생각하는 번호(1~4)를 채팅으로 보내주세요. 입력 없이 답안을 확인해도 됩니다.'
      : '답변을 채팅으로 보내주세요. 입력 없이 답안을 확인해도 됩니다.';
    return this.post(actor, `${text}\n${hint}`, [section(text), section(hint), {
      type: 'actions', elements: [button(question.area === 'CT' ? '바로 정답·해설 보기' : '바로 답안 보기', 'practice_reveal', attemptId)],
    }]);
  }

  async result(actor: Actor, result: ResultView): Promise<void> {
    const q = result.question;
    const time = `⏱ ${result.mode === 'answer' ? '답변 제출' : '답안 확인'}까지 약 ${result.elapsedSeconds}초`;
    const title = q.area === 'CT'
      ? `*정답: ${numerals[(q.answer ?? 1) - 1]} ${escape(q.options?.[(q.answer ?? 1) - 1] ?? '')}*`
      : '*핵심 개념·예시 답변*';
    const body = `${title}\n${escape(q.explanation)}${q.keyPoints.length ? `\n\n*비교할 요소:* ${q.keyPoints.map(escape).join(', ')}` : ''}`;
    const note = result.interrupted ? '\n30분을 넘긴 기록입니다. 중단 시간이 포함되었을 수 있으니 참고용으로 확인해 주세요.' : '';
    await this.post(actor, `${time}${note}\n${body}`, [section(`${time}${note}`), section(body), next()]);
  }
}
