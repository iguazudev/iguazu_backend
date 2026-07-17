/**
 * Diagnóstico directo: consulta el estado REAL de un ticket en SUNAT.
 *
 * Uso (desde backend_iguazu/):
 *   node scripts/diagnose-ticket.js <TICKET>
 *   node scripts/diagnose-ticket.js 202621327752799
 *
 * No toca la base de datos. Solo le pregunta a SUNAT el estado del ticket
 * y te muestra la respuesta SOAP cruda + el CDR descomprimido si lo hay.
 *
 * Lee las credenciales de tu .env (mismo que usa el backend).
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ---------- Cargar .env ----------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('No encontre .env en', envPath);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const TICKET = process.argv[2];
const ENDPOINT = env.SUNAT_ENDPOINT;
const USUARIO = env.SUNAT_USUARIO;
const CLAVE = env.SUNAT_CLAVE;

if (!TICKET) {
  console.error('\n[ERROR] Falta el ticket. Uso: node scripts/diagnose-ticket.js <TICKET>');
  console.error('         Ejemplo: node scripts/diagnose-ticket.js 202621327752799\n');
  process.exit(1);
}

console.log('========================================');
console.log('  DIAGNOSTICO DE TICKET SUNAT');
console.log('========================================');
console.log('Endpoint:', ENDPOINT);
console.log('Usuario :', USUARIO);
console.log('Ticket  :', TICKET);
console.log('----------------------------------------');

// ---------- SOAP con WS-Security (igual que el backend) ----------
const auth = Buffer.from(`${USUARIO}:${CLAVE}`).toString('base64');
const soap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:ser="http://service.sunat.gob.pe"
  xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <soapenv:Header>
    <wsse:Security>
      <wsse:UsernameToken>
        <wsse:Username>${USUARIO}</wsse:Username>
        <wsse:Password>${CLAVE}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <ser:getStatus>
      <ticket>${TICKET}</ticket>
    </ser:getStatus>
  </soapenv:Body>
</soapenv:Envelope>`;

const headers = {
  'Content-Type': 'text/xml; charset=utf-8',
  // SUNAT valida el cuerpo, no el SOAPAction; usamos el mismo que el backend.
  SOAPAction: 'urn:getStatus',
  Authorization: `Basic ${auth}`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(label) {
  console.log(`\n>>> Intento: ${label}`);
  try {
    const res = await axios.post(ENDPOINT, soap, {
      headers,
      validateStatus: () => true,
      timeout: 30000,
    });
    return res;
  } catch (err) {
    return { status: -1, data: `[error de red] ${err.message}` };
  }
}

async function run() {
  // Reintentos para descartar errores transitorios de SUNAT (500).
  let res = await attempt('1/3');
  if (Number(res.status) === 500) {
    console.log('>>> HTTP 500 detectado. Esperando 10s y reintentando (puede ser transitorio)...');
    await sleep(10000);
    res = await attempt('2/3');
  }
  if (Number(res.status) === 500) {
    console.log('>>> Sigue 500. Esperando 10s más...');
    await sleep(10000);
    res = await attempt('3/3');
  }
  processResult(res);
}

function processResult(res) {
    console.log('\n--- HTTP ---');
    console.log('Status:', res.status);

    const body = typeof res.data === 'string' ? res.data : String(res.data);
    console.log('\n--- RESPUESTA SOAP CRUDA ---');
    console.log(body);

    // Parseo ligero para resaltar el statusCode y el content.
    console.log('\n--- INTERPRETACION ---');
    const codeMatch = body.match(/<statusCode[^>]*>([^<]+)<\/statusCode>/);
    const statusCode = codeMatch ? codeMatch[1].trim() : 'NO ENCONTRADO';
    console.log('statusCode:', statusCode);

    if (statusCode === '0') {
      console.log('>>> PROCESADO. El CDR del resumen viene en <content>.');
      const contentMatch = body.match(/<content[^>]*>([^<]+)<\/content>/);
      if (contentMatch) {
        console.log('>>> CDR (base64) presente, length:', contentMatch[1].length);
        try {
          const AdmZip = require('adm-zip');
          const zipBuf = Buffer.from(contentMatch[1], 'base64');
          const zip = new AdmZip(zipBuf);
          const entries = zip.getEntries();
          console.log('>>> Archivos dentro del CDR ZIP:', entries.map((e) => e.entryName).join(', '));
          const xmlEntry = entries.find((e) => e.entryName.endsWith('.xml'));
          if (xmlEntry) {
            const xml = xmlEntry.getData().toString('utf8');
            console.log('\n--- CDR XML (respuesta real de SUNAT) ---');
            console.log(xml);
            // Buscar el ResponseCode y Description del CDR.
            const rc = xml.match(/<cbc:ResponseCode[^>]*>([^<]+)<\/cbc:ResponseCode>/);
            const desc = xml.match(/<cbc:Description[^>]*>([^<]+)<\/cbc:Description>/);
            console.log('\n--- VEREDICTO ---');
            console.log('ResponseCode del CDR:', rc ? rc[1] : 'no encontrado');
            console.log('Description        :', desc ? desc[1] : 'no encontrada');
            if (rc && rc[1] === '0') {
              console.log('\n>>> ACEPTADO POR SUNAT  ✅');
            } else {
              console.log('\n>>> RECHAZADO / OBSERVADO  ❌  (revisar ResponseCode arriba)');
            }
          }
        } catch (e) {
          console.log('>>> No pude descomprimir el CDR:', e.message);
        }
      } else {
        console.log('>>>statusCode=0 pero SIN <content> (raro).');
      }
    } else if (statusCode === '98') {
      console.log('>>> EN PROCESO. SUNAT todavia no termino. Reintentar mas tarde.');
    } else if (statusCode === '99') {
      console.log('>>> PROCESO CON ERRORES. El CDR de rechazo viene en <content>.');
    } else if (body.includes('Fault')) {
      const fault = body.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/);
      console.log('>>> SUNAT devolvio un FAULT (error de autenticacion/datos):');
      console.log('   ', fault ? fault[1] : 'ver XML arriba');
    } else {
      console.log('>>> Respuesta inesperada. Ver el XML crudo arriba.');
    }
    console.log('\n========================================');
  }

run().catch((err) => {
  console.error('\n[ERROR inesperado]', err.message);
  process.exit(1);
});
