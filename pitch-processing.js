export function centsBetween(hz, targetHz) {
  return 1200 * Math.log2(hz / targetHz);
}

/**
 * 検出ピッチに最も近いターゲット弦を返す。倍音の推測は一切しない。
 * どのターゲットからも maxDistanceCents より離れていれば -1。
 */
export function nearestStringIndex(hz, targetsHz, maxDistanceCents) {
  if (!Number.isFinite(hz) || hz <= 0 || !Array.isArray(targetsHz)) return -1;

  let bestIndex = -1;
  let bestDistance = Infinity;

  for (let index = 0; index < targetsHz.length; index += 1) {
    const targetHz = targetsHz[index];
    if (!Number.isFinite(targetHz) || targetHz <= 0) continue;

    const distance = Math.abs(centsBetween(hz, targetHz));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestDistance <= maxDistanceCents ? bestIndex : -1;
}

export function robustMeanHz(values) {
  const logarithms = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .map(Math.log2)
    .sort((left, right) => left - right);

  if (logarithms.length === 0) return Number.NaN;
  if (logarithms.length <= 2) return 2 ** medianSorted(logarithms);

  const trimmed = logarithms.slice(1, -1);
  const mean = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  return 2 ** mean;
}

function medianSorted(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}
