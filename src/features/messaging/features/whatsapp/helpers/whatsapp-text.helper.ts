/** Convierte Markdown escapado del LLM al formato admitido por WhatsApp. */
export function normalizeWhatsAppText(value: string): string {
  return String(value ?? '')
    .replace(/^\\\*\s+/gm, '• ')
    .replace(/^\*\s+/gm, '• ')
    .replace(/\\([*_~`])/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

/** Los títulos de botones/listas no deben contener marcas de formato. */
export function normalizeWhatsAppLabel(value: string): string {
  return normalizeWhatsAppText(value)
    .replace(/[*_~`]/g, '')
    .trim();
}
