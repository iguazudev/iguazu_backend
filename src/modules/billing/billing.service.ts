import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { BillingConfig } from './billing.config';
import { InvoicesService } from './invoices.service';
import {
  IGV_FACTOR,
  TIPO_OPERACION_VENTA_INTERNA,
  TIPO_PRECIO_INCLUYE_IGV,
  defaultSerieForType,
  resolveCustomerDocTypeCode,
  resolveInvoiceTypeCode,
  type CatalogItem,
} from './sunat/sunat-catalogs';
import { XmlBuilderService, type ComprobanteData } from './sunat/xml-builder.service';
import { XmlSignerService } from './sunat/xml-signer.service';
import { ZipService } from './sunat/zip.service';
import { SunatService } from './sunat/sunat.service';
import { UnzipCdrService } from './sunat/unzip-cdr.service';
import { PdfService } from './sunat/pdf.service';
import { IssueCreditNoteDto, IssueFromSaleDto } from './dto/billing.dto';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: BillingConfig,
    private readonly invoices: InvoicesService,
    private readonly xmlBuilder: XmlBuilderService,
    private readonly signer: XmlSignerService,
    private readonly zip: ZipService,
    private readonly sunat: SunatService,
    private readonly unzip: UnzipCdrService,
    private readonly pdf: PdfService,
  ) {}

  // ============================================================
  // Emisión desde una venta
  // ============================================================
  async issueFromSale(saleId: number, dto: IssueFromSaleDto, userId: number) {
    const sale = await this.prisma.sale.findUnique({
      where: { id: saleId },
      include: { details: true, customer: true, invoice: true },
    });
    if (!sale) throw new NotFoundException('Venta no encontrada.');
    if (sale.status !== 'PAID') {
      throw new BadRequestException('Solo se puede facturar una venta pagada.');
    }

    // Cliente: si la venta no tiene customer, no se puede emitir (SUNAT exige receptor).
    if (!sale.customer) {
      throw new BadRequestException(
        'La venta no tiene cliente. Se requiere cliente para emitir un comprobante.',
      );
    }

    // Resolver tipo de comprobante.
    const documentNumber = sale.customer.documentNumber;
    const invoiceType = dto.invoiceType ?? resolveInvoiceTypeCode(documentNumber);
    const customerDocType = resolveCustomerDocTypeCode(documentNumber);

    // Validar coherencia: factura solo a RUC.
    if (invoiceType === '01' && customerDocType !== '6') {
      throw new BadRequestException(
        'Para emitir FACTURA el cliente debe tener RUC (11 dígitos).',
      );
    }

    const retryInvoice =
      sale.invoice?.status === InvoiceStatus.REJECTED ? sale.invoice : null;
    if (sale.invoice && !retryInvoice) {
      throw new BadRequestException(
        `Esta venta ya tiene un comprobante ${sale.invoice.status === InvoiceStatus.ACCEPTED ? 'aceptado' : 'emitido'} (${sale.invoice.docNumber}).`,
      );
    }
    if (retryInvoice && retryInvoice.invoiceType !== invoiceType) {
      throw new BadRequestException(
        `Esta venta ya tiene un comprobante rechazado ${retryInvoice.docNumber}. Reintenta con el mismo tipo de comprobante.`,
      );
    }

    const serie = retryInvoice?.serie ?? defaultSerieForType(invoiceType);
    const correlativo = retryInvoice?.correlativo ?? await this.invoices.nextCorrelativo(serie);
    const docNumber = retryInvoice?.docNumber ?? `${serie}-${String(correlativo).padStart(8, '0')}`;
    const nombreZip = `${this.config.ruc}-${invoiceType}-${docNumber}`;

    // Calcular IGV (precios incluyen IGV: base = total / 1.18).
    const total = Number(sale.total);
    const taxableAmount = Number((total / IGV_FACTOR).toFixed(2));
    const taxAmount = Number((total - taxableAmount).toFixed(2));

    // Construir payload para el XML.
    const data = this.buildComprobanteData({
      docNumber,
      serie,
      correlativo,
      invoiceType,
      taxableAmount,
      taxAmount,
      total,
      customer: sale.customer,
      customerDocType,
      details: sale.details,
    });

    // Ejecutar el flujo SUNAT (XML → firma → zip → envío → CDR).
    const result = await this.processSunat(nombreZip, data, invoiceType);

    // Persistir Invoice.
    const invoiceData = {
      invoiceType,
      serie,
      correlativo,
      docNumber,
      currency: 'PEN',
      taxableAmount,
      exemptAmount: 0,
      taxAmount,
      total,
      customerDocType,
      customerDocNumber: documentNumber,
      customerName: sale.customer.businessName || sale.customer.fullName,
      status: result.status,
      sunatCode: result.sunatCode ?? null,
      sunatDescription: result.sunatDescription ?? null,
      cdrXml: result.cdrXml ?? null,
      signedXml: result.signedXml ?? null,
      hash: result.hash ?? null,
      emittedBy: { connect: { id: userId } },
    };
    const invoice = retryInvoice
      ? await this.invoices.update(retryInvoice.id, {
          ...invoiceData,
          issueDate: new Date(),
        })
      : await this.invoices.create({
          sale: { connect: { id: saleId } },
          ...invoiceData,
        });

    // Generar PDF (solo si fue aceptado u observado).
    let pdfBase64: string | null = null;
    if (result.status !== InvoiceStatus.REJECTED) {
      try {
        pdfBase64 = await this.pdf.generate({
          docNumber,
          invoiceType,
          issueDate: invoice.issueDate,
          customerDocType,
          customerDocNumber: documentNumber,
          customerName: sale.customer.businessName || sale.customer.fullName,
          taxableAmount,
          exemptAmount: 0,
          taxAmount,
          total,
          currency: 'PEN',
          hash: result.hash,
          items: sale.details.map((d) => ({
            description: d.description,
            quantity: Number(d.quantity),
            unitPrice: Number(d.unitPrice),
            subtotal: Number(d.subtotal),
          })),
        });
        await this.invoices.update(invoice.id, { pdfBase64 });
      } catch (err) {
        this.logger.warn(`No se pudo generar PDF: ${(err as Error).message}`);
      }
    }

    return {
      id: invoice.id,
      docNumber,
      invoiceType,
      status: result.status,
      sunatCode: result.sunatCode,
      sunatDescription: result.sunatDescription,
      pdfBase64,
      sunatRequest: this.safeSunatRequest(nombreZip, data),
      sunatDebug: result.sunatDebug,
    };
  }

  // ============================================================
  // Nota de crédito
  // ============================================================
  async issueCreditNote(invoiceId: number, dto: IssueCreditNoteDto, userId: number) {
    const original = await this.invoices.findOne(invoiceId);
    if (!original) throw new NotFoundException('Comprobante no encontrado.');
    if (original.status === InvoiceStatus.CANCELED) {
      throw new BadRequestException('El comprobante ya está anulado.');
    }
    if (original.affectedInvoiceId) {
      throw new BadRequestException('Las notas de crédito no pueden ser anuladas con otra nota.');
    }

    const invoiceType = '07';
    // Serie de la nota según el tipo del original.
    const serie = original.invoiceType === '01' ? 'FC01' : 'BC01';
    const correlativo = await this.invoices.nextCorrelativo(serie);
    const correlativoPadded = String(correlativo).padStart(8, '0');
    const docNumber = `${serie}-${correlativoPadded}`;
    const nombreZip = `${this.config.ruc}-${invoiceType}-${docNumber}`;

    // Montos espejo negados.
    const total = Number(original.total);
    const taxableAmount = Number(original.taxableAmount);
    const taxAmount = Number(original.taxAmount);

    const data = this.buildCreditNoteData({
      docNumber,
      serie,
      correlativo,
      affectedDocNumber: original.docNumber,
      affectedInvoiceType: original.invoiceType,
      reason: dto.reason,
      taxableAmount,
      taxAmount,
      total,
      customerDocType: original.customerDocType,
      customerDocNumber: original.customerDocNumber,
      customerName: original.customerName,
    });

    const result = await this.processSunat(nombreZip, data, invoiceType, true);

    const note = await this.invoices.create({
      invoiceType,
      serie,
      correlativo,
      docNumber,
      currency: original.currency,
      taxableAmount: -taxableAmount,
      exemptAmount: 0,
      taxAmount: -taxAmount,
      total: -total,
      customerDocType: original.customerDocType,
      customerDocNumber: original.customerDocNumber,
      customerName: original.customerName,
      status: result.status,
      sunatCode: result.sunatCode ?? null,
      sunatDescription: result.sunatDescription ?? null,
      cdrXml: result.cdrXml ?? null,
      signedXml: result.signedXml ?? null,
      hash: result.hash ?? null,
      affectedInvoice: { connect: { id: invoiceId } },
      cancelReason: dto.reason,
      emittedBy: { connect: { id: userId } },
    });

    // Marcar original como anulada si la nota fue aceptada.
    if (result.status === InvoiceStatus.ACCEPTED) {
      await this.invoices.update(invoiceId, {
        status: InvoiceStatus.CANCELED,
        cancelReason: dto.reason,
      });
    }

    return {
      id: note.id,
      docNumber,
      invoiceType,
      status: result.status,
      sunatCode: result.sunatCode,
      sunatDescription: result.sunatDescription,
      affectedInvoice: original.docNumber,
      sunatDebug: result.sunatDebug,
    };
  }

  // ============================================================
  // Listado / detalle
  // ============================================================
  findAll() {
    return this.invoices.findAll();
  }

  async findOne(id: number) {
    const invoice = await this.invoices.findOne(id);
    if (!invoice) throw new NotFoundException('Comprobante no encontrado.');
    return invoice;
  }

  // ============================================================
  // Flujo común XML → firma → zip → SUNAT → CDR
  // ============================================================
  private async processSunat(
    nombreZip: string,
    data: ComprobanteData,
    invoiceType: string,
    isCreditNote = false,
  ) {
    // 1. Construir XML.
    const xml = isCreditNote
      ? this.xmlBuilder.buildCreditNote(data)
      : this.xmlBuilder.buildInvoice(data);

    let signedXml = '';
    let zipBase64 = '';
    let sunatCode: string | undefined;
    let sunatDescription: string | undefined;
    let cdrXml: string | undefined;
    let hash: string | undefined;
    let sunatDebug: Record<string, unknown> | undefined;
    let status: InvoiceStatus = InvoiceStatus.PENDING;

    try {
      // 2. Firmar.
      signedXml = await this.signer.sign(xml);

      // 3. ZIP.
      zipBase64 = this.zip.makeZipBase64(nombreZip, signedXml);

      // 4. Enviar a SUNAT.
      const { cdrBase64 } = await this.sunat.sendBill(zipBase64, nombreZip);
      const cdr = this.unzip.unzip(cdrBase64);
      cdrXml = cdr.xmlContent;
      sunatCode = cdr.responseCode;
      sunatDescription = cdr.description;

      // Hash: extraer del CDR (DigestValue) si está disponible.
      if (cdrXml) {
        const match = /<DigestValue[^>]*>([^<]+)<\/DigestValue>/.exec(cdrXml);
        hash = match?.[1];
      }

      // Interpretar código: '0' aceptado, '2xxx' observado (aceptado con observaciones), resto rechazado.
      if (sunatCode === '0') {
        status = InvoiceStatus.ACCEPTED;
      } else if (sunatCode?.startsWith('2')) {
        status = InvoiceStatus.OBSERVED;
      } else {
        status = InvoiceStatus.REJECTED;
      }
    } catch (err: any) {
      this.logger.error(`SUNAT rechazó el envío: ${err.message}`);
      const fault = err?.sunatFault;
      sunatCode = fault?.sunatCode;
      sunatDescription = fault?.faultstring ?? err.message;
      status = InvoiceStatus.REJECTED;
      const zip = zipBase64 ? Buffer.from(zipBase64, 'base64') : undefined;
      sunatDebug = {
        ...(err?.sunatDebug ?? {}),
        xmlFileName: `${nombreZip}.xml`,
        zipFileName: `${nombreZip}.zip`,
        xmlSizeBytes: Buffer.byteLength(signedXml || xml, 'utf8'),
        zipSizeBytes: zip?.length,
        xmlSha256: createHash('sha256').update(signedXml || xml, 'utf8').digest('hex'),
        zipSha256: zip ? createHash('sha256').update(zip).digest('hex') : undefined,
        sunatFault: fault ?? err?.sunatDebug?.sunatFault,
        exceptionStack: err?.stack,
      };
      // Persistimos igual con el signedXml para trazabilidad.
    }

    return { signedXml, sunatCode, sunatDescription, cdrXml, hash, status, sunatDebug };
  }

  // ============================================================
  // Construcción del payload ComprobanteData (factura/boleta)
  // ============================================================
  private buildComprobanteData(input: {
    docNumber: string;
    serie: string;
    correlativo: number;
    invoiceType: string;
    taxableAmount: number;
    taxAmount: number;
    total: number;
    customer: any;
    customerDocType: string;
    details: any[];
  }): ComprobanteData {
    const emisor = this.config.emisor;
    const now = new Date();
    const issueDate = now.toISOString().slice(0, 10);
    const issueTime = now.toTimeString().slice(0, 8);
    const [serieDoc] = input.docNumber.split('-');
    void serieDoc;
    void input.serie;
    void input.correlativo;

    return {
      cabecera: {
        ublVersionId: '2.1',
        customizationId: '2.0',
        customizationAgencyName: 'PE:SUNAT',
        profileId: TIPO_OPERACION_VENTA_INTERNA,
        profileSchemeName: 'Tipo de Operacion',
        profileSchemeAgencyName: 'PE:SUNAT',
        profileSchemeURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo17',
        id: input.docNumber,
        issueDate,
        issueTime,
        invoiceTypeCode: input.invoiceType,
        invoiceTypeCodeAttrs: {
          listAgencyName: 'PE:SUNAT',
          listName: 'Tipo de Documento',
          listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01',
          listID: TIPO_OPERACION_VENTA_INTERNA,
          name: 'Tipo de Operacion',
        },
        documentCurrencyCode: 'PEN',
        documentCurrencyCodeAttrs: {
          listID: 'ISO 4217 Alpha',
          listName: 'Currency',
          listAgencyName: 'United Nations Economic Commission for Europe',
        },
        lineCountNumeric: String(input.details.length),
      },
      signature: {
        id: input.docNumber,
        partyId: emisor.ruc,
        partyName: emisor.razonSocial,
        uri: '#SignatureSP',
      },
      emisor: {
        ruc: emisor.ruc,
        documentTypeCode: '6',
        nombreComercial: emisor.nombreComercial,
        razonSocial: emisor.razonSocial,
        address: emisor.address,
      },
      cliente: {
        ruc: input.customer.documentNumber,
        documentTypeCode: input.customerDocType,
        nombreComercial: input.customer.businessName || input.customer.fullName,
        razonSocial: input.customer.businessName || input.customer.fullName,
        address: {
          line: input.customer.address ?? '',
          countryCode: 'PE',
        },
      },
      paymentTerms: [
        {
          id: 'FormaPago',
          paymentMeansId: 'Contado',
          amount: input.total.toFixed(2),
          currencyID: 'PEN',
        },
      ],
      taxTotal: {
        taxAmount: input.taxAmount.toFixed(2),
        currencyID: 'PEN',
        subtotals: [
          {
            taxableAmount: input.taxableAmount.toFixed(2),
            taxAmount: input.taxAmount.toFixed(2),
            currencyID: 'PEN',
            taxCategory: {
              id: 'S',
              idAttrs: {
                schemeID: 'UN/ECE 5305',
                schemeName: 'Tax Category Identifier',
                schemeAgencyName: 'United Nations Economic Commission for Europe',
              },
              percent: '18',
              taxExemptionReasonCode: '10',
              taxExemptionReasonCodeAttrs: {
                listAgencyName: 'PE:SUNAT',
                listName: 'Afectacion del IGV',
                listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo07',
              },
              taxScheme: {
                id: '1000',
                idAttrs: {
                  schemeID: 'UN/ECE 5153',
                  schemeName: 'Codigo de tributos',
                  schemeAgencyName: 'PE:SUNAT',
                },
                name: 'IGV',
                taxTypeCode: 'VAT',
              },
            },
          },
        ],
      },
      legalMonetaryTotal: {
        lineExtensionAmount: input.taxableAmount.toFixed(2),
        taxInclusiveAmount: input.total.toFixed(2),
        payableAmount: input.total.toFixed(2),
        currencyID: 'PEN',
      },
      items: input.details.map((d, i) => ({
        id: String(i + 1),
        quantity: Number(d.quantity).toFixed(2),
        unitCode: 'NIU',
        unitCodeListID: 'UN/ECE rec 20',
        unitCodeListAgencyName: 'United Nations Economic Commission for Europe',
        lineExtensionAmount: (Number(d.subtotal) / IGV_FACTOR).toFixed(2),
        currencyID: 'PEN',
        pricingReference: {
          priceAmount: Number(d.unitPrice).toFixed(2),
          currencyID: 'PEN',
          priceTypeCode: TIPO_PRECIO_INCLUYE_IGV,
          priceTypeCodeAttrs: {
            listName: 'Tipo de Precio',
            listAgencyName: 'PE:SUNAT',
            listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo16',
          },
        },
        taxTotal: {
          taxAmount: (Number(d.subtotal) - Number(d.subtotal) / IGV_FACTOR).toFixed(2),
          currencyID: 'PEN',
          subtotals: [
            {
              taxableAmount: (Number(d.subtotal) / IGV_FACTOR).toFixed(2),
              taxAmount: (Number(d.subtotal) - Number(d.subtotal) / IGV_FACTOR).toFixed(2),
              currencyID: 'PEN',
              taxCategory: {
                id: 'S',
                percent: '18',
                taxExemptionReasonCode: '10',
                taxExemptionReasonCodeAttrs: {
                  listAgencyName: 'PE:SUNAT',
                  listName: 'Afectacion del IGV',
                  listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo07',
                },
                taxScheme: {
                  id: '1000',
                  name: 'IGV',
                  taxTypeCode: 'VAT',
                },
              },
            },
          ],
        },
        item: {
          description: d.description,
          sellersItemId: String(d.productId ?? i + 1),
          classificationCode: '10191509',
          classificationAttrs: {
            listID: 'UNSPSC',
            listAgencyName: 'GS1 US',
            listName: 'Item Classification',
          },
        },
        price: {
          amount: (Number(d.unitPrice) / IGV_FACTOR).toFixed(2),
          currencyID: 'PEN',
        },
      })),
    };
  }

  private safeSunatRequest(nombreZip: string, data: ComprobanteData) {
    return {
      modo: this.config.modo,
      endpoint: this.config.endpoint,
      zipFileName: `${nombreZip}.zip`,
      usuario: this.config.usuario,
      emisor: {
        ruc: data.emisor.ruc,
        razonSocial: data.emisor.razonSocial,
      },
      comprobante: {
        id: data.cabecera.id,
        tipo: data.cabecera.invoiceTypeCode,
        fecha: data.cabecera.issueDate,
        hora: data.cabecera.issueTime,
        moneda: data.cabecera.documentCurrencyCode,
      },
      cliente: {
        documentoTipo: data.cliente.documentTypeCode,
        documentoNumero: data.cliente.ruc,
        nombre: data.cliente.razonSocial,
      },
      totales: {
        gravada: data.legalMonetaryTotal.lineExtensionAmount,
        igv: data.taxTotal.taxAmount,
        total: data.legalMonetaryTotal.payableAmount,
      },
      items: data.items.map((item) => ({
        descripcion: item.item.description,
        cantidad: item.quantity,
        precioUnitario: item.pricingReference?.priceAmount ?? item.price.amount,
        base: item.lineExtensionAmount,
        igv: item.taxTotal.taxAmount,
      })),
    };
  }

  // ============================================================
  // Construcción del payload para nota de crédito
  // ============================================================
  private buildCreditNoteData(input: {
    docNumber: string;
    serie: string;
    correlativo: number;
    affectedDocNumber: string;
    affectedInvoiceType: string;
    reason: string;
    taxableAmount: number;
    taxAmount: number;
    total: number;
    customerDocType: string;
    customerDocNumber: string;
    customerName: string;
  }): ComprobanteData {
    const emisor = this.config.emisor;
    const now = new Date();
    const issueDate = now.toISOString().slice(0, 10);
    const issueTime = now.toTimeString().slice(0, 8);
    void input.serie;
    void input.correlativo;

    const base = this.buildComprobanteData({
      docNumber: input.docNumber,
      serie: '',
      correlativo: 0,
      invoiceType: '07',
      taxableAmount: input.taxableAmount,
      taxAmount: input.taxAmount,
      total: input.total,
      customer: {
        documentNumber: input.customerDocNumber,
        fullName: input.customerName,
        businessName: input.customerName,
        address: '',
      },
      customerDocType: input.customerDocType,
      details: [
        {
          description: `Anulación: ${input.affectedDocNumber}`,
          quantity: 1,
          unitPrice: input.total,
          subtotal: input.total,
        },
      ],
    });

    base.references = {
      discrepancyResponse: {
        referenceId: input.affectedDocNumber,
        responseCode: '01', // Anulación de la operación
        description: input.reason,
      },
      billingReference: {
        id: input.affectedDocNumber,
        documentTypeCode: input.affectedInvoiceType,
      },
    };

    base.cabecera.invoiceTypeCode = '07';
    base.cabecera.invoiceTypeCodeAttrs = {
      listAgencyName: 'PE:SUNAT',
      listName: 'Tipo de Documento',
      listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01',
      listID: TIPO_OPERACION_VENTA_INTERNA,
      name: 'Tipo de Operacion',
    };

    return base;
  }
}
