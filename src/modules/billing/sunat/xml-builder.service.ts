import { Injectable } from '@nestjs/common';
import { create } from 'xmlbuilder2';

// Porteo fiel de api-rest-s7/src/services/xmlBuilder.js a TypeScript.
// Construye documentos UBL 2.1 (Invoice/CreditNote/DebitNote) para SUNAT.

// xmlbuilder2 no exporta el tipo del builder desde el entry principal;
// lo inferimos del retorno de create().
type XmlNode = ReturnType<typeof create>;

// ============================================================
// Tipos del payload de construcción
// ============================================================
export interface PartyAddress {
  ubigeo?: string;
  addressTypeCode?: string;
  cityName?: string;
  countrySubentity?: string;
  district?: string;
  line?: string;
  countryCode?: string;
}

export interface Party {
  ruc: string;
  documentTypeCode?: string;
  nombreComercial?: string;
  razonSocial?: string;
  address?: PartyAddress;
  contactName?: string;
}

export interface TaxScheme {
  id?: string;
  idAttrs?: Record<string, string | undefined>;
  name?: string;
  taxTypeCode?: string;
}

export interface TaxCategory {
  id?: string;
  idAttrs?: Record<string, string | undefined>;
  percent?: string;
  taxExemptionReasonCode?: string;
  taxExemptionReasonCodeAttrs?: Record<string, string | undefined>;
  perUnitAmount?: string;
  perUnitAmountAttrs?: Record<string, string | undefined>;
  taxScheme?: TaxScheme;
}

export interface TaxSubtotal {
  taxableAmount?: string;
  taxAmount: string;
  currencyID?: string;
  baseUnitMeasure?: string;
  baseUnitMeasureAttrs?: Record<string, string | undefined>;
  taxCategory?: TaxCategory;
}

export interface TaxTotal {
  taxAmount: string;
  currencyID?: string;
  subtotals: TaxSubtotal[];
}

export interface InvoiceLineItem {
  id: string;
  quantity: string;
  unitCode: string;
  unitCodeListID?: string;
  unitCodeListAgencyName?: string;
  lineExtensionAmount: string;
  currencyID?: string;
  pricingReference?: {
    priceAmount: string;
    currencyID?: string;
    priceTypeCode: string;
    priceTypeCodeAttrs?: Record<string, string | undefined>;
  };
  taxTotal: TaxTotal;
  item: {
    description: string;
    sellersItemId: string;
    classificationCode: string;
    classificationAttrs?: Record<string, string | undefined>;
  };
  price: { amount: string; currencyID?: string };
}

export interface ComprobanteData {
  cabecera: {
    ublVersionId: string;
    customizationId: string;
    customizationAgencyName?: string;
    profileId: string;
    profileSchemeName?: string;
    profileSchemeAgencyName?: string;
    profileSchemeURI?: string;
    id: string;
    issueDate: string;
    issueTime: string;
    invoiceTypeCode: string;
    invoiceTypeCodeAttrs?: Record<string, string | undefined>;
    documentCurrencyCode: string;
    documentCurrencyCodeAttrs?: Record<string, string | undefined>;
    lineCountNumeric: string;
  };
  signature: {
    id: string;
    partyId: string;
    partyName: string;
    uri: string;
  };
  emisor: Party;
  cliente: Party;
  paymentTerms?: Array<{
    id: string;
    paymentMeansId: string;
    amount?: string;
    currencyID?: string;
    paymentDueDate?: string;
  }>;
  taxTotal: TaxTotal;
  legalMonetaryTotal: {
    lineExtensionAmount: string;
    taxInclusiveAmount: string;
    payableAmount: string;
    currencyID?: string;
  };
  items: InvoiceLineItem[];
  // Solo para notas:
  references?: {
    discrepancyResponse?: {
      referenceId: string;
      responseCode: string;
      description: string;
    };
    billingReference?: { id: string; documentTypeCode: string };
  };
}

// ============================================================
// Helpers
// ============================================================
type Attrs = Record<string, string | undefined>;

function txt(
  node: XmlNode,
  name: string,
  value: unknown,
  attrs?: Attrs,
): XmlNode {
  const child = attrs ? node.ele(name, attrs) : node.ele(name);
  if (value !== undefined && value !== null && value !== '') {
    child.txt(String(value));
  }
  return child;
}

function cdata(
  node: XmlNode,
  name: string,
  value: unknown,
  attrs?: Attrs,
): XmlNode {
  const child = attrs ? node.ele(name, attrs) : node.ele(name);
  if (value !== undefined && value !== null && value !== '') {
    child.txt(String(value));
  }
  return child;
}

function appendParty(
  parent: XmlNode,
  party: Party,
  includeAddressTypeCode = false,
): XmlNode {
  const partyNode = parent.ele('cac:Party');
  const documentTypeCode = String(party?.documentTypeCode || '6');

  txt(partyNode.ele('cac:PartyIdentification'), 'cbc:ID', party.ruc, {
    schemeID: documentTypeCode,
    schemeName: 'Documento de Identidad',
    schemeAgencyName: 'PE:SUNAT',
    schemeURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06',
  });

  cdata(partyNode.ele('cac:PartyName'), 'cbc:Name', party.nombreComercial);

  const taxScheme = partyNode.ele('cac:PartyTaxScheme');
  cdata(taxScheme, 'cbc:RegistrationName', party.razonSocial);
  txt(taxScheme, 'cbc:CompanyID', party.ruc, {
    schemeID: documentTypeCode,
    schemeName: 'SUNAT:Identificador de Documento de Identidad',
    schemeAgencyName: 'PE:SUNAT',
    schemeURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06',
  });

  txt(taxScheme.ele('cac:TaxScheme'), 'cbc:ID', party.ruc, {
    schemeID: documentTypeCode,
    schemeName: 'SUNAT:Identificador de Documento de Identidad',
    schemeAgencyName: 'PE:SUNAT',
    schemeURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06',
  });

  const legal = partyNode.ele('cac:PartyLegalEntity');
  cdata(legal, 'cbc:RegistrationName', party.razonSocial);

  const hasAddress = Boolean(
    party.address?.ubigeo ||
      party.address?.addressTypeCode ||
      party.address?.cityName ||
      party.address?.countrySubentity ||
      party.address?.district ||
      party.address?.line,
  );
  if (!hasAddress) return partyNode;

  const address = legal.ele('cac:RegistrationAddress');
  txt(address, 'cbc:ID', party.address?.ubigeo, {
    schemeName: 'Ubigeos',
    schemeAgencyName: 'PE:INEI',
  });

  if (includeAddressTypeCode) {
    txt(address, 'cbc:AddressTypeCode', party.address?.addressTypeCode, {
      listAgencyName: 'PE:SUNAT',
      listName: 'Establecimientos anexos',
    });
  }

  cdata(address, 'cbc:CityName', party.address?.cityName);
  cdata(address, 'cbc:CountrySubentity', party.address?.countrySubentity);
  cdata(address, 'cbc:District', party.address?.district);
  cdata(address.ele('cac:AddressLine'), 'cbc:Line', party.address?.line);
  txt(address.ele('cac:Country'), 'cbc:IdentificationCode', party.address?.countryCode, {
    listID: 'ISO 3166-1',
    listAgencyName: 'United Nations Economic Commission for Europe',
    listName: 'Country',
  });

  if (Object.prototype.hasOwnProperty.call(party, 'contactName')) {
    cdata(partyNode.ele('cac:Contact'), 'cbc:Name', party.contactName);
  }

  return partyNode;
}

function appendTaxTotal(parent: XmlNode, taxTotal: TaxTotal): void {
  if (!taxTotal) return;

  const taxTotalNode = parent.ele('cac:TaxTotal');
  txt(taxTotalNode, 'cbc:TaxAmount', taxTotal.taxAmount, {
    currencyID: taxTotal.currencyID || 'PEN',
  });

  for (const subtotal of taxTotal.subtotals || []) {
    const subtotalNode = taxTotalNode.ele('cac:TaxSubtotal');

    if (subtotal.taxableAmount !== undefined) {
      txt(subtotalNode, 'cbc:TaxableAmount', subtotal.taxableAmount, {
        currencyID: subtotal.currencyID || 'PEN',
      });
    }

    txt(subtotalNode, 'cbc:TaxAmount', subtotal.taxAmount, {
      currencyID: subtotal.currencyID || 'PEN',
    });

    if (subtotal.baseUnitMeasure !== undefined) {
      txt(subtotalNode, 'cbc:BaseUnitMeasure', subtotal.baseUnitMeasure, subtotal.baseUnitMeasureAttrs || { unitCode: 'NIU' });
    }

    const category = subtotalNode.ele('cac:TaxCategory');
    if (subtotal.taxCategory?.id !== undefined) {
      txt(category, 'cbc:ID', subtotal.taxCategory.id, subtotal.taxCategory.idAttrs);
    }
    if (subtotal.taxCategory?.percent !== undefined) {
      txt(category, 'cbc:Percent', subtotal.taxCategory.percent);
    }
    if (subtotal.taxCategory?.taxExemptionReasonCode !== undefined) {
      txt(category, 'cbc:TaxExemptionReasonCode', subtotal.taxCategory.taxExemptionReasonCode, subtotal.taxCategory.taxExemptionReasonCodeAttrs);
    }
    if (subtotal.taxCategory?.perUnitAmount !== undefined) {
      txt(category, 'cbc:PerUnitAmount', subtotal.taxCategory.perUnitAmount, subtotal.taxCategory.perUnitAmountAttrs);
    }

    const scheme = category.ele('cac:TaxScheme');
    txt(scheme, 'cbc:ID', subtotal.taxCategory?.taxScheme?.id, subtotal.taxCategory?.taxScheme?.idAttrs);
    txt(scheme, 'cbc:Name', subtotal.taxCategory?.taxScheme?.name);
    txt(scheme, 'cbc:TaxTypeCode', subtotal.taxCategory?.taxScheme?.taxTypeCode);
  }
}

function appendDocumentLine(
  parent: XmlNode,
  item: InvoiceLineItem,
  opts: { lineTag: string; quantityTag: string },
): void {
  const line = parent.ele(opts.lineTag);
  txt(line, 'cbc:ID', item.id);
  txt(line, opts.quantityTag, item.quantity, { unitCode: item.unitCode });
  txt(line, 'cbc:LineExtensionAmount', item.lineExtensionAmount, {
    currencyID: item.currencyID || 'PEN',
  });

  if (item.pricingReference) {
    const ref = line.ele('cac:PricingReference').ele('cac:AlternativeConditionPrice');
    txt(ref, 'cbc:PriceAmount', item.pricingReference.priceAmount, {
      currencyID: item.pricingReference.currencyID || item.currencyID || 'PEN',
    });
    txt(ref, 'cbc:PriceTypeCode', item.pricingReference.priceTypeCode, item.pricingReference.priceTypeCodeAttrs);
  }

  appendTaxTotal(line, item.taxTotal);

  const itemNode = line.ele('cac:Item');
  cdata(itemNode, 'cbc:Description', item.item.description);
  cdata(itemNode.ele('cac:SellersItemIdentification'), 'cbc:ID', item.item.sellersItemId);
  txt(itemNode.ele('cac:CommodityClassification'), 'cbc:ItemClassificationCode', item.item.classificationCode, item.item.classificationAttrs);

  txt(line.ele('cac:Price'), 'cbc:PriceAmount', item.price.amount, {
    currencyID: item.price.currencyID || item.currencyID || 'PEN',
  });
}

function createRootNode(doc: XmlNode, rootName: string, defaultNamespace: string): XmlNode {
  return doc.ele(rootName, {
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
    'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
    'xmlns:ccts': 'urn:un:unece:uncefact:documentation:2',
    'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#',
    'xmlns:ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
    'xmlns:qdt': 'urn:oasis:names:specification:ubl:schema:xsd:QualifiedDatatypes-2',
    'xmlns:udt': 'urn:un:unece:uncefact:data:specification:UnqualifiedDataTypesSchemaModule:2',
    xmlns: defaultNamespace,
  });
}

function appendUblExtension(root: XmlNode): void {
  root.ele('ext:UBLExtensions').ele('ext:UBLExtension').ele('ext:ExtensionContent').up().up().up();
}

function appendSignature(root: XmlNode, signature: ComprobanteData['signature']): void {
  const signatureNode = root.ele('cac:Signature');
  txt(signatureNode, 'cbc:ID', signature.id);
  const signatoryParty = signatureNode.ele('cac:SignatoryParty');
  txt(signatoryParty.ele('cac:PartyIdentification'), 'cbc:ID', signature.partyId);
  cdata(signatoryParty.ele('cac:PartyName'), 'cbc:Name', signature.partyName);
  txt(signatureNode.ele('cac:DigitalSignatureAttachment').ele('cac:ExternalReference'), 'cbc:URI', signature.uri);
}

function appendReferences(root: XmlNode, references: NonNullable<ComprobanteData['references']>): void {
  const dr = references.discrepancyResponse;
  if (dr) {
    const node = root.ele('cac:DiscrepancyResponse');
    txt(node, 'cbc:ReferenceID', dr.referenceId);
    txt(node, 'cbc:ResponseCode', dr.responseCode);
    cdata(node, 'cbc:Description', dr.description);
  }
  const billingRef = references.billingReference;
  if (billingRef) {
    const node = root.ele('cac:BillingReference').ele('cac:InvoiceDocumentReference');
    txt(node, 'cbc:ID', billingRef.id);
    txt(node, 'cbc:DocumentTypeCode', billingRef.documentTypeCode);
  }
}

function appendCommonParties(root: XmlNode, data: ComprobanteData): void {
  appendSignature(root, data.signature);
  appendParty(root.ele('cac:AccountingSupplierParty'), data.emisor, true);
  appendParty(root.ele('cac:AccountingCustomerParty'), data.cliente, false);
}

// ============================================================
// Servicio
// ============================================================
@Injectable()
export class XmlBuilderService {
  /**
   * Construye un comprobante tipo Invoice (factura 01 / boleta 03).
   */
  buildInvoice(data: ComprobanteData): string {
    const doc = create({ version: '1.0', encoding: 'utf-8' });
    const root = createRootNode(doc, 'Invoice', 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');

    appendUblExtension(root);

    txt(root, 'cbc:UBLVersionID', data.cabecera.ublVersionId);
    txt(root, 'cbc:CustomizationID', data.cabecera.customizationId, {
      schemeAgencyName: data.cabecera.customizationAgencyName,
    });
    txt(root, 'cbc:ProfileID', data.cabecera.profileId, {
      schemeName: data.cabecera.profileSchemeName,
      schemeAgencyName: data.cabecera.profileSchemeAgencyName,
      schemeURI: data.cabecera.profileSchemeURI,
    });
    txt(root, 'cbc:ID', data.cabecera.id);
    txt(root, 'cbc:IssueDate', data.cabecera.issueDate);
    txt(root, 'cbc:IssueTime', data.cabecera.issueTime);
    txt(root, 'cbc:InvoiceTypeCode', data.cabecera.invoiceTypeCode, data.cabecera.invoiceTypeCodeAttrs);
    txt(root, 'cbc:DocumentCurrencyCode', data.cabecera.documentCurrencyCode, data.cabecera.documentCurrencyCodeAttrs);
    txt(root, 'cbc:LineCountNumeric', data.cabecera.lineCountNumeric);

    appendCommonParties(root, data);

    for (const term of data.paymentTerms || []) {
      const node = root.ele('cac:PaymentTerms');
      txt(node, 'cbc:ID', term.id);
      txt(node, 'cbc:PaymentMeansID', term.paymentMeansId);
      if (term.amount !== undefined && term.amount !== null && term.amount !== '') {
        txt(node, 'cbc:Amount', term.amount, { currencyID: term.currencyID || 'PEN' });
      }
      if (term.paymentDueDate !== undefined) {
        txt(node, 'cbc:PaymentDueDate', term.paymentDueDate);
      }
    }

    appendTaxTotal(root, data.taxTotal);

    const legal = root.ele('cac:LegalMonetaryTotal');
    txt(legal, 'cbc:LineExtensionAmount', data.legalMonetaryTotal.lineExtensionAmount, {
      currencyID: data.legalMonetaryTotal.currencyID || 'PEN',
    });
    txt(legal, 'cbc:TaxInclusiveAmount', data.legalMonetaryTotal.taxInclusiveAmount, {
      currencyID: data.legalMonetaryTotal.currencyID || 'PEN',
    });
    txt(legal, 'cbc:PayableAmount', data.legalMonetaryTotal.payableAmount, {
      currencyID: data.legalMonetaryTotal.currencyID || 'PEN',
    });

    for (const item of data.items || []) {
      appendDocumentLine(root, item, { lineTag: 'cac:InvoiceLine', quantityTag: 'cbc:InvoicedQuantity' });
    }

    return root.end({ prettyPrint: true, indent: '    ' });
  }

  /**
   * Construye una nota de crédito (07). Usa CreditNote como raíz.
   */
  buildCreditNote(data: ComprobanteData): string {
    const doc = create({ version: '1.0', encoding: 'utf-8' });
    const root = createRootNode(doc, 'CreditNote', 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2');

    appendUblExtension(root);

    txt(root, 'cbc:UBLVersionID', data.cabecera.ublVersionId);
    txt(root, 'cbc:CustomizationID', data.cabecera.customizationId, {
      schemeAgencyName: data.cabecera.customizationAgencyName,
    });
    txt(root, 'cbc:ProfileID', data.cabecera.profileId);
    txt(root, 'cbc:ID', data.cabecera.id);
    txt(root, 'cbc:IssueDate', data.cabecera.issueDate);
    txt(root, 'cbc:IssueTime', data.cabecera.issueTime);
    // En CreditNote el tag se llama CreditNoteTypeCode
    txt(root, 'cbc:CreditNoteTypeCode', data.cabecera.invoiceTypeCode, data.cabecera.invoiceTypeCodeAttrs);
    txt(root, 'cbc:DocumentCurrencyCode', data.cabecera.documentCurrencyCode, data.cabecera.documentCurrencyCodeAttrs);
    txt(root, 'cbc:LineCountNumeric', data.cabecera.lineCountNumeric);

    if (data.references) {
      appendReferences(root, data.references);
    }

    appendCommonParties(root, data);

    appendTaxTotal(root, data.taxTotal);

    const legal = root.ele('cac:LegalMonetaryTotal');
    txt(legal, 'cbc:LineExtensionAmount', data.legalMonetaryTotal.lineExtensionAmount, {
      currencyID: data.legalMonetaryTotal.currencyID || 'PEN',
    });
    txt(legal, 'cbc:TaxInclusiveAmount', data.legalMonetaryTotal.taxInclusiveAmount, {
      currencyID: data.legalMonetaryTotal.currencyID || 'PEN',
    });
    txt(legal, 'cbc:PayableAmount', data.legalMonetaryTotal.payableAmount, {
      currencyID: data.legalMonetaryTotal.currencyID || 'PEN',
    });

    for (const item of data.items || []) {
      appendDocumentLine(root, item, { lineTag: 'cac:CreditNoteLine', quantityTag: 'cbc:CreditedQuantity' });
    }

    return root.end({ prettyPrint: true, indent: '    ' });
  }
}
