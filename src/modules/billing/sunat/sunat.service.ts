import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { BillingConfig } from '../billing.config';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
});

// Namespace de WS-Security (OASIS) exigido por SUNAT (manual RS 097-2012, sec. 2.2).
const WSSE_NS =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const SER_NS = 'http://service.sunat.gob.pe';

export interface SunatResult {
  cdrBase64: string;
}

export interface SunatSummaryResult {
  ticket: string;
}

/** Estados que devuelve getStatus (manual, pág. 20). */
export type GetStatusCode = '0' | '98' | '99';

export interface SunatStatusResult {
  /** '0' = procesado (CDR disponible), '98' = en proceso, '99' = error (CDR de rechazo). */
  statusCode: GetStatusCode;
  /** CDR del resumen en base64 (solo cuando statusCode !== '98'). */
  cdrBase64: string | null;
}

export interface SunatFaultError {
  sunatCode: string;
  faultcode: string;
  faultstring: string;
  message: string;
}

type SunatDebug = Record<string, unknown>;

/** ZIP + SOAP que viajaron, para trazabilidad. No incluye secretos en claro. */
interface RequestEnvelope {
  soapRequest: string;
  zipBase64?: string;
  nombreZip?: string;
}

function parseSoapBody(xmlLike: string): any | null {
  if (!xmlLike || typeof xmlLike !== 'string') return null;
  try {
    const parsed = parser.parse(xmlLike);
    return parsed?.Envelope?.Body ?? null;
  } catch {
    return null;
  }
}

/**
 * Construye el envelope SOAP con WS-Security UsernameToken en el Header.
 * El manual (pág. 13) exige el modelo UsernameToken con RUC+usuario en <wsse:Username>
 * y la clave SOL en <wsse:Password>.
 */
function buildSoapEnvelope(
  method: 'sendBill' | 'sendSummary' | 'getStatus',
  usuario: string,
  clave: string,
  bodyInner: string,
): string {
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:ser="${SER_NS}"
    xmlns:wsse="${WSSE_NS}">
  <soapenv:Header>
    <wsse:Security>
      <wsse:UsernameToken>
        <wsse:Username>${escapeXml(usuario)}</wsse:Username>
        <wsse:Password>${escapeXml(clave)}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <ser:${method}>
      ${bodyInner}
    </ser:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function escapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Cuerpos SOAP para cada operación. */
const buildSendBillBody = (nombreZip: string, zipBase64: string) =>
  `<fileName>${nombreZip}.zip</fileName><contentFile>${zipBase64}</contentFile>`;

const buildSendSummaryBody = (nombreZip: string, zipBase64: string) =>
  `<fileName>${nombreZip}.zip</fileName><contentFile>${zipBase64}</contentFile>`;

const buildGetStatusBody = (ticket: string) =>
  `<ticket>${escapeXml(ticket)}</ticket>`;

function buildFaultError(
  body: any,
  status: number,
  statusText: string,
): SunatFaultError {
  const { faultcode, faultstring } = body?.Fault || {};
  const rawFaultcode = faultcode || 'SIN_CODIGO';
  const rawFaultstring = faultstring || 'SIN_DESCRIPCION';
  const codeMatch =
    /(\d{4})/.exec(rawFaultcode) ||
    /Client[.:]?\s*(\d+)/i.exec(rawFaultcode) ||
    /Client\s*-\s*(\d+)/i.exec(rawFaultcode);
  const parsedCode = codeMatch?.[1] || 'SIN_CODIGO';
  void status;
  void statusText;
  return {
    sunatCode: parsedCode,
    faultcode: rawFaultcode,
    faultstring: rawFaultstring,
    message: `SUNAT devolvio un error: ${rawFaultcode} - ${rawFaultstring}`,
  };
}

/** Convierte un error de SUNAT (Fault en body o fallo de red) en una excepción con debug. */
function toFaultThrow(
  body: any,
  responseData: string,
  httpStatus: number | undefined,
  httpStatusText: string | undefined,
  env: RequestEnvelope,
  makeDebug: (input: Partial<DebugInput>) => SunatDebug,
): Error {
  if (body?.Fault) {
    const f = buildFaultError(body, httpStatus ?? 0, httpStatusText ?? '');
    const e = new Error(f.message);
    (e as any).sunatFault = f;
    (e as any).sunatDebug = makeDebug({
      soapResponse: responseData,
      httpStatus,
      httpStatusText,
      sunatFault: f,
      env,
    });
    return e;
  }
  const e = new Error(
    `No se pudo procesar la respuesta de SUNAT (HTTP ${httpStatus})`,
  );
  (e as any).sunatDebug = makeDebug({
    soapResponse: responseData,
    httpStatus,
    httpStatusText,
    env,
  });
  return e;
}

interface DebugInput {
  soapResponse?: string;
  httpStatus?: number;
  httpStatusText?: string;
  sunatFault?: unknown;
  env?: RequestEnvelope;
  soapAction?: string;
}

@Injectable()
export class SunatService {
  private readonly logger = new Logger(SunatService.name);

  constructor(private readonly config: BillingConfig) {}

  /**
   * Envía el ZIP firmado a SUNAT (operación sendBill, síncrona).
   * Devuelve el CDR en base64. Lanza error estructurado si SUNAT rechaza.
   * Se usa para facturas (01), notas de crédito (07) y notas de débito (08).
   */
  async sendBill(zipBase64: string, nombreZip: string): Promise<SunatResult> {
    if (!zipBase64) throw new Error('Falta el contenido del ZIP en base64');
    if (!nombreZip) throw new Error('Falta el nombre del ZIP a enviar');

    const soapBody = buildSendBillBody(nombreZip, zipBase64);
    const soapRequest = this.buildEnvelope('sendBill', soapBody);
    const body = await this.call(soapRequest, {
      soapRequest,
      zipBase64,
      nombreZip,
    });

    const cdrBase64 = body.sendBillResponse?.applicationResponse;
    if (!cdrBase64) {
      throw toFaultThrow(
        body,
        '<sin applicationResponse>',
        200,
        'CDR ausente',
        { soapRequest, zipBase64, nombreZip },
        this.makeDebug.bind(this),
      );
    }
    return { cdrBase64 };
  }

  /**
   * Envía un ZIP con un documento de resumen (Resumen Diario de Boletas o
   * Comunicación de Baja). Devuelve un ticket para consultar con getStatus.
   * Operación asíncrona (manual, sec. 2.5).
   */
  async sendSummary(
    zipBase64: string,
    nombreZip: string,
  ): Promise<SunatSummaryResult> {
    if (!zipBase64) throw new Error('Falta el contenido del ZIP en base64');
    if (!nombreZip) throw new Error('Falta el nombre del ZIP a enviar');

    const soapBody = buildSendSummaryBody(nombreZip, zipBase64);
    const soapRequest = this.buildEnvelope('sendSummary', soapBody);
    const body = await this.call(soapRequest, {
      soapRequest,
      zipBase64,
      nombreZip,
    });

    const ticket = body.sendSummaryResponse?.ticket;
    if (!ticket) {
      throw toFaultThrow(
        body,
        '<sin ticket>',
        200,
        'Ticket ausente',
        { soapRequest, zipBase64, nombreZip },
        this.makeDebug.bind(this),
      );
    }
    return { ticket: String(ticket) };
  }

  /**
   * Consulta el estado de un ticket devuelto por sendSummary/sendPack.
   * statusCode: '0' procesado, '98' en proceso, '99' con errores.
   * Cuando hay CDR (statusCode 0 o 99) se devuelve en cdrBase64.
   */
  async getStatus(ticket: string): Promise<SunatStatusResult> {
    if (!ticket) throw new Error('Falta el ticket a consultar');

    const soapBody = buildGetStatusBody(ticket);
    const soapRequest = this.buildEnvelope('getStatus', soapBody);
    const body = await this.call(soapRequest, { soapRequest });

    const status = body.getStatusResponse?.status;
    const statusCode = String(status?.statusCode ?? '');
    if (!['0', '98', '99'].includes(statusCode)) {
      throw toFaultThrow(
        body,
        `<statusCode inesperado: ${statusCode}>`,
        200,
        'statusCode invalido',
        { soapRequest },
        this.makeDebug.bind(this),
      );
    }
    const content = status?.content;
    return {
      statusCode: statusCode as GetStatusCode,
      cdrBase64: content ? String(content) : null,
    };
  }

  // ============================================================
  // Privados
  // ============================================================

  private buildEnvelope(
    method: 'sendBill' | 'sendSummary' | 'getStatus',
    bodyInner: string,
  ): string {
    return buildSoapEnvelope(
      method,
      this.config.usuario,
      this.config.clave,
      bodyInner,
    );
  }

  /** Detecta el método SOAP del envelope para asignar el SOAPAction correcto. */
  private resolveSoapAction(soapRequest: string): string {
    if (/<ser:getStatus[\s>]/.test(soapRequest)) return 'urn:getStatus';
    if (/<ser:sendSummary[\s>]/.test(soapRequest)) return 'urn:sendSummary';
    return 'urn:sendBill';
  }

  /** POST al endpoint SUNAT y parseo del body SOAP. Lanza con debug si hay Fault o fallo. */
  private async call(soapRequest: string, env: RequestEnvelope): Promise<any> {
    const headers = {
      'Content-Type': 'text/xml; charset=utf-8',
      // SOAPAction debe coincidir con el método invocado dentro del body.
      SOAPAction: this.resolveSoapAction(soapRequest),
      Authorization: `Basic ${this.authorizationBase64}`,
    };

    let data: string;
    let status: number;
    let statusText: string;

    try {
      ({ data, status, statusText } = await axios.post(
        this.config.endpoint,
        soapRequest,
        {
          headers,
          validateStatus: () => true,
        },
      ));
    } catch (err: any) {
      const responseData =
        typeof err?.response?.data === 'string'
          ? err.response.data
          : String(err?.response?.data || '');
      const parsedBody = parseSoapBody(responseData);
      if (parsedBody?.Fault) {
        throw toFaultThrow(
          parsedBody,
          responseData,
          err?.response?.status,
          err?.response?.statusText,
          env,
          this.makeDebug.bind(this),
        );
      }
      const e = new Error(`No se pudo enviar a SUNAT: ${err.message}`);
      (e as any).sunatDebug = this.makeDebug({
        soapResponse: responseData,
        httpStatus: err?.response?.status,
        httpStatusText: err?.response?.statusText,
        env,
      });
      throw e;
    }

    const body = parseSoapBody(
      typeof data === 'string' ? data : String(data ?? ''),
    );
    if (!body) {
      throw toFaultThrow(
        { Fault: undefined },
        typeof data === 'string' ? data : String(data ?? ''),
        status,
        statusText,
        env,
        this.makeDebug.bind(this),
      );
    }
    if (body.Fault) {
      throw toFaultThrow(
        body,
        typeof data === 'string' ? data : String(data),
        status,
        statusText,
        env,
        this.makeDebug.bind(this),
      );
    }
    if (Number(status) >= 400) {
      const e = new Error(`SUNAT devolvio HTTP ${status} ${statusText}`);
      (e as any).sunatDebug = this.makeDebug({
        soapResponse: data,
        httpStatus: status,
        httpStatusText: statusText,
        env,
      });
      throw e;
    }
    return body;
  }

  private get authorizationBase64(): string {
    return Buffer.from(`${this.config.usuario}:${this.config.clave}`).toString(
      'base64',
    );
  }

  /**
   * Construye el objeto de debug SIN exponer la clave en claro.
   * authorizationBase64 se enmascara salvo los últimos 4 caracteres.
   */
  private makeDebug(input: Partial<DebugInput>): SunatDebug {
    const env = input.env;
    const zipBase64 = env?.zipBase64;
    const zip = zipBase64 ? Buffer.from(zipBase64, 'base64') : undefined;
    const nombreZip = env?.nombreZip;
    const authB64 = this.authorizationBase64;
    const maskedAuth =
      authB64.length > 4
        ? '*'.repeat(authB64.length - 4) + authB64.slice(-4)
        : '****';

    return {
      endpoint: this.config.endpoint,
      modo: this.config.modo,
      usuarioConfigurado: this.config.usuario,
      passwordLength: this.config.clave.length,
      // Solo se conserva enmascarado; nunca el decoded ni el base64 completo.
      authorizationMasked: maskedAuth,
      ...(nombreZip
        ? {
            nombreZip,
            xmlFileName: `${nombreZip}.xml`,
            zipFileName: `${nombreZip}.zip`,
            zipSizeBytes: zip?.length,
            zipSha256: zip
              ? createHash('sha256').update(zip).digest('hex')
              : undefined,
          }
        : {}),
      soapRequest: env?.soapRequest,
      soapResponse: input.soapResponse,
      httpStatus: input.httpStatus,
      httpStatusText: input.httpStatusText,
      headersEnviados: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction:
          input.soapAction ??
          (env?.soapRequest
            ? this.resolveSoapAction(env.soapRequest)
            : 'urn:sendBill'),
        Authorization: `Basic ${maskedAuth}`,
      },
      sunatFault: input.sunatFault,
    };
  }
}
