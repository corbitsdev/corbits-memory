// Pure Maximal Marginal Relevance dedup pass over the boosted top-15-20
// candidates. No I/O (package stays framework/DB-agnostic); the caller
// supplies vectors it already has on hand from the active per-model
// embedding table.

export interface MmrItem {
  id: string;
  vector?: number[] | undefined;
  score: number;
}

const DEFAULT_LAMBDA = 0.7;

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function magnitude(v: readonly number[]): number {
  return Math.sqrt(dot(v, v));
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot(a, b) / (magA * magB);
}

/**
 * Greedy MMR: repeatedly picks the item maximizing
 * `relevance - lambda * maxSimilarityToAlreadyPicked`, diversifying the
 * final ordering by dropping near-duplicate chunks. `lambda` closer to 1
 * favors relevance, closer to 0 favors diversity — 0.7 is the locked
 * default (relevance-leaning). Items without a vector cannot be compared for
 * similarity, so per the locked contract they are NEVER dropped for lacking
 * one — they are appended, in descending score order, after every
 * vector-bearing item has been placed by the greedy pass.
 */
export function mmrRerank(
  items: readonly MmrItem[],
  lambda: number = DEFAULT_LAMBDA,
  k: number = items.length,
): string[] {
  const withVector = items.filter(
    (item): item is MmrItem & { vector: number[] } => item.vector !== undefined,
  );
  const withoutVector = items.filter((item) => item.vector === undefined);

  const remaining = [...withVector];
  const picked: (MmrItem & { vector: number[] })[] = [];

  while (remaining.length > 0 && picked.length < k) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      if (!candidate) continue;
      const maxSim =
        picked.length === 0
          ? 0
          : Math.max(
              ...picked.map((p) =>
                cosineSimilarity(candidate.vector, p.vector),
              ),
            );
      const mmrScore = candidate.score - lambda * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) picked.push(chosen);
  }

  const orderedVectorIds = picked.map((p) => p.id);
  const orderedVectorlessIds = [...withoutVector]
    .sort((a, b) => b.score - a.score)
    .map((item) => item.id);

  return [...orderedVectorIds, ...orderedVectorlessIds].slice(0, k);
}
