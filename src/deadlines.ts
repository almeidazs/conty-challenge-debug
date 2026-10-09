const BRAND_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// O prazo é um dia civil em São Paulo: o dia sai do instante convertido para
// lá, e não dos 10 primeiros caracteres do ISO (que dão o dia em UTC).
export function approvedCivilDay(approvedAt: string): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of BRAND_DAY.formatToParts(new Date(approvedAt))) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isPastDeadline(approvedAt: string, deadlineDate: string): boolean {
  return approvedCivilDay(approvedAt) > deadlineDate;
}
