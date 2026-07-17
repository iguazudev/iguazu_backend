import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { BillingConfig } from '../billing.config';

export interface PdfInvoiceInput {
  docNumber: string; // 'F001-00001'
  invoiceType: string; // '01' | '03' | '07'
  issueDate: Date;
  customerDocType: string; // '1' | '6'
  customerDocNumber: string;
  customerName: string;
  taxableAmount: number;
  exemptAmount: number;
  taxAmount: number;
  total: number;
  currency: string;
  hash?: string | null;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
  }>;
  // Para notas de crédito
  isCreditNote?: boolean;
  affectedDocNumber?: string | null;
  cancelReason?: string | null;
}

/**
 * Genera la representación impresa (PDF) del comprobante electrónico con el
 * código QR exigido por SUNAT.
 */
@Injectable()
export class PdfService {
  constructor(private readonly config: BillingConfig) {}

  async generate(input: PdfInvoiceInput): Promise<string> {
    const emisor = this.config.emisor;
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));

    const font = 'Helvetica';
    const fontBold = 'Helvetica-Bold';
    doc.font(font);

    const typeLabel = this.typeLabel(input.invoiceType, input.isCreditNote);
    const title = `${typeLabel} ELECTRÓNICA\n${input.docNumber}`;
    const referenceLine = input.affectedDocNumber
      ? `Documento que modifica: ${input.affectedDocNumber}${input.cancelReason ? ` — Motivo: ${input.cancelReason}` : ''}`
      : '';

    // ---- Header: emisor a la izquierda, comprobante a la derecha ----
    doc.fontSize(13).font(fontBold).text(emisor.razonSocial, 40, 40, { width: 320 });
    doc.fontSize(9).font(font);
    doc.text(`RUC: ${emisor.ruc}`, 40, 60, { width: 320 });
    doc.text(`${emisor.address.line}`, 40, 72, { width: 320 });
    doc.text(`${emisor.address.district}, ${emisor.address.cityName}, ${emisor.address.countrySubentity}`, 40, 84, { width: 320 });

    doc.fontSize(11).font(fontBold).text(title, 360, 40, { width: 190, align: 'right' });
    if (referenceLine) {
      doc.fontSize(8).font(font).text(referenceLine, 360, 80, { width: 190, align: 'right' });
    }

    // ---- Cliente ----
    let y = 130;
    doc.moveTo(40, y - 10).lineTo(555, y - 10).strokeColor([0.7, 0.7, 0.7]).lineWidth(0.5).stroke();
    doc.fontSize(9).font(fontBold).text('DATOS DEL CLIENTE', 40, y);
    y += 14;
    doc.font(font).text(`Señor(es): ${input.customerName}`, 40, y);
    y += 12;
    doc.text(`Doc. (${this.docTypeLabel(input.customerDocType)}): ${input.customerDocNumber}`, 40, y);
    y += 12;
    doc.text(`Fecha de emisión: ${input.issueDate.toLocaleString('es-PE')}`, 40, y);

    // ---- Tabla de ítems ----
    y += 24;
    doc.font(fontBold).fontSize(8);
    doc.text('Descripción', 40, y, { width: 280 });
    doc.text('Cant.', 330, y, { width: 50, align: 'right' });
    doc.text('P. Unit.', 390, y, { width: 75, align: 'right' });
    doc.text('Subtotal', 475, y, { width: 80, align: 'right' });
    y += 12;
    doc.moveTo(40, y).lineTo(555, y).strokeColor([0.7, 0.7, 0.7]).lineWidth(0.5).stroke();
    y += 4;

    doc.font(font);
    for (const item of input.items) {
      doc.fontSize(8);
      // Descripción: calcula cuánto alto ocupa (puede ser multilínea con width:280).
      const descY = y;
      doc.text(item.description, 40, y, { width: 280 });
      // pdfkit expone la posición Y final del último texto escrito.
      const textHeight = (doc as any).y - descY;
      // Cant/P.Unit/Subtotal se alinean a la PRIMERA línea de la descripción.
      doc.text(this.fmt(item.quantity), 330, descY, { width: 50, align: 'right' });
      doc.text(this.money(item.unitPrice), 390, descY, { width: 75, align: 'right' });
      doc.text(this.money(item.subtotal), 475, descY, { width: 80, align: 'right' });
      // Avanza según el alto real del ítem (mínimo 16, +4 de padding).
      y += Math.max(textHeight, 14) + 6;
    }

    // ---- Totales ----
    y += 10;
    doc.moveTo(40, y).lineTo(555, y).strokeColor([0.7, 0.7, 0.7]).lineWidth(0.5).stroke();
    y += 8;
    doc.font(font).fontSize(9);
    const colX = 390;
    const valX = 475;
    doc.text('Op. Gravada', colX, y, { width: 80, align: 'right' });
    doc.text(this.money(input.taxableAmount), valX, y, { width: 80, align: 'right' });
    y += 14;
    if (Number(input.exemptAmount) > 0) {
      doc.text('Op. Exonerada/Inafecta', colX, y, { width: 80, align: 'right' });
      doc.text(this.money(input.exemptAmount), valX, y, { width: 80, align: 'right' });
      y += 14;
    }
    doc.text('IGV (18%)', colX, y, { width: 80, align: 'right' });
    doc.text(this.money(input.taxAmount), valX, y, { width: 80, align: 'right' });
    y += 16;
    doc.font(fontBold).text('TOTAL', colX, y, { width: 80, align: 'right' });
    doc.text(`${this.money(input.total)} ${input.currency}`, valX, y, { width: 80, align: 'right' });

    // ---- QR SUNAT ----
    const qrString = this.buildQrString(input);
    try {
      const qrDataUrl = await QRCode.toDataURL(qrString, { margin: 1, width: 140 });
      doc.image(qrDataUrl, 40, y - 70, { width: 90, height: 90 });
    } catch {
      // Si falla el QR, no rompe el PDF.
    }

    // ---- Representación impresa ----
    let footerY = Math.max(y + 40, 720);
    doc.font(font).fontSize(7).fillColor([0.4, 0.4, 0.4]);
    doc.text('Representación impresa del comprobante electrónico.', 40, footerY, { width: 515, align: 'center' });
    if (input.hash) {
      footerY += 12;
      doc.text(`Código de verificación: ${input.hash}`, 40, footerY, { width: 515, align: 'center' });
    }

    return new Promise<string>((resolve, reject) => {
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('base64'));
      });
      doc.on('error', reject);
      doc.end();
    });
  }

  /**
   * Cadena requerida por SUNAT para el QR (formato oficial).
   */
  private buildQrString(input: PdfInvoiceInput): string {
    const parts = [
      this.config.ruc,
      input.invoiceType,
      input.docNumber.split('-')[0] ?? '', // serie
      input.docNumber.split('-')[1] ?? '', // correlativo
      this.igvStr(input.taxAmount),
      this.totalStr(input.total),
      input.issueDate.toISOString().slice(0, 10),
      input.customerDocType,
      input.customerDocNumber,
      input.hash ?? '',
    ];
    return parts.join('|');
  }

  private typeLabel(code: string, isCreditNote?: boolean): string {
    if (isCreditNote || code === '07') return 'NOTA DE CRÉDITO';
    if (code === '08') return 'NOTA DE DÉBITO';
    if (code === '01') return 'FACTURA';
    return 'BOLETA';
  }

  private docTypeLabel(code: string): string {
    if (code === '6') return 'RUC';
    if (code === '1') return 'DNI';
    return 'Doc.';
  }

  private money(n: number): string {
    return new Intl.NumberFormat('es-PE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(n ?? 0));
  }

  private fmt(n: number): string {
    return String(n ?? 0);
  }

  private igvStr(n: number): string {
    return Number(n ?? 0).toFixed(2);
  }

  private totalStr(n: number): string {
    return Number(n ?? 0).toFixed(2);
  }
}
