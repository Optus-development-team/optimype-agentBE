import type { WhatsAppInteractiveListSection } from '../interfaces/whatsapp-messaging.interface';

export const WHATSAPP_INTERACTIVE_LIST_MAX_ROWS = 10;

/** Limita las filas totales porque Meta rechaza listas con mas de 10. */
export function limitInteractiveListRows(
  sections: WhatsAppInteractiveListSection[],
  maxRows = WHATSAPP_INTERACTIVE_LIST_MAX_ROWS,
): WhatsAppInteractiveListSection[] {
  let remainingRows = Math.max(0, maxRows);
  const limited: WhatsAppInteractiveListSection[] = [];

  for (const section of sections) {
    if (remainingRows === 0) break;

    const rows = section.rows.slice(0, remainingRows);
    if (rows.length === 0) continue;

    limited.push({ ...section, rows });
    remainingRows -= rows.length;
  }

  return limited;
}

export function countInteractiveListRows(
  sections: WhatsAppInteractiveListSection[],
): number {
  return sections.reduce((total, section) => total + section.rows.length, 0);
}
