import {
  countInteractiveListRows,
  limitInteractiveListRows,
  WHATSAPP_INTERACTIVE_LIST_MAX_ROWS,
} from './interactive-list.helper';

describe('WhatsApp interactive list helper', () => {
  it('limita a diez filas entre todas las secciones', () => {
    const result = limitInteractiveListRows([
      {
        title: 'Mañana',
        rows: Array.from({ length: 8 }, (_, index) => ({
          id: `am-${index}`,
          title: `Hora ${index}`,
        })),
      },
      {
        title: 'Tarde',
        rows: Array.from({ length: 8 }, (_, index) => ({
          id: `pm-${index}`,
          title: `Hora ${index}`,
        })),
      },
    ]);

    expect(countInteractiveListRows(result)).toBe(
      WHATSAPP_INTERACTIVE_LIST_MAX_ROWS,
    );
    expect(result[0].rows).toHaveLength(8);
    expect(result[1].rows).toHaveLength(2);
  });

  it('no modifica una lista que ya cumple el limite', () => {
    const result = limitInteractiveListRows([
      { title: 'Horarios', rows: [{ id: '09:00', title: '09:00' }] },
    ]);

    expect(result).toEqual([
      { title: 'Horarios', rows: [{ id: '09:00', title: '09:00' }] },
    ]);
  });
});
