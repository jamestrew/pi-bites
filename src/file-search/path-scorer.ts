export interface ScoreResult {
  score: number;
  positions?: number[];
}

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_NONWORD = SCORE_MATCH / 2;
const BONUS_CAMEL_123 = BONUS_BOUNDARY - 1;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_NO_PATH_SEP = BONUS_BOUNDARY - 2;

const enum CharClass {
  White,
  NonWord,
  Delimiter,
  Lower,
  Upper,
  Letter,
  Number,
}

function isCaseInsensitive(query: string): boolean {
  return query.toLowerCase() === query;
}

function charClass(char: string | undefined): CharClass {
  if (!char) return CharClass.NonWord;
  if (/\s/.test(char)) return CharClass.White;
  if (/[\\/,:;|]/.test(char)) return CharClass.Delimiter;
  if (/[0-9]/.test(char)) return CharClass.Number;
  if (/[A-Z]/.test(char)) return CharClass.Upper;
  if (/[a-z]/.test(char)) return CharClass.Lower;
  if (/\p{L}/u.test(char)) return CharClass.Letter;
  return CharClass.NonWord;
}

function computeBonus(prev: CharClass, curr: CharClass): number {
  if (curr > CharClass.NonWord) {
    if (prev === CharClass.White) return BONUS_BOUNDARY + 2;
    if (prev === CharClass.Delimiter) return BONUS_BOUNDARY + 1;
    if (prev === CharClass.NonWord) return BONUS_BOUNDARY;
  }

  if (
    (prev === CharClass.Lower && curr === CharClass.Upper) ||
    (prev !== CharClass.Number && curr === CharClass.Number)
  ) {
    return BONUS_CAMEL_123;
  }

  if (curr === CharClass.NonWord || curr === CharClass.Delimiter) return BONUS_NONWORD;
  if (curr === CharClass.White) return BONUS_BOUNDARY + 2;
  return 0;
}

function hasPathSeparatorAfter(path: string, index: number): boolean {
  return path.indexOf("/", index + 1) !== -1 || path.indexOf("\\", index + 1) !== -1;
}

class AlignmentScorer {
  private score = 0;
  private consecutive = 0;
  private previousIndex: number | undefined;
  private previousClass = CharClass.White;
  private firstBonus = 0;
  readonly positions: number[] = [];

  constructor(private readonly path: string) {}

  init(firstIndex: number) {
    this.score = 0;
    this.consecutive = 0;
    this.previousIndex = undefined;
    this.previousClass = firstIndex > 0 ? charClass(this.path[firstIndex - 1]) : CharClass.White;
    this.firstBonus = 0;
    this.positions.length = 0;

    if (!hasPathSeparatorAfter(this.path, firstIndex)) this.score += BONUS_NO_PATH_SEP;
    this.update(firstIndex);
  }

  update(index: number) {
    const currentClass = charClass(this.path[index]);
    const gap = this.previousIndex === undefined ? 0 : index - this.previousIndex - 1;
    let bonus = 0;

    if (gap > 0) {
      this.previousClass = charClass(this.path[index - 1]);
      bonus = computeBonus(this.previousClass, currentClass);
      this.score += SCORE_GAP_START + (gap - 1) * SCORE_GAP_EXTENSION;
      this.consecutive = 0;
      this.firstBonus = 0;
    } else {
      bonus = computeBonus(this.previousClass, currentClass);
      if (this.consecutive === 0) {
        this.firstBonus = bonus;
      } else {
        if (bonus >= BONUS_BOUNDARY && bonus > this.firstBonus) this.firstBonus = bonus;
        bonus = Math.max(bonus, this.firstBonus, BONUS_CONSECUTIVE);
      }
      this.consecutive += 1;
    }

    if (this.previousIndex === undefined) bonus *= BONUS_FIRST_CHAR_MULTIPLIER;

    this.score += SCORE_MATCH + bonus;
    this.previousClass = currentClass;
    this.previousIndex = index;
    this.positions.push(index);
  }

  get result(): ScoreResult {
    return { score: this.score, positions: [...this.positions] };
  }
}

function scoreAlignment(
  originalCandidate: string,
  searchableCandidate: string,
  query: string,
  start: number,
): ScoreResult | null {
  const scorer = new AlignmentScorer(originalCandidate);
  scorer.init(start);

  let last = start;
  for (let i = 1; i < query.length; i += 1) {
    const next = searchableCandidate.indexOf(query[i] ?? "", last + 1);
    if (next === -1) return null;
    scorer.update(next);
    last = next;
  }

  return scorer.result;
}

export function scorePath(
  query: string,
  candidatePath: string,
  lowerCandidatePath = candidatePath.toLowerCase(),
): ScoreResult | null {
  if (query === "") return { score: 0, positions: [] };

  const ignoreCase = isCaseInsensitive(query);
  const searchableQuery = ignoreCase ? query.toLowerCase() : query;
  const searchableCandidate = ignoreCase ? lowerCandidatePath : candidatePath;
  let best: ScoreResult | null = null;

  for (
    let start = searchableCandidate.indexOf(searchableQuery[0] ?? "");
    start !== -1;
    start = searchableCandidate.indexOf(searchableQuery[0] ?? "", start + 1)
  ) {
    const result = scoreAlignment(candidatePath, searchableCandidate, searchableQuery, start);
    if (result && (!best || result.score > best.score)) best = result;
  }

  return best;
}
