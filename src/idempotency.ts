// A mesma chave pode chegar com o que não se vê: espaço nas pontas ou um
// caractere de formatação como o U+200B do incidente. Nada disso muda a chave.
export function normalizeKey(key: string): string {
  return key.normalize("NFKC").replace(/\p{Cf}/gu, "").trim().toLowerCase();
}
