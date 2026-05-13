export interface Pattern {
  raw: string;
  test(line: string): boolean;
}

const compile = (pattern: string): Pattern => {
  if (pattern.startsWith('re:')) {
    const re = new RegExp(pattern.slice(3), 'i');
    return { raw: pattern, test: (l) => re.test(l) };
  }
  const lower = pattern.toLowerCase();
  return { raw: pattern, test: (l) => l.toLowerCase().includes(lower) };
};

export const compilePatterns = (patterns: string[]): Pattern[] => patterns.map(compile);

/** Rolling counter over a sliding time window. */
export class RollingCounter {
  private hits: number[] = [];

  constructor(private readonly windowMs: number) {}

  add(at: number): number {
    this.hits.push(at);
    this.trim(at);
    return this.hits.length;
  }

  count(at: number): number {
    this.trim(at);
    return this.hits.length;
  }

  reset(): void {
    this.hits = [];
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.hits.length && this.hits[i]! < cutoff) i += 1;
    if (i > 0) this.hits.splice(0, i);
  }
}
