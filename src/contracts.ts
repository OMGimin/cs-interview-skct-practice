export type Area = 'CS' | 'CT';

export interface Question {
  id: string;
  area: Area;
  subject: string;
  prompt: string;
  options: string[] | null;
  answer: number | null;
  explanation: string;
  keyPoints: string[];
  version: number;
}

export interface Actor {
  teamId: string;
  userId: string;
  channelId: string;
}

export type PracticeInput = Actor & {
  eventId: string;
  atMs: number;
} & (
  | { kind: 'menu' }
  | { kind: 'request'; area: Area }
  | { kind: 'answer'; text: string }
  | { kind: 'reveal'; attemptId: string }
);

export interface ResultView {
  question: Question;
  mode: 'answer' | 'reveal';
  elapsedSeconds: number;
  interrupted: boolean;
}

// Slack timestamps are returned only after chat.postMessage succeeds.
export interface Messenger {
  menu(actor: Actor): Promise<void>;
  notice(actor: Actor, text: string): Promise<void>;
  question(actor: Actor, question: Question, attemptId: string): Promise<string>;
  result(actor: Actor, result: ResultView): Promise<void>;
}
