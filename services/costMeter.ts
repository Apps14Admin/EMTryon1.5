export const BUDGET_USD = 0.2;
export const REQUEST_FUSE = 90;

export interface ModelRate { inPerMTok: number; outPerMTok: number }

/**
 * USD per million tokens, per model id. FILL FROM THE PROVIDER DASHBOARD.
 * null means "not confirmed": the meter then guards with the request fuse
 * alone and says so in its summary. Never guess a rate — a wrong rate is a
 * budget gate that silently lies in one direction or the other.
 */
export const RATES: Record<string, ModelRate | null> = {
  'gemini-3.1-flash-lite-image': null,
  'gemini-3.1-flash-image': null,
  'gemini-3-pro-image': null,
};

export interface Usage { model: string; inputTokens: number; outputTokens: number }

export const usageOf = (model: string, res: any): Usage | null => {
  const meta = res?.usageMetadata;
  const input = Number(meta?.promptTokenCount);
  const output = Number(meta?.candidatesTokenCount);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { model, inputTokens: input, outputTokens: output };
};

export class CostMeter {
  private ceiling: number;
  private fuse: number;
  private issued = 0;
  private usages: Usage[] = [];
  private unrated = false;

  constructor(ceilingUsd: number = BUDGET_USD, fuse: number = REQUEST_FUSE) {
    this.ceiling = ceilingUsd;
    this.fuse = fuse;
  }

  charge(): void { this.issued += 1; }

  record(usage: Usage | null): void {
    if (!usage) { this.unrated = true; return; }
    if (!RATES[usage.model]) this.unrated = true;
    this.usages.push(usage);
  }

  requests(): number { return this.issued; }

  spentUsd(): number | null {
    if (this.unrated) return null;
    let usd = 0;
    for (const u of this.usages) {
      const rate = RATES[u.model];
      if (!rate) return null;
      usd += (u.inputTokens / 1e6) * rate.inPerMTok + (u.outputTokens / 1e6) * rate.outPerMTok;
    }
    return usd;
  }

  blockedBy(): 'budget' | 'fuse' | null {
    if (this.issued >= this.fuse) return 'fuse';
    const spent = this.spentUsd();
    if (spent !== null && spent >= this.ceiling) return 'budget';
    return null;
  }

  canSpend(): boolean { return this.blockedBy() === null; }

  summary(): string {
    const spent = this.spentUsd();
    const money = spent === null
      ? 'spend not measurable (model rates unconfigured; guarded by request fuse)'
      : `~$${spent.toFixed(4)} of $${this.ceiling.toFixed(2)}`;
    return `${this.issued} request(s), ${money}.`;
  }
}
