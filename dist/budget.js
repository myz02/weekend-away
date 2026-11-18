export function plansWithinBudget(result, budget) {
  if (!Number.isFinite(budget) && budget !== Infinity) return [];
  return (result?.options ?? []).filter(plan => Number.isFinite(plan.total) && plan.total <= budget);
}
