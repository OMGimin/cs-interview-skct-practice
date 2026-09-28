import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Calculation =
  | { kind: 'discount'; price: number; percent: number }
  | { kind: 'ratio'; total: number; partA: number; partB: number }
  | { kind: 'workRate'; daysA: number; daysB: number }
  | { kind: 'missingAverage'; average: number; known: number[] }
  | { kind: 'compoundChange'; initial: number; increasePercent: number; decreasePercent: number }
  | { kind: 'distance'; kmPerHour: number; minutes: number };

export interface ContentItem {
  id: string;
  area: 'CS' | 'CT';
  subject: string;
  prompt: string;
  options: string[] | null;
  answer: number | null; // 1-based, matching the Slack choice number
  explanation: string;
  keyPoints: string[];
  version: number;
  status: 'draft' | 'reviewed' | 'disabled';
  sourceUrl?: string;
  calculation?: Calculation;
  review?: { reviewedBy: string; reviewedAt: string; humanReview: 'not performed' | 'completed' };
}

const dataPath = fileURLToPath(new URL('../content/questions.json', import.meta.url));
const sqlPath = fileURLToPath(new URL('../content/seed.sql', import.meta.url));

export function readContent(): ContentItem[] {
  return JSON.parse(readFileSync(dataPath, 'utf8')) as ContentItem[];
}

function computedAnswer(input: Calculation): number {
  switch (input.kind) {
    case 'discount': return input.price * (100 - input.percent) / 100;
    case 'ratio': return input.total * input.partB / (input.partA + input.partB);
    case 'workRate': return 1 / (1 / input.daysA + 1 / input.daysB);
    case 'missingAverage': return input.average * (input.known.length + 1) - input.known.reduce((a, b) => a + b, 0);
    case 'compoundChange': return input.initial * (100 + input.increasePercent) / 100 * (100 - input.decreasePercent) / 100;
    case 'distance': return input.kmPerHour * input.minutes / 60;
  }
}

function optionNumber(option: string): number {
  const match = /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:원|개|일|km)?\s*$/.exec(option);
  return match ? Number(match[1].replaceAll(',', '')) : NaN;
}

export function validateContent(items: ContentItem[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(items) || items.length === 0) return ['문제 목록이 비어 있습니다.'];
  for (const [index, q] of items.entries()) {
    const label = q.id || `row ${index + 1}`;
    if (!/^[a-z0-9-]+$/.test(q.id)) errors.push(`${label}: ID 형식이 잘못되었습니다.`);
    if (ids.has(q.id)) errors.push(`${label}: ID가 중복됩니다.`);
    ids.add(q.id);
    if (q.area !== 'CS' && q.area !== 'CT') errors.push(`${label}: 영역이 잘못되었습니다.`);
    if (typeof q.subject !== 'string' || !q.subject.trim()) errors.push(`${label}: subject가 비어 있습니다.`);
    for (const field of ['prompt', 'explanation'] as const) {
      if (typeof q[field] !== 'string' || q[field].trim().length < 10) errors.push(`${label}: ${field}가 비어 있거나 너무 짧습니다.`);
    }
    if (!Number.isSafeInteger(q.version) || q.version < 1) errors.push(`${label}: 버전이 잘못되었습니다.`);
    if (!['draft', 'reviewed', 'disabled'].includes(q.status)) errors.push(`${label}: 상태가 잘못되었습니다.`);
    if (!Array.isArray(q.keyPoints) || q.keyPoints.some(p => typeof p !== 'string' || !p.trim())) errors.push(`${label}: keyPoints 형식이 잘못되었습니다.`);
    if (q.status === 'reviewed' && (!q.review?.reviewedBy || !/^\d{4}-\d{2}-\d{2}$/.test(q.review.reviewedAt) || !q.review.humanReview)) {
      errors.push(`${label}: reviewed 상태에는 검토 주체·일자·사람 검토 여부가 필요합니다.`);
    }
    if (q.area === 'CS') {
      if (q.options !== null || q.answer !== null) errors.push(`${label}: CS에 객관식 선택지나 정답 번호를 넣을 수 없습니다.`);
      if (q.keyPoints.length < 2) errors.push(`${label}: CS 비교 요소가 부족합니다.`);
      if (!q.sourceUrl || !/^https:\/\//.test(q.sourceUrl)) errors.push(`${label}: CS 근거 URL이 필요합니다.`);
      if (q.calculation) errors.push(`${label}: CS에 CT 계산 메타데이터가 있습니다.`);
    }
    if (q.area === 'CT') {
      if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => typeof o !== 'string' || !o.trim())) {
        errors.push(`${label}: CT에는 비어 있지 않은 선택지 4개가 필요합니다.`);
        continue;
      }
      if (new Set(q.options).size !== 4) errors.push(`${label}: 선택지가 중복됩니다.`);
      if (!Number.isInteger(q.answer) || (q.answer ?? 0) < 1 || (q.answer ?? 0) > 4) errors.push(`${label}: 정답은 1~4여야 합니다.`);
      if (!q.calculation) {
        errors.push(`${label}: 독립 계산식이 필요합니다.`);
        continue;
      }
      const operands = Object.entries(q.calculation).filter(([key]) => key !== 'kind').flatMap(([, value]) => Array.isArray(value) ? value : [value]);
      if (operands.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) errors.push(`${label}: 계산 인자가 잘못되었습니다.`);
      const calculated = computedAnswer(q.calculation);
      if (!Number.isFinite(calculated)) errors.push(`${label}: 계산 결과가 유한하지 않습니다.`);
      const hits = q.options.flatMap((option, i) => Math.abs(optionNumber(option) - calculated) < 1e-8 ? [i + 1] : []);
      if (hits.length !== 1 || hits[0] !== q.answer) errors.push(`${label}: 선택지와 독립 계산 결과가 정답 번호와 일치하지 않습니다.`);
    }
  }
  return errors;
}

function sqlString(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
}

export function makeSql(items: ContentItem[]): string {
  const errors = validateContent(items);
  if (errors.length) throw new Error(errors.join('\n'));
  const rows = [...items].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return [
    '-- Generated by npm run content:sql. Edit content/questions.json instead.',
    'BEGIN TRANSACTION;',
    ...rows.map(q => {
      const values = [q.id, q.area, q.subject, q.prompt, q.options === null ? null : JSON.stringify(q.options), q.answer, q.explanation, JSON.stringify(q.keyPoints), q.version, q.status];
      const formatted = values.map(value => typeof value === 'number' ? String(value) : sqlString(value)).join(', ');
      return `INSERT INTO questions (id, area, subject, prompt, options_json, answer, explanation, key_points_json, version, status) VALUES (${formatted}) ON CONFLICT(id) DO UPDATE SET area=excluded.area, subject=excluded.subject, prompt=excluded.prompt, options_json=excluded.options_json, answer=excluded.answer, explanation=excluded.explanation, key_points_json=excluded.key_points_json, version=excluded.version, status=excluded.status;`;
    }),
    'COMMIT;',
    '',
  ].join('\n');
}

const command = process.argv[2];
if (command === 'check' || command === 'sql') {
  const items = readContent();
  const errors = validateContent(items);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else if (command === 'sql') {
    writeFileSync(sqlPath, makeSql(items), 'utf8');
    console.log(`Generated ${sqlPath} (${items.length} items)`);
  } else {
    console.log(`Checked ${items.length} items (${items.filter(q => q.status === 'reviewed').length} reviewed).`);
  }
} else if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  console.error('Usage: tsx scripts/content.ts check|sql');
  process.exitCode = 2;
}
