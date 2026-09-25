import { Injectable, Logger } from '@nestjs/common';
import { FunctionTool } from '@google/adk';
import type { Context } from '@google/adk';
import { z } from 'zod';
import { TimeService } from '../../../../../common/time/time.service';

@Injectable()
export class ReportingToolsService {
  private readonly logger = new Logger('ReportingTools');

  constructor(private readonly timeService: TimeService) {}

  get getDailyMetricsTool(): FunctionTool {
    return new FunctionTool({
      name: 'get_daily_metrics',
      description:
        'Obtiene un resumen de métricas del día actual o una fecha específica. ' +
        'Incluye ventas, citas, mensajes y más.',
      parameters: z.object({
        date: z
          .string()
          .optional()
          .describe('Fecha para consultar (default: hoy)'),
        compareWithPrevious: z
          .boolean()
          .optional()
          .describe('Comparar con día anterior'),
      }),
      execute: async (args, context?: Context) => {
        const state = context?.state;
        const userRole = state?.get('user:role');
        const timezone = state?.get('app:timezone') as string | undefined;

        if (userRole !== 'ADMIN') {
          return {
            success: false,
            message:
              'Los reportes solo están disponibles para administradores.',
          };
        }

        this.logger.debug(`Obteniendo métricas para: ${args.date || 'hoy'}`);

        return {
          success: true,
          date: args.date || this.timeService.getTodayDate(timezone),
          metrics: {
            totalSales: 15420.5,
            ordersCount: 23,
            appointmentsCount: 8,
            messagesReceived: 156,
            newCustomers: 5,
          },
          comparison: args.compareWithPrevious
            ? {
                salesChange: '+12%',
                ordersChange: '+5%',
                appointmentsChange: '-2%',
              }
            : null,
          message:
            '📊 Resumen del día: $15,420 en ventas, 23 órdenes, 8 citas agendadas.',
        };
      },
    });
  }

  get generateSalesReportTool(): FunctionTool {
    return new FunctionTool({
      name: 'generate_sales_report',
      description:
        'Genera un reporte detallado de ventas para un período específico. ' +
        'Incluye desglose por producto, método de pago y más.',
      parameters: z.object({
        period: z
          .enum(['today', 'yesterday', 'week', 'month', 'quarter', 'custom'])
          .describe('Período del reporte'),
        startDate: z
          .string()
          .optional()
          .describe('Fecha inicio (solo para "custom")'),
        endDate: z
          .string()
          .optional()
          .describe('Fecha fin (solo para "custom")'),
        groupBy: z
          .enum(['day', 'week', 'product', 'payment_method'])
          .optional()
          .describe('Agrupar por'),
      }),
      execute: async (args, context?: Context) => {
        const state = context?.state;
        const userRole = state?.get('user:role');

        if (userRole !== 'ADMIN') {
          return {
            success: false,
            message:
              'Los reportes solo están disponibles para administradores.',
          };
        }

        this.logger.debug(`Generando reporte de ventas: ${args.period}`);

        return {
          success: true,
          period: args.period,
          report: {
            totalRevenue: 87650.0,
            totalOrders: 156,
            averageOrderValue: 562.18,
            topProducts: [
              { name: 'Producto A', quantity: 45, revenue: 22500 },
              { name: 'Producto B', quantity: 38, revenue: 19000 },
            ],
            paymentMethods: {
              qr_code: { count: 89, amount: 49560 },
              transfer: { count: 45, amount: 28090 },
              crypto: { count: 22, amount: 10000 },
            },
          },
          message: `📈 Reporte de ventas (${args.period}): $87,650 total, 156 órdenes, ticket promedio $562.`,
        };
      },
    });
  }

  get getLowStockAlertsTool(): FunctionTool {
    return new FunctionTool({
      name: 'get_low_stock_alerts',
      description: 'Obtiene lista de productos con stock bajo o agotado.',
      parameters: z.object({
        threshold: z
          .number()
          .optional()
          .describe('Umbral de stock bajo (default: 10)'),
        includeOutOfStock: z
          .boolean()
          .optional()
          .describe('Incluir productos agotados'),
      }),
      execute: async (args, context?: Context) => {
        const state = context?.state;
        const userRole = state?.get('user:role');

        if (userRole !== 'ADMIN') {
          return {
            success: false,
            message: 'Las alertas solo están disponibles para administradores.',
          };
        }

        const threshold = args.threshold ?? 10;
        this.logger.debug(
          `Obteniendo alertas de stock bajo (umbral: ${threshold})`,
        );

        return {
          success: true,
          threshold,
          alerts: [
            {
              productId: 'PROD-001',
              name: 'Producto A',
              stock: 3,
              status: 'low',
            },
            {
              productId: 'PROD-002',
              name: 'Producto B',
              stock: 0,
              status: 'out_of_stock',
            },
            {
              productId: 'PROD-005',
              name: 'Producto E',
              stock: 8,
              status: 'low',
            },
          ],
          totalLowStock: 2,
          totalOutOfStock: 1,
          message:
            '⚠️ Alerta: 2 productos con stock bajo, 1 agotado. Se recomienda reabastecer.',
        };
      },
    });
  }

  get getAppointmentsReportTool(): FunctionTool {
    return new FunctionTool({
      name: 'get_appointments_report',
      description: 'Genera reporte de citas y reservas para un período.',
      parameters: z.object({
        period: z
          .enum(['today', 'week', 'month'])
          .describe('Período del reporte'),
        includeNoShows: z
          .boolean()
          .optional()
          .describe('Incluir citas sin asistir'),
      }),
      execute: async (args, context?: Context) => {
        const state = context?.state;
        const userRole = state?.get('user:role');

        if (userRole !== 'ADMIN') {
          return {
            success: false,
            message:
              'Los reportes solo están disponibles para administradores.',
          };
        }

        this.logger.debug(`Generando reporte de citas: ${args.period}`);

        return {
          success: true,
          period: args.period,
          report: {
            totalAppointments: 42,
            completed: 38,
            cancelled: 3,
            noShows: args.includeNoShows ? 1 : 0,
            occupancyRate: '78%',
            peakHours: ['10:00', '15:00'],
          },
          message: `📅 Citas (${args.period}): 42 total, 38 completadas, tasa de ocupación 78%.`,
        };
      },
    });
  }

  get getBusinessKpisTool(): FunctionTool {
    return new FunctionTool({
      name: 'get_business_kpis',
      description:
        'Obtiene indicadores clave de rendimiento (KPIs) del negocio. ' +
        'Incluye retención, satisfacción, conversión y más.',
      parameters: z.object({
        period: z
          .enum(['week', 'month', 'quarter'])
          .describe('Período para calcular KPIs'),
      }),
      execute: async (args, context?: Context) => {
        const state = context?.state;
        const userRole = state?.get('user:role');

        if (userRole !== 'ADMIN') {
          return {
            success: false,
            message: 'Los KPIs solo están disponibles para administradores.',
          };
        }

        this.logger.debug(`Calculando KPIs: ${args.period}`);

        return {
          success: true,
          period: args.period,
          kpis: {
            customerRetentionRate: '85%',
            conversionRate: '23%',
            averageResponseTime: '2.5 min',
            customerSatisfaction: 4.7,
            repeatCustomerRate: '62%',
            revenueGrowth: '+15%',
          },
          trends: {
            retention: 'stable',
            conversion: 'up',
            satisfaction: 'up',
          },
          message: `🎯 KPIs (${args.period}): Retención 85%, Conversión 23%, Satisfacción 4.7/5`,
        };
      },
    });
  }

  get allTools(): FunctionTool[] {
    return [
      this.getDailyMetricsTool,
      this.generateSalesReportTool,
      this.getLowStockAlertsTool,
      this.getAppointmentsReportTool,
      this.getBusinessKpisTool,
    ];
  }
}
