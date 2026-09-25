import { describe, expect, it } from 'vitest';
import { makeSql, readContent, validateContent } from '../scripts/content';

describe('practice content', () => {
  it('has valid drafts with independently checked arithmetic choices', () => {
    const items = readContent();
    expect(items.filter(q => q.area === 'CS')).toHaveLength(6);
    expect(items.filter(q => q.area === 'CT')).toHaveLength(6);
    expect(validateContent(items)).toEqual([]);
  });

  it('rejects a CT key that disagrees with its calculation', () => {
    const items = readContent();
    const ct = items.find(q => q.area === 'CT')!;
    ct.answer = ct.answer === 1 ? 2 : 1;
    expect(validateContent(items).some(error => error.includes('독립 계산 결과'))).toBe(true);
  });

  it('generates deterministic SQL and escapes apostrophes', () => {
    const items = readContent();
    items[0].prompt += " It's a sample.";
    const sql = makeSql(items);
    expect(sql).toContain("It''s a sample.");
    expect(sql).toBe(makeSql([...items].reverse()));
    expect(sql.match(/INSERT INTO questions/g)).toHaveLength(12);
  });
});
