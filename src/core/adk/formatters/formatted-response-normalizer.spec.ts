import { normalizeFormattedResponse } from './formatted-response-normalizer';
import type {
  FormattedResponse,
  LlmResponseFormatInput,
} from './types/llm-response.types';

describe('normalizeFormattedResponse', () => {
  const appointmentInput: LlmResponseFormatInput = {
    responseText:
      'Para agendar una cita necesito fecha, hora, duracion y tipo de servicio.',
    intent: 'schedule_appointment',
    agentUsed: 'appointment_client_agent',
  };

  it('converts malformed lists into compact buttons for appointment flows', () => {
    const malformedList = {
      type: 'list',
      body: 'Elige una opcion para continuar',
      buttonText: 'Opciones',
    } as FormattedResponse;

    const result = normalizeFormattedResponse(malformedList, appointmentInput);

    expect(result.type).toBe('buttons');
    if (result.type === 'buttons') {
      expect(result.body).toBe('Elige una opcion para continuar');
      expect(result.options).toEqual([
        {
          id: 'acknowledge',
          title: 'Entendido',
        },
      ]);
    }
  });

  it('compacts long appointment button responses', () => {
    const longBody =
      'Claro. Para agendar una cita necesito que me indiques fecha, hora, duracion, tipo de servicio y cualquier preferencia adicional. '.repeat(
        4,
      );

    const result = normalizeFormattedResponse(
      {
        type: 'buttons',
        body: longBody,
        options: [
          {
            id: 'continue',
            title: 'Continuar con agenda',
          },
        ],
      },
      appointmentInput,
    );

    expect(result.type).toBe('buttons');
    if (result.type === 'buttons') {
      expect(result.body.length).toBeLessThanOrEqual(323);
      expect(result.body).toContain('Para agendar una cita');
      expect(result.options).toEqual([
        {
          id: 'continue',
          title: 'Continuar con agenda',
        },
      ]);
    }
  });

  it('keeps valid lists and filters malformed list items', () => {
    const result = normalizeFormattedResponse(
      {
        type: 'list',
        body: 'Tengo estos horarios disponibles.',
        buttonText: '',
        sections: [
          {
            title: 'Manana',
            items: [
              {
                id: 'slot_0900',
                title: '09:00',
                description: 'Disponible para cita corta',
              },
              {
                id: '',
                title: 'Sin id',
              },
            ],
          },
          {
            title: 'Vacia',
            items: [],
          },
        ],
      },
      {
        responseText: 'Tengo estos horarios disponibles.',
      },
    );

    expect(result.type).toBe('list');
    if (result.type === 'list') {
      expect(result.buttonText).toBe('Ver opciones');
      expect(result.sections).toEqual([
        {
          title: 'Manana',
          items: [
            {
              id: 'slot_0900',
              title: '09:00',
              description: 'Disponible para cita corta',
            },
          ],
        },
      ]);
    }
  });
});
