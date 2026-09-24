import type {
  ButtonsFormattedResponse,
  FormattedResponse,
  FormattedResponseListSection,
  FormattedResponseOption,
  LlmResponseFormatInput,
} from './types/llm-response.types';

const MAX_BODY_LENGTH = 320;
const APPOINTMENT_FALLBACK_BODY =
  'Para agendar, dime fecha y hora. Ej: manana 10:00.';

export function normalizeFormattedResponse(
  candidate: FormattedResponse | null | undefined,
  input: LlmResponseFormatInput,
): FormattedResponse {
  if (!candidate) {
    return buildCompactFallback(input);
  }

  switch (candidate.type) {
    case 'binary_question':
      if (candidate.question?.trim() && hasValidOptions(candidate.options, 2)) {
        return {
          ...candidate,
          question: compactBody(candidate.question, input),
          options: [candidate.options[0], candidate.options[1]],
        };
      }
      break;
    case 'buttons': {
      const options = normalizeOptions(candidate.options);
      if (candidate.body?.trim() && options.length) {
        return {
          ...candidate,
          body: compactBody(candidate.body, input),
          options,
        };
      }
      break;
    }
    case 'list': {
      const sections = normalizeSections(candidate.sections);
      if (candidate.body?.trim() && sections.length) {
        return {
          ...candidate,
          body: compactBody(candidate.body, input),
          buttonText: candidate.buttonText?.trim() || 'Ver opciones',
          sections,
        };
      }
      break;
    }
    case 'cta_url':
      if (
        candidate.body?.trim() &&
        candidate.buttonDisplayText?.trim() &&
        candidate.buttonUrl?.trim()
      ) {
        return {
          ...candidate,
          body: compactBody(candidate.body, input),
          buttonDisplayText: candidate.buttonDisplayText.slice(0, 20),
        };
      }
      break;
  }

  return buildCompactFallback(input, candidate);
}

function buildCompactFallback(
  input: LlmResponseFormatInput,
  candidate?: FormattedResponse,
): ButtonsFormattedResponse {
  const fallbackBody =
    extractCandidateBody(candidate) ||
    input.responseText ||
    (isAppointmentContext(input)
      ? APPOINTMENT_FALLBACK_BODY
      : 'No pude preparar las opciones. Escribe tu solicitud en texto.');

  return {
    type: 'buttons',
    body: compactBody(fallbackBody, input),
    options: [
      {
        id: 'acknowledge',
        title: 'Entendido',
      },
    ],
  };
}

function compactBody(text: string, input: LlmResponseFormatInput): string {
  if (!text.trim()) {
    return isAppointmentContext(input)
      ? APPOINTMENT_FALLBACK_BODY
      : 'No pude preparar las opciones. Escribe tu solicitud en texto.';
  }

  return compactText(text);
}

function extractCandidateBody(candidate?: FormattedResponse): string | null {
  if (!candidate) {
    return null;
  }

  const maybeText = candidate as { body?: unknown; question?: unknown };
  const value =
    typeof maybeText.body === 'string'
      ? maybeText.body
      : typeof maybeText.question === 'string'
        ? maybeText.question
        : null;

  return value?.trim() || null;
}

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_BODY_LENGTH) {
    return normalized;
  }

  const sentenceEnd = normalized.lastIndexOf('.', MAX_BODY_LENGTH);
  const end = sentenceEnd > 80 ? sentenceEnd + 1 : MAX_BODY_LENGTH;
  return `${normalized.slice(0, end).trim()}...`;
}

function isAppointmentContext(input: LlmResponseFormatInput): boolean {
  const haystack = `${input.intent ?? ''} ${input.agentUsed ?? ''} ${input.responseText}`;
  return /appointment|cita|agenda|reserva/i.test(haystack);
}

function hasValidOptions(
  options: FormattedResponseOption[] | undefined,
  minimum: number,
): options is FormattedResponseOption[] {
  return normalizeOptions(options).length >= minimum;
}

function normalizeOptions(
  options: FormattedResponseOption[] | undefined,
): FormattedResponseOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .filter((option) => option.id?.trim() && option.title?.trim())
    .slice(0, 3)
    .map((option) => ({
      id: option.id.trim(),
      title: option.title.trim().slice(0, 20),
    }));
}

function normalizeSections(
  sections: FormattedResponseListSection[] | undefined,
): FormattedResponseListSection[] {
  if (!Array.isArray(sections)) {
    return [];
  }

  return sections
    .map((section) => ({
      title: section.title?.trim() || 'Opciones',
      items: Array.isArray(section.items)
        ? section.items
            .filter((item) => item.id?.trim() && item.title?.trim())
            .map((item) => ({
              id: item.id.trim(),
              title: item.title.trim().slice(0, 24),
              ...(item.description?.trim()
                ? { description: item.description.trim().slice(0, 72) }
                : {}),
            }))
        : [],
    }))
    .filter((section) => section.items.length > 0);
}
