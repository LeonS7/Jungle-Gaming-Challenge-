/** Esta página formata horários do painel sem combinar opções incompatíveis do Intl. Assinatura: Leonardo de Souza da Luz */
export function formatTimestamp(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}
