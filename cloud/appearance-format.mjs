export const APPEARANCE_MODEL = 'mobilenet-v3-small-imagenet1k-v1';
export const VECTOR_LENGTH = 576;

export function validateVectors(pack) {
  if (pack?.model !== APPEARANCE_MODEL || !Array.isArray(pack.vectors) ||
      pack.vectors.length < 1 || pack.vectors.length > 16) {
    throw Error('지원 모델의 특징 벡터 1~16장이 필요합니다.');
  }
  const vectors = pack.vectors.map(vector => {
    if (!Array.isArray(vector) || vector.length !== VECTOR_LENGTH ||
        !vector.every(value => Number.isFinite(value) && Math.abs(value) <= 1.001)) {
      throw Error('벡터 값 또는 차원이 잘못됐습니다.');
    }
    const norm = Math.hypot(...vector);
    if (Math.abs(norm - 1) > .02) throw Error('정규화된 벡터가 필요합니다.');
    return vector.map(value => value / norm);
  });
  return {model: APPEARANCE_MODEL, vectors};
}
