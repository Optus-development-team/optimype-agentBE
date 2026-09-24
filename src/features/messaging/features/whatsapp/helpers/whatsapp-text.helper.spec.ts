import {
  normalizeWhatsAppLabel,
  normalizeWhatsAppText,
} from './whatsapp-text.helper';

describe('WhatsApp text normalization', () => {
  it('elimina escapes visibles y convierte negrita Markdown', () => {
    expect(normalizeWhatsAppText('Tu cita es \\*\\*mañana\\*\\*.')).toBe(
      'Tu cita es *mañana*.',
    );
  });

  it('convierte asteriscos de lista en viñetas legibles', () => {
    expect(normalizeWhatsAppText('\\* Corte clásico\n* Corte y barba')).toBe(
      '• Corte clásico\n• Corte y barba',
    );
  });

  it('quita formato de los títulos interactivos', () => {
    expect(normalizeWhatsAppLabel('\\*\\*Confirmar\\*\\*')).toBe('Confirmar');
  });
});
