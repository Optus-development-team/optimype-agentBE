import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dayjs, { type Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

@Injectable()
export class TimeService {
  constructor(private readonly config: ConfigService) {}

  getTimezone(timezoneName?: string): string {
    const fallback = this.config.get<string>('TIMEZONE_FALLBACK', 'UTC');
    if (this.isValidTimezone(timezoneName)) return timezoneName;
    if (this.isValidTimezone(fallback)) return fallback;
    return 'UTC';
  }

  getTodayDate(timezoneName?: string): string {
    return this.getNow(timezoneName).format('YYYY-MM-DD');
  }

  getCurrentDateTime(timezoneName?: string): string {
    return this.getNow(timezoneName).format();
  }

  getNow(timezoneName?: string): Dayjs {
    return dayjs().tz(this.getTimezone(timezoneName));
  }

  resolveDateBounds(
    dateInput: string,
    timezoneName?: string,
  ): {
    timezone: string;
    date: string;
    timeMinIso: string;
    timeMaxIso: string;
  } {
    const resolvedTimezone = this.getTimezone(timezoneName);
    const baseDate = this.parseDateInput(dateInput, resolvedTimezone);
    return {
      timezone: resolvedTimezone,
      date: baseDate.format('YYYY-MM-DD'),
      timeMinIso: baseDate.startOf('day').toISOString(),
      timeMaxIso: baseDate.endOf('day').toISOString(),
    };
  }

  buildAppointmentStart(
    dateInput: string,
    time: string,
    timezoneName?: string,
  ): {
    timezone: string;
    date: string;
    startIso: string;
  } {
    const resolvedTimezone = this.getTimezone(timezoneName);
    const date = this.parseDateInput(dateInput, resolvedTimezone).format(
      'YYYY-MM-DD',
    );
    const normalizedTime = time.trim();
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)) {
      throw new Error('La hora debe usar el formato de 24 horas HH:mm.');
    }
    const startInTimezone = dayjs.tz(
      `${date} ${normalizedTime}`,
      'YYYY-MM-DD HH:mm',
      resolvedTimezone,
    );
    if (!startInTimezone.isValid()) {
      throw new Error('Fecha u hora inválida para la cita.');
    }
    return {
      timezone: resolvedTimezone,
      date,
      startIso: startInTimezone.toISOString(),
    };
  }

  parseDurationToMinutes(durationText: string): number {
    const normalized = durationText.trim().toLowerCase();
    if (!normalized) throw new Error('La duración es obligatoria.');
    if (/^\d+$/.test(normalized)) {
      const minutes = Number(normalized);
      if (minutes <= 0)
        throw new Error('La duración debe ser mayor a 0 minutos.');
      return minutes;
    }
    const hourMatch = normalized.match(/(\d+)\s*(hora|horas|h)/);
    const minuteMatch = normalized.match(/(\d+)\s*(minuto|minutos|min|m)/);
    const totalMinutes =
      (hourMatch ? Number(hourMatch[1]) : 0) * 60 +
      (minuteMatch ? Number(minuteMatch[1]) : 0);
    if (totalMinutes <= 0) {
      throw new Error(
        'No pude interpretar la duración. Ejemplos válidos: "1 hora", "15 minutos".',
      );
    }
    return totalMinutes;
  }

  private parseDateInput(dateInput: string, timezoneName: string): Dayjs {
    const normalized = this.normalizeText(dateInput);
    const today = dayjs().tz(timezoneName).startOf('day');
    if (normalized === 'hoy') return today;
    if (normalized === 'manana') return today.add(1, 'day');
    if (normalized === 'pasado manana') return today.add(2, 'day');

    const weekdayMatch = normalized.match(
      /^(?:(?:el|este|esta|proximo|proxima|siguiente)\s+)?(domingo|lunes|martes|miercoles|jueves|viernes|sabado)$/,
    );
    if (weekdayMatch) {
      const targetDay = WEEKDAYS[weekdayMatch[1]];
      let daysToAdd = (targetDay - today.day() + 7) % 7;
      if (daysToAdd === 0) daysToAdd = 7;
      return today.add(daysToAdd, 'day');
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      const parsed = dayjs.tz(normalized, 'YYYY-MM-DD', timezoneName);
      if (parsed.isValid() && parsed.format('YYYY-MM-DD') === normalized) {
        return parsed.startOf('day');
      }
    }

    throw new Error(
      'No pude interpretar la fecha. Usa YYYY-MM-DD, "hoy", "mañana" o un día como "próximo lunes".',
    );
  }

  private normalizeText(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
  }

  private isValidTimezone(value?: string): value is string {
    if (!value?.trim()) return false;
    try {
      Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }
}
