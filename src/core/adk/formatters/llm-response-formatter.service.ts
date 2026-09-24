import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Gemini,
  LlmAgent,
  Runner,
  isFinalResponse,
  stringifyContent,
  InMemorySessionService,
} from '@google/adk';
import {
  LLM_FORMATTED_RESPONSE_SCHEMA,
  LLM_FORMATTER_OUTPUT_KEY,
  LLM_RESPONSE_FORMAT_INPUT_SCHEMA,
  type FormattedResponse,
  type LlmResponseFormatInput,
} from './types/llm-response.types';
import { resolveGeminiModelName } from '../config/gemini-model.config';
import { normalizeFormattedResponse } from './formatted-response-normalizer';

type AdkErrorEvent = {
  errorCode?: string;
  errorMessage?: string;
};

@Injectable()
export class LlmResponseFormatterService {
  private readonly logger = new Logger(LlmResponseFormatterService.name);
  private readonly agent: LlmAgent; // El agente sí puede ser global/singleton

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('GOOGLE_GENAI_API_KEY', '');
    const modelName = resolveGeminiModelName(this.config);

    if (!apiKey) {
      throw new Error('Google AI no configurado para el formateador');
    }

    const model = new Gemini({ apiKey, model: modelName });

    // Inicializamos solo el agente en el constructor (es una operación síncrona)
    this.agent = new LlmAgent({
      name: 'llm_response_formatter',
      model,
      description:
        'Formatea la respuesta final del agente a JSON estructurado.',
      instruction:
        'Convierte la respuesta a un JSON valido siguiendo el esquema. ' +
        'Selecciona el tipo correcto y completa los campos requeridos.',
      inputSchema: LLM_RESPONSE_FORMAT_INPUT_SCHEMA,
      outputSchema: LLM_FORMATTED_RESPONSE_SCHEMA,
      outputKey: LLM_FORMATTER_OUTPUT_KEY,
    });
  }

  async formatResponse(
    input: LlmResponseFormatInput,
  ): Promise<FormattedResponse> {
    // 1. Crear un servicio de sesión y un runner efímeros para ESTA solicitud.
    // Esto asegura que el formateador no acumule historial de otros mensajes de Optus
    // y el recolector de basura (Garbage Collector) limpiará la memoria al terminar.
    const tempSessionService = new InMemorySessionService();
    const tempRunner = new Runner({
      agent: this.agent,
      appName: 'optus',
      sessionService: tempSessionService,
    });

    // 2. Ahora SÍ podemos usar await para crear la sesión correctamente
    const session = await tempSessionService.createSession({
      appName: 'optus',
      userId: 'formatter',
    });

    const userMessage = {
      role: 'user' as const,
      parts: [{ text: JSON.stringify(input) }],
    };

    let formatted: FormattedResponse | null = null;

    try {
      // 3. Ejecutar el runner usando el sessionId real
      for await (const event of tempRunner.runAsync({
        userId: 'formatter',
        sessionId: session.id, // ¡Aquí ya no será undefined!
        newMessage: userMessage,
      })) {
        const adkError = event as AdkErrorEvent;
        if (adkError.errorCode || adkError.errorMessage) {
          throw new Error(
            `ADK formatter event error ${adkError.errorCode ?? 'unknown'}: ${
              adkError.errorMessage ?? 'sin detalle'
            }`,
          );
        }

        if (isFinalResponse(event)) {
          formatted = this.extractFormattedResponse(event);
        }
      }
    } catch (error) {
      this.logger.error(
        `Error en la ejecución del formateador ADK: ${error.message}`,
        error.stack,
      );
    }

    if (formatted) {
      return normalizeFormattedResponse(formatted, input);
    }

    this.logger.warn(
      'No se pudo formatear la respuesta, usando fallback estructurado',
    );
    return normalizeFormattedResponse(null, input);
  }

  private extractFormattedResponse(event: unknown): FormattedResponse | null {
    const output = (event as { output?: Record<string, unknown> | null })
      .output;

    if (output && LLM_FORMATTER_OUTPUT_KEY in output) {
      return output[LLM_FORMATTER_OUTPUT_KEY] as FormattedResponse;
    }

    const textContent = stringifyContent(event as never);
    if (!textContent) {
      return null;
    }

    try {
      return JSON.parse(textContent) as FormattedResponse;
    } catch (error) {
      this.logger.warn('Respuesta no es JSON valido para formatter');
      return null;
    }
  }
}
