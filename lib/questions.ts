import rawQuestions from '../data/questions.json';

export interface QuestionOption {
  id: string;
  label: string;
}

export interface Question {
  id: string;
  title: string;
  body: string;
  /** ISO 8601 timestamps, normalized to UTC. */
  opensAt: string;
  closesAt: string;
  options: QuestionOption[];
}

export type QuestionStatus = 'upcoming' | 'open' | 'closed';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function fail(path: string, problem: string): never {
  throw new Error(`Invalid questions file at ${path}: ${problem}`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected a non-empty string');
  return value.trim();
}

function requireId(value: unknown, path: string): string {
  const id = requireString(value, path);
  if (!ID_PATTERN.test(id)) fail(path, `"${id}" must be 1-64 letters, digits, "-" or "_"`);
  return id;
}

function requireDate(value: unknown, path: string): string {
  const text = requireString(value, path);
  const time = Date.parse(text);
  if (Number.isNaN(time)) fail(path, `"${text}" is not a valid date`);
  return new Date(time).toISOString();
}

/** Validates the raw questions data. Throws with a precise path on the first problem. */
export function parseQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) fail('$', 'expected an array of questions');

  const seen = new Set<string>();
  return raw.map((item: unknown, index): Question => {
    const at = `$[${index}]`;
    if (!item || typeof item !== 'object') fail(at, 'expected an object');
    const record = item as Record<string, unknown>;

    const id = requireId(record.id, `${at}.id`);
    if (seen.has(id)) fail(`${at}.id`, `duplicate question id "${id}"`);
    seen.add(id);

    const title = requireString(record.title, `${at}.title`);
    const body = typeof record.body === 'string' ? record.body.trim() : '';
    const opensAt = requireDate(record.opensAt, `${at}.opensAt`);
    const closesAt = requireDate(record.closesAt, `${at}.closesAt`);
    if (Date.parse(closesAt) <= Date.parse(opensAt)) {
      fail(`${at}.closesAt`, 'must be later than opensAt');
    }

    if (!Array.isArray(record.options) || record.options.length < 2) {
      fail(`${at}.options`, 'expected at least two options');
    }
    const optionIds = new Set<string>();
    const options = record.options.map((option: unknown, optionIndex): QuestionOption => {
      const optionAt = `${at}.options[${optionIndex}]`;
      if (!option || typeof option !== 'object') fail(optionAt, 'expected an object');
      const optionRecord = option as Record<string, unknown>;
      const optionId = requireId(optionRecord.id, `${optionAt}.id`);
      if (optionIds.has(optionId)) fail(`${optionAt}.id`, `duplicate option id "${optionId}"`);
      optionIds.add(optionId);
      return { id: optionId, label: requireString(optionRecord.label, `${optionAt}.label`) };
    });

    return { id, title, body, opensAt, closesAt, options };
  });
}

/** Computed from the clock, never stored. `closesAt` itself already counts as closed. */
export function questionStatus(question: Pick<Question, 'opensAt' | 'closesAt'>, now = Date.now()): QuestionStatus {
  if (now < Date.parse(question.opensAt)) return 'upcoming';
  if (now >= Date.parse(question.closesAt)) return 'closed';
  return 'open';
}

let cached: Question[] | undefined;

/** The committed questions, validated once per process. */
export function getQuestions(): Question[] {
  if (!cached) cached = parseQuestions(rawQuestions);
  return cached;
}
