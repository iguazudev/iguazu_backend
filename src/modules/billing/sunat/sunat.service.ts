import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { BillingConfig } from '../billing.config';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
});

export interface SunatResult {
  cdrBase64: string;
}

export interface SunatFaultError {
  sunatCode: string;
  faultcode: string;
  faultstring: string;
  message: string;
}

type SunatDebug = Record<string, unknown>;

function parseSoapBody(xmlLike: string): any | null {
  if (!xmlLike || typeof xmlLike !== 'string') return null;
  try {
    const parsed = parser.parse(xmlLike);
    return parsed?.Envelope?.Body ?? null;
  } catch {
    return null;
  }
}

function buildSoapEnvelope(nombreZip: string, zipBase64: string): string {
  return `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:ser="http://service.sunat.gob.pe">
      <soapenv:Header/>
      <soapenv:Body>
        <ser:sendBill>
          <fileName>${nombreZip}.zip</fileName>
          <contentFile>${zipBase64}</contentFile>
        </ser:sendBill>
      </soapenv:Body>
    </soapenv:Envelope>
  `;
}

function buildFaultError(body: any, status: number, statusText: string): SunatFaultError {
  const { faultcode, faultstring } = body?.Fault || {};
  const rawFaultcode = faultcode || 'SIN_CODIGO';
  const rawFaultstring = faultstring || 'SIN_DESCRIPCION';
  const codeMatch =
    /Client[.:]?\s*(\d+)/i.exec(rawFaultcode) ||
    /Client\s*-\s*(\d+)/i.exec(rawFaultcode);
  const parsedCode = codeMatch?.[1] || 'SIN_CODIGO';
  return {
    sunatCode: parsedCode,
    faultcode: rawFaultcode,
    faultstring: rawFaultstring,
    message: `SUNAT devolvio un error: ${rawFaultcode} - ${rawFaultstring}`,
  };
}

@Injectable()
export class SunatService {
  constructor(private readonly config: BillingConfig) {}

  /**
   * Envía el ZIP firmado a SUNAT (operación sendBill) y devuelve el CDR en base64.
   * Lanza un error estructurado si SUNAT rechaza (Fault) o hay fallo de red.
   */
  async sendBill(zipBase64: string, nombreZip: string): Promise<SunatResult> {
    if (!zipBase64) throw new Error('Falta el contenido del ZIP en base64');
    if (!nombreZip) throw new Error('Falta el nombre del ZIP a enviar');

    const soapBody = buildSoapEnvelope(nombreZip, zipBase64);
    const emisor = this.config.emisor;
    const authorizationDecoded = `${emisor.usuario_emisor}:${emisor.clave_emisor}`;
    const authorizationBase64 = Buffer.from(authorizationDecoded).toString('base64');
    const headers = {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'urn:sendBill',
      Authorization: `Basic ${authorizationBase64}`,
    };
    const makeDebug = (input: {
      soapResponse?: string;
      httpStatus?: number;
      httpStatusText?: string;
      sunatFault?: unknown;
    } = {}): SunatDebug => {
      const zip = Buffer.from(zipBase64, 'base64');
      return {
        endpoint: this.config.endpoint,
        usuarioConfigurado: emisor.usuario_emisor,
        passwordLength: emisor.clave_emisor.length,
        authorizationBase64,
        authorizationDecoded,
        nombreZip,
        soapRequest: soapBody,
        soapResponse: input.soapResponse,
        httpStatus: input.httpStatus,
        httpStatusText: input.httpStatusText,
        headersEnviados: headers,
        xmlFileName: `${nombreZip}.xml`,
        zipFileName: `${nombreZip}.zip`,
        zipSizeBytes: zip.length,
        zipSha256: createHash('sha256').update(zip).digest('hex'),
        sunatFault: input.sunatFault,
      };
    };

    let data: string;
    let status: number;
    let statusText: string;

    try {
      ({ data, status, statusText } = await axios.post(
        this.config.endpoint,
        soapBody,
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
        const f = buildFaultError(parsedBody, err?.response?.status, err?.response?.statusText);
        const e = new Error(f.message);
        (e as any).sunatFault = f;
        (e as any).sunatDebug = makeDebug({
          soapResponse: responseData,
          httpStatus: err?.response?.status,
          httpStatusText: err?.response?.statusText,
          sunatFault: f,
        });
        throw e;
      }
      const e = new Error(`No se pudo enviar a SUNAT: ${err.message}`);
      (e as any).sunatDebug = makeDebug({
        soapResponse: responseData,
        httpStatus: err?.response?.status,
        httpStatusText: err?.response?.statusText,
      });
      throw e;
    }

    const body = parseSoapBody(typeof data === 'string' ? data : String(data ?? ''));
    if (!body) {
      const e = new Error(`Respuesta de SUNAT invalida (HTTP ${status})`);
      (e as any).sunatDebug = makeDebug({ soapResponse: data, httpStatus: status, httpStatusText: statusText });
      throw e;
    }
    if (body.Fault) {
      const f = buildFaultError(body, status, statusText);
      const e = new Error(f.message);
      (e as any).sunatFault = f;
      (e as any).sunatDebug = makeDebug({ soapResponse: data, httpStatus: status, httpStatusText: statusText, sunatFault: f });
      throw e;
    }
    if (Number(status) >= 400) {
      const e = new Error(`SUNAT devolvio HTTP ${status} ${statusText}`);
      (e as any).sunatDebug = makeDebug({ soapResponse: data, httpStatus: status, httpStatusText: statusText });
      throw e;
    }

    const cdrBase64 = body.sendBillResponse?.applicationResponse;
    if (!cdrBase64) {
      const e = new Error('SUNAT no devolvio el CDR esperado');
      (e as any).sunatDebug = makeDebug({ soapResponse: data, httpStatus: status, httpStatusText: statusText });
      throw e;
    }
    return { cdrBase64 };
  }
}
