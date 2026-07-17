import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { BillingConfig } from './billing.config';
import { InvoicesService } from './invoices.service';
import { SunatService } from './sunat/sunat.service';
import { SummaryBuilderService, type SummaryLine } from './sunat/summary-builder.service';
import { XmlSignerService } from './sunat/xml-signer.service';
import { ZipService } from './sunat/zip.service';
import { UnzipCdrService } from './sunat/unzip-cdr.service';

export interface SendSummaryResult {
  /** Cuántas boletas se incluyeron en el resumen enviado. */
  includedCount: number;
  /** Correlativo del resumen RC asignado. */
  correlativo: number;
  /** Ticket devuelto por SUNAT (si el envío fue exitoso). */
  ticket: string | null;
  /** '98' = en proceso, '0' = procesado (improbable de inmediato). */
  summaryStatus: string | null;
  /** Mensaje de error si el envío falló. */
  summaryError: string | null;
}

/**
 * Orquesta el Resumen Diario de Boletas:
 *  - sendDailySummary(): agrupa boletas PENDING, arma el XML, firma, zip, sendSummary.
 *  - processPendingTickets(): consulta tickets '98' con getStatus y actualiza las boletas.
 *
 * La numeración del resumen (RC) se guarda en InvoiceCounter serie 'RC'.
 */
@Injectable()
export class SummaryProcessorService implements OnModuleInit {
  private readonly logger = new Logger(SummaryProcessorService.name);
  /** Máximo de líneas por bloque (manual RS 097-2012, sec. 1.2.c). */
  private static readonly MAX_LINES_PER_BLOCK = 500;
  /** Intervalo de polling de tickets (ms). Por defecto 3 minutos. */
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BillingConfig,
    private readonly invoices: InvoicesService,
    private readonly summaryBuilder: SummaryBuilderService,
    private readonly signer: XmlSignerService,
    private readonly zip: ZipService,
    private readonly sunat: SunatService,
    private readonly unzip: UnzipCdrService,
  ) {
    this.pollIntervalMs = this.config.summaryPollMs;
  }

  /** Arranca el polling automático de tickets al inicializar el módulo. */
  onModuleInit() {
    if (this.pollTimer) return;
    this.logger.log(
      `Polling de tickets del Resumen Diario activado (cada ${Math.round(this.pollIntervalMs / 1000)}s).`,
    );
    // Primera pasada sin espera para resolver boletas pendientes de arranque.
    this.pollTimer = setInterval(() => {
      this.processPendingTickets().catch((err) =>
        this.logger.error(`Error en polling de tickets: ${err?.message ?? err}`),
      );
    }, this.pollIntervalMs);
    // No mantener vivo el process solo por este timer (evita bloquear el shutdown).
    this.pollTimer.unref?.();
  }

  /**
   * Agrupa todas las boletas PENDING (sin ticket aún) y envía el Resumen Diario.
   * Si no hay boletas pendientes, no hace nada (no genera resúmenes vacíos).
   * Devuelve siempre un resultado (no lanza) para que el flujo de emisión
   * individual no falle aunque el resumen no pueda enviarse en este momento.
   */
  async sendDailySummary(): Promise<SendSummaryResult> {
    // Boletas pendientes de envío: PENDING y sin ticket asignado.
    const pending = await this.prisma.invoice.findMany({
      where: {
        invoiceType: '03',
        status: InvoiceStatus.PENDING,
        ticket: null,
      },
      orderBy: { correlativo: 'asc' },
    });

    if (pending.length === 0) {
      return {
        includedCount: 0,
        correlativo: 0,
        ticket: null,
        summaryStatus: null,
        summaryError: null,
      };
    }

    // Bloque único (el hotel rara vez supera 500 boletas/día). Si las supera,
    // se envían en sucesivas llamadas (cada una toma su bloque de 500).
    const block = pending.slice(0, SummaryProcessorService.MAX_LINES_PER_BLOCK);
    const referenceDate = this.toDate(block[0].issueDate);
    const issueDate = new Date();
    const correlativo = await this.invoices.nextCorrelativo('RC');

    const lines: SummaryLine[] = block.map((inv, idx) => {
      const [serie, correlativoStr] = inv.docNumber.split('-');
      return {
        lineId: idx + 1,
        documentTypeCode: inv.invoiceType,
        serie,
        correlativo: correlativoStr,
        customerDocType: inv.customerDocType,
        customerDocNumber: inv.customerDocNumber,
        taxableAmount: inv.taxableAmount.toString(),
        taxAmount: inv.taxAmount.toString(),
        totalAmount: inv.total.toString(),
      };
    });

    // Construir, firmar y zipear el resumen.
    const xml = this.summaryBuilder.build({
      referenceDate,
      issueDate: this.toDate(issueDate),
      correlativo,
      lines,
    });

    let signedXml: string;
    try {
      signedXml = await this.signer.sign(xml);
    } catch (err) {
      const msg = `Error firmando resumen: ${(err as Error).message}`;
      this.logger.error(msg);
      return { includedCount: block.length, correlativo, ticket: null, summaryStatus: null, summaryError: msg };
    }

    const nombreZip = `${this.config.ruc}-RC-${referenceDate.replace(/-/g, '')}-${correlativo}`;
    const zipBase64 = this.zip.makeZipBase64(nombreZip, signedXml);

    // Enviar a SUNAT.
    try {
      const { ticket } = await this.sunat.sendSummary(zipBase64, nombreZip);
      this.logger.log(`Resumen ${nombreZip} enviado. Ticket: ${ticket}. Boletas: ${block.length}.`);

      // Marcar las boletas con el ticket (siguen PENDING hasta que getStatus las resuelva).
      await this.prisma.invoice.updateMany({
        where: { id: { in: block.map((b) => b.id) } },
        data: {
          ticket,
          summaryStatus: '98',
          summarySentAt: issueDate,
          summaryCorrelativo: correlativo,
        },
      });

      return {
        includedCount: block.length,
        correlativo,
        ticket,
        summaryStatus: '98',
        summaryError: null,
      };
    } catch (err: any) {
      const msg = err?.sunatFault?.message ?? err?.message ?? 'Error desconocido';
      this.logger.error(`Error enviando resumen ${nombreZip}: ${msg}`);
      // Persistimos el detalle del fallo para depuración (sin cambiar status: sigue PENDING).
      await this.prisma.invoice.updateMany({
        where: { id: { in: block.map((b) => b.id) } },
        data: { summaryStatus: 'error_envio', summaryCorrelativo: correlativo },
      });
      return {
        includedCount: block.length,
        correlativo,
        ticket: null,
        summaryStatus: 'error_envio',
        summaryError: msg,
      };
    }
  }

  /**
   * Recorre boletas con ticket en estado '98' (en proceso) o 'error_envio',
   * consulta getStatus y, al obtener el CDR, actualiza cada boleta con su
   * estado final (ACCEPTED/REJECTED/OBSERVED) y su CDR individual.
   */
  async processPendingTickets(): Promise<{ processedTickets: number; resolvedInvoices: number }> {
    // Tickets distintos pendientes de consulta (no duplicamos llamadas por boleta).
    const pendingTickets = await this.prisma.invoice.findMany({
      where: {
        invoiceType: '03',
        ticket: { not: null },
        summaryStatus: { in: ['98', 'error_envio'] },
      },
      select: { ticket: true, summaryCorrelativo: true },
      distinct: ['ticket'],
    });

    let resolvedInvoices = 0;
    for (const row of pendingTickets) {
      const ticket = row.ticket!;
      try {
        const status = await this.sunat.getStatus(ticket);

        if (status.statusCode === '98') {
          // Sigue en proceso. Nada que actualizar (summaryStatus ya es '98').
          continue;
        }

        // '0' (aceptado) o '99' (rechazo): viene con CDR.
        if (!status.cdrBase64) {
          this.logger.warn(`Ticket ${ticket}: statusCode ${status.statusCode} sin CDR.`);
          continue;
        }

        // El CDR del resumen describe el resultado global; si el resumen fue
        // aceptado ('0'), todas sus boletas se aceptan. Si fue rechazado ('99'),
        // todas se rechazan con el motivo del CDR.
        const cdr = this.unzip.unzip(status.cdrBase64);
        const accepted = status.statusCode === '0' && cdr.responseCode === '0';
        const observed = status.statusCode === '0' && cdr.responseCode?.startsWith('2');

        const newStatus: InvoiceStatus = accepted
          ? InvoiceStatus.ACCEPTED
          : observed
            ? InvoiceStatus.OBSERVED
            : InvoiceStatus.REJECTED;

        const cdrXml = cdr.xmlContent ?? '';

        await this.prisma.invoice.updateMany({
          where: { ticket },
          data: {
            status: newStatus,
            summaryStatus: status.statusCode,
            sunatCode: cdr.responseCode ?? null,
            sunatDescription: cdr.description ?? null,
            cdrXml: cdrXml || null,
          },
        });

        const count = await this.prisma.invoice.count({ where: { ticket } });
        resolvedInvoices += count;
        this.logger.log(
          `Ticket ${ticket} → ${newStatus} (code ${cdr.responseCode}). ${count} boletas actualizadas.`,
        );
      } catch (err: any) {
        // No lanzamos: un ticket problemático no debe frenar a los demás.
        this.logger.error(`Error consultando ticket ${ticket}: ${err?.message ?? err}`);
      }
    }

    return { processedTickets: pendingTickets.length, resolvedInvoices };
  }

  private toDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
