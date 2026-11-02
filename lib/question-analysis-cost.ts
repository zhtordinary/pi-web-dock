import { priceTokenUsage, type BillingCost, type BillingPricing, type BillingUsageInput } from "./billing";


export interface QuestionAnalysisPriceInput extends BillingUsageInput {
  /** Test-only seam; undefined keeps the production shared adapter default. */
  scriptPath?: string | null;
}
export type QuestionAnalysisPricing = BillingPricing;
export type QuestionAnalysisCost = BillingCost;
export interface QuestionAnalysisPriceResult {
  cost?: QuestionAnalysisCost;
  pricing: QuestionAnalysisPricing;
}


export async function priceQuestionAnalysis(input: QuestionAnalysisPriceInput): Promise<QuestionAnalysisPriceResult> {
  const { scriptPath, ...usage } = input;
  const priced = await priceTokenUsage({
    ...usage,
    timestamp: usage.timestamp ?? new Date().toISOString(),
  }, scriptPath);
  return {
    ...(priced.cost ? { cost: priced.cost } : {}),
    pricing: priced.pricing,
  };
}
