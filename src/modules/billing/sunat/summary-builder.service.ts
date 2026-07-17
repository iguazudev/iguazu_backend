import { Injectable } from '@nestjs/common';
import { create } from 'xmlbuilder2';
import { BillingConfig } from '../billing.config';

// Builder del XML del Resumen Diario de Boletas (SummaryDocuments, UBL 2.0 PE).
// El manual del programador (RS 097-2012) NO documenta la estructura interna de este
// documento (la delega a la norma UBL 2.0 PE / Resolución de Superintendencia); aquí se
// usa la estructura estándar aceptada por SUNAT para el envío vía sendSummary.

type XmlNode = ReturnType<typeof create>;

/** Una boleta/nota que se incluye como línea del resumen. */
export interface SummaryLine {
  /** Número de línea dentro del resumen (1-based). */
  lineId: number;
  /** Tipo de comprobante: '03' boleta, '07' nota de crédito sobre boleta. */
  documentTypeCode: string;
  /** Serie sin correlativo, ej: 'B001'. */
  serie: string;
  /** Correlativo sin serie, ej: '00000001'. */
  correlativo: string;
  /** Tipo de documento del cliente (catálogo 06): '1' DNI, '0' sin doc, etc. */
  customerDocType: string;
  /** Número de documento del cliente. */
  customerDocNumber: string;
  /** Base imponible gravada (operaciones onerosas). */
  taxableAmount: string;
  /** IGV. */
  taxAmount: string;
  /** Importe total (gravada + IGV). Puede ser negativo en notas de crédito. */
  totalAmount: string;
  /** Solo notas de crédito: documento que se modifica. */
  affectedDocNumber?: string;
  affectedDocType?: string;
}

export interface SummaryData {
  /** Fecha de referencia (fecha de emisión de las boletas), YYYY-MM-DD. */
  referenceDate: string;
  /** Fecha de generación del resumen, YYYY-MM-DD. */
  issueDate: string;
  /** Correlativo del resumen (parte del ID). */
  correlativo: number;
  lines: SummaryLine[];
}

const SUMMARY_DEFAULT_NS =
  'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1';
const SAC_NS =
  'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1';

@Injectable()
export class SummaryBuilderService {
  constructor(private readonly config: BillingConfig) {}

  /**
   * Construye el XML del Resumen Diario de Boletas (SummaryDocuments).
   * El ID sigue el patrón `RC-YYYYMMDD-CORRELATIVO` que exige SUNAT.
   */
  build(data: SummaryData): string {
    const doc = create({ version: '1.0', encoding: 'utf-8' });
    const root = doc.ele('SummaryDocuments', {
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
      'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
      'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#',
      'xmlns:ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
      'xmlns:sac': SAC_NS,
      xmlns: SUMMARY_DEFAULT_NS,
    });

    // Reservado para la firma XMLDSig (XmlSignerService la insertará aquí).
    root.ele('ext:UBLExtensions').ele('ext:UBLExtension').ele('ext:ExtensionContent').up().up().up();

    const emisor = this.config.emisor;
    const refDateCompact = data.referenceDate.replace(/-/g, '');
    const issueDateCompact = data.issueDate.replace(/-/g, '');

    this.txt(root, 'cbc:UBLVersionID', '2.0');
    this.txt(root, 'cbc:CustomizationID', '1.1');
    this.txt(root, 'cbc:ID', `RC-${refDateCompact}-${data.correlativo}`);
    this.txt(root, 'cbc:ReferenceDate', data.referenceDate);
    this.txt(root, 'cbc:IssueDate', data.issueDate);

    // cac:Signature (referencia a la firma que va en UBLExtensions).
    const signature = root.ele('cac:Signature');
    this.txt(signature, 'cbc:ID', `RC-${refDateCompact}-${data.correlativo}`);
    const signatoryParty = signature.ele('cac:SignatoryParty');
    this.txt(signatoryParty.ele('cac:PartyIdentification'), 'cbc:ID', emisor.ruc);
    this.txt(signatoryParty.ele('cac:PartyName'), 'cbc:Name', emisor.razonSocial);
    this.txt(
      signature.ele('cac:DigitalSignatureAttachment').ele('cac:ExternalReference'),
      'cbc:URI',
      '#SignatureSP',
    );

    // Emisor.
    const supplier = root.ele('cac:AccountingSupplierParty');
    const supplierParty = supplier.ele('cac:Party');
    this.txt(
      supplierParty.ele('cac:PartyIdentification'),
      'cbc:ID',
      emisor.ruc,
      {
        schemeID: '6',
        schemeName: 'Documento de Identidad',
        schemeAgencyName: 'PE:SUNAT',
        schemeURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06',
      },
    );
    this.txt(supplierParty.ele('cac:PartyName'), 'cbc:Name', emisor.razonSocial);
    const supplierLegal = supplierParty.ele('cac:PartyLegalEntity');
    this.txt(supplierLegal, 'cbc:RegistrationName', emisor.razonSocial);

    // Líneas (una por boleta/nota).
    for (const line of data.lines) {
      this.appendLine(root, line, emisor.ruc);
    }

    return root.end({ prettyPrint: true, indent: '    ' });
  }

  private appendLine(root: XmlNode, line: SummaryLine, ruc: string): void {
    const lineNode = root.ele('sac:SummaryDocumentsLine');

    this.txt(lineNode, 'cbc:LineID', String(line.lineId));
    this.txt(lineNode, 'cbc:DocumentTypeCode', line.documentTypeCode);
    this.txt(lineNode, 'cbc:DocumentSerialID', line.serie);
    this.txt(lineNode, 'cbc:DocumentNumberID', line.correlativo);

    // Cliente: en el resumen diario la estructura es plana (CustomerAssignedAccountID +
    // AdditionalAccountID), NO cac:Party como en las facturas.
    const customer = lineNode.ele('sac:AccountingCustomerParty');
    this.txt(customer, 'cbc:CustomerAssignedAccountID', line.customerDocNumber || '-');
    this.txt(customer, 'cbc:AdditionalAccountID', line.customerDocType || '0');

    // Operaciones gravadas (BillingPayment). InstructionID '01' = venta gravada.
    const billingPayment = lineNode.ele('sac:BillingPayment');
    this.txt(billingPayment, 'cbc:PaidAmount', line.taxableAmount, { currencyID: 'PEN' });
    this.txt(billingPayment, 'cbc:InstructionID', '01');

    // TaxTotal con IGV.
    const taxTotal = lineNode.ele('cac:TaxTotal');
    this.txt(taxTotal, 'cbc:TaxAmount', line.taxAmount, { currencyID: 'PEN' });
    const taxSubtotal = taxTotal.ele('cac:TaxSubtotal');
    this.txt(taxSubtotal, 'cbc:TaxAmount', line.taxAmount, { currencyID: 'PEN' });
    const taxCategory = taxSubtotal.ele('cac:TaxCategory');
    const taxScheme = taxCategory.ele('cac:TaxScheme');
    this.txt(taxScheme, 'cbc:ID', '1000');
    this.txt(taxScheme, 'cbc:Name', 'IGV');
    this.txt(taxScheme, 'cbc:TaxTypeCode', 'VAT');

    // Nota de crédito sobre boleta: referencia al documento que modifica.
    if (line.affectedDocNumber && line.affectedDocType) {
      const [affSerie, affCorrelativo] = line.affectedDocNumber.split('-');
      const billingRef = lineNode.ele('cac:BillingReference');
      const docRef = billingRef.ele('cac:InvoiceDocumentReference');
      this.txt(docRef, 'cbc:ID', line.affectedDocNumber);
      this.txt(docRef, 'cbc:DocumentTypeCode', line.affectedDocType);
      void affSerie;
      void affCorrelativo;
    }
  }

  /** Helper: añade un nodo de texto con atributos opcionales. */
  private txt(
    parent: XmlNode,
    name: string,
    value: unknown,
    attrs?: Record<string, string | undefined>,
  ): XmlNode {
    const child = attrs ? parent.ele(name, attrs) : parent.ele(name);
    if (value !== undefined && value !== null && value !== '') {
      child.txt(String(value));
    }
    return child;
  }
}
