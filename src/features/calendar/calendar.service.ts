import { Injectable } from '@nestjs/common';
import { google, type calendar_v3 } from 'googleapis';
import dayjs from 'dayjs';
import { OAuthService } from '../auth/oauth.service';
import { TimeService } from '../../common/time/time.service';

@Injectable()
export class CalendarService {
  constructor(
    private readonly oauthService: OAuthService,
    private readonly timeService: TimeService,
  ) {}

  async checkAvailability(
    companyId: string,
    date: string,
    timezone?: string,
    calendarId = 'primary',
  ): Promise<calendar_v3.Schema$Event[]> {
    const bounds = this.timeService.resolveDateBounds(date, timezone);
    const response = await this.client(companyId).then((calendar) =>
      calendar.events.list({
        calendarId,
        timeMin: bounds.timeMinIso,
        timeMax: bounds.timeMaxIso,
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: false,
      }),
    );
    return response.data.items ?? [];
  }

  async listEvents(
    companyId: string,
    calendarId: string,
    options: {
      updatedMin?: string;
      timeMin?: string;
      pageToken?: string;
      syncToken?: string;
    } = {},
  ): Promise<calendar_v3.Schema$Events> {
    const calendar = await this.client(companyId);
    const response = await calendar.events.list({
      calendarId,
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
      pageToken: options.pageToken,
      syncToken: options.syncToken,
      updatedMin: options.syncToken ? undefined : options.updatedMin,
      timeMin: options.syncToken ? undefined : options.timeMin,
    });
    return response.data;
  }

  async createAppointment(
    companyId: string,
    details: {
      summary: string;
      start: string;
      durationMinutes?: number;
      end?: string;
      description?: string;
      location?: string;
      calendarId?: string;
      appointmentId?: string;
    },
    timezoneName?: string,
  ): Promise<calendar_v3.Schema$Event & { calendarAppLink?: string }> {
    const calendar = await this.client(companyId);
    const timezone = this.timeService.getTimezone(timezoneName);
    const startDate = dayjs(details.start);
    const endDate = details.end
      ? dayjs(details.end)
      : startDate.add(details.durationMinutes ?? 30, 'minute');

    if (
      !startDate.isValid() ||
      !endDate.isValid() ||
      !endDate.isAfter(startDate)
    ) {
      throw new Error('El rango de fecha y hora de la cita no es válido');
    }

    const response = await calendar.events.insert({
      calendarId: details.calendarId ?? 'primary',
      requestBody: {
        summary: details.summary,
        description: details.description,
        location: details.location,
        start: { dateTime: startDate.toISOString(), timeZone: timezone },
        end: { dateTime: endDate.toISOString(), timeZone: timezone },
        extendedProperties: details.appointmentId
          ? { private: { optusAppointmentId: details.appointmentId } }
          : undefined,
      },
    });

    return {
      ...response.data,
      calendarAppLink: this.buildCalendarAppLink(response.data.id),
    };
  }

  async updateAppointment(
    companyId: string,
    calendarId: string,
    eventId: string,
    details: {
      summary: string;
      description?: string | null;
      location?: string | null;
      start: string;
      end: string;
    },
  ): Promise<calendar_v3.Schema$Event> {
    const calendar = await this.client(companyId);
    const response = await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        summary: details.summary,
        description: details.description ?? undefined,
        location: details.location ?? undefined,
        start: { dateTime: dayjs(details.start).toISOString() },
        end: { dateTime: dayjs(details.end).toISOString() },
      },
    });
    return response.data;
  }

  async deleteAppointment(
    companyId: string,
    calendarId: string,
    eventId: string,
  ): Promise<void> {
    const calendar = await this.client(companyId);
    try {
      await calendar.events.delete({ calendarId, eventId });
    } catch (error) {
      const candidate = error as {
        code?: number;
        response?: { status?: number };
      };
      const status = candidate.response?.status ?? candidate.code;
      if (status !== 404 && status !== 410) throw error;
    }
  }

  async watch(
    companyId: string,
    calendarId: string,
    channelId: string,
    address: string,
  ): Promise<calendar_v3.Schema$Channel> {
    const calendar = await this.client(companyId);
    const response = await calendar.events.watch({
      calendarId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address,
        params: { ttl: '604800' },
      },
    });
    return response.data;
  }

  async stopChannel(
    companyId: string,
    channelId: string,
    resourceId: string,
  ): Promise<void> {
    const calendar = await this.client(companyId);
    await calendar.channels.stop({
      requestBody: { id: channelId, resourceId },
    });
  }

  private async client(companyId: string): Promise<calendar_v3.Calendar> {
    const auth = await this.oauthService.getClient(companyId);
    return google.calendar({ version: 'v3', auth });
  }

  private buildCalendarAppLink(eventId?: string | null): string | undefined {
    return eventId
      ? `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(eventId)}`
      : undefined;
  }
}
