'use strict';

/**
 * Servicio de integración con SharePoint via Microsoft Graph API.
 *
 * Reusa la app registration del WF1 de n8n. Variables de entorno:
 *   GRAPH_TENANT_ID
 *   GRAPH_CLIENT_ID
 *   GRAPH_CLIENT_SECRET
 *   SHAREPOINT_SITE_ID         (obligatorio — #colocar credenciales)
 *   SHAREPOINT_ROOT_FOLDER     (con default "Planeación 2026")
 *   SHAREPOINT_TEMPLATE_PATH   (path relativo desde drive root al .xlsx plantilla)
 */

const DEFAULT_SITE_ID = 'COLOCAR_SITE_ID'; // #colocar credenciales (o definir SHAREPOINT_SITE_ID en .env)
const DEFAULT_ROOT = 'Planeación 2026';

let tokenCache = { token: null, expiresAt: 0 };
let driveIdCache = { id: null, fetchedAt: 0 };

function cfg() {
  return {
    tenantId: process.env.GRAPH_TENANT_ID,
    clientId: process.env.GRAPH_CLIENT_ID,
    clientSecret: process.env.GRAPH_CLIENT_SECRET,
    siteId: process.env.SHAREPOINT_SITE_ID || DEFAULT_SITE_ID,
    rootFolder: process.env.SHAREPOINT_ROOT_FOLDER || DEFAULT_ROOT,
    templatePath: process.env.SHAREPOINT_TEMPLATE_PATH,
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.tenantId && c.clientId && c.clientSecret);
}

async function getAccessToken() {
  const c = cfg();
  if (!isConfigured()) {
    // Mismo criterio que POST /:id/sharepoint en employees.js (14 sep 2026):
    // el mensaje que puede llegar a un cliente no nombra las variables de
    // entorno. `.message` sí lo dice (queda en el log del servidor vía
    // console.error('[ERROR]', err) en server.js); `.publicMessage` es lo
    // único que el manejador global de errores expone al cliente
    // (res.json({ error: err.publicMessage || 'Error interno' })), y esta
    // función no lo define a propósito.
    const err = new Error('Microsoft Graph no está configurado. Define GRAPH_TENANT_ID, GRAPH_CLIENT_ID y GRAPH_CLIENT_SECRET en .env');
    err.status = 503;
    throw err;
  }
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 30_000) return tokenCache.token;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const json = await r.json();
  if (!r.ok) {
    const err = new Error(`OAuth fallo: ${json.error_description || json.error || r.status}`);
    err.status = 502;
    throw err;
  }
  tokenCache.token = json.access_token;
  tokenCache.expiresAt = now + (Number(json.expires_in || 3600) * 1000);
  return tokenCache.token;
}

async function graph(path, opts = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`;
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`Graph ${r.status}: ${(body && body.error && body.error.message) || text || 'sin detalle'}`);
    err.status = r.status;
    err.graph = body;
    throw err;
  }
  return body;
}

async function getDriveId() {
  const now = Date.now();
  if (driveIdCache.id && (now - driveIdCache.fetchedAt) < 60 * 60 * 1000) return driveIdCache.id;
  const c = cfg();
  const drive = await graph(`/sites/${c.siteId}/drive`);
  driveIdCache.id = drive.id;
  driveIdCache.fetchedAt = now;
  return drive.id;
}

// Codifica los segmentos de un path para usarlos en URLs de Graph.
// Conserva el separador "/" y solo encodea cada componente.
function encodePath(path) {
  return String(path).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

async function getItemByPath(driveId, path) {
  try {
    return await graph(`/drives/${driveId}/root:/${encodePath(path)}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Crea la carpeta del empleado dentro del proyecto.
 * Devuelve { id, name, webUrl, alreadyExisted: bool }.
 */
async function createEmployeeFolder({ projectFolder, employeeName }) {
  const c = cfg();
  const driveId = await getDriveId();
  const parentPath = `${c.rootFolder}/${projectFolder}`;
  const fullPath = `${parentPath}/${employeeName}`;

  const existing = await getItemByPath(driveId, fullPath);
  if (existing) {
    return { id: existing.id, name: existing.name, webUrl: existing.webUrl, alreadyExisted: true };
  }

  // POST a /drives/{id}/root:/{parent}:/children con conflictBehavior=fail (default)
  const created = await graph(
    `/drives/${driveId}/root:/${encodePath(parentPath)}:/children`,
    {
      method: 'POST',
      body: {
        name: employeeName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      },
    }
  );
  return { id: created.id, name: created.name, webUrl: created.webUrl, alreadyExisted: false };
}

/**
 * Copia el Excel template a la carpeta del empleado con el nombre canónico.
 * Devuelve { id, name, webUrl, alreadyExisted: bool }.
 */
async function copyTemplateForEmployee({ projectFolder, employeeName }) {
  const c = cfg();
  if (!c.templatePath) {
    const err = new Error('Falta SHAREPOINT_TEMPLATE_PATH en .env');
    err.status = 503;
    throw err;
  }
  const driveId = await getDriveId();
  const targetFolderPath = `${c.rootFolder}/${projectFolder}/${employeeName}`;
  const targetFileName = `${employeeName}.xlsx`;
  const targetFilePath = `${targetFolderPath}/${targetFileName}`;

  const existing = await getItemByPath(driveId, targetFilePath);
  if (existing) {
    return { id: existing.id, name: existing.name, webUrl: existing.webUrl, alreadyExisted: true };
  }

  // Resolver template e item de carpeta destino
  const templateItem = await getItemByPath(driveId, c.templatePath);
  if (!templateItem) {
    const err = new Error(`Plantilla no encontrada en SHAREPOINT_TEMPLATE_PATH="${c.templatePath}"`);
    err.status = 404;
    throw err;
  }
  const targetFolder = await getItemByPath(driveId, targetFolderPath);
  if (!targetFolder) {
    const err = new Error(`Carpeta destino no existe: ${targetFolderPath}`);
    err.status = 404;
    throw err;
  }

  // copy es asíncrono — Graph devuelve 202 con Location pollable. Para mantener simple,
  // disparamos y reintentamos resolviendo el item por path (suele estar en <5s).
  await graph(
    `/drives/${driveId}/items/${templateItem.id}/copy`,
    {
      method: 'POST',
      body: {
        parentReference: { driveId, id: targetFolder.id },
        name: targetFileName,
      },
    }
  ).catch((err) => {
    // Graph devuelve 202 Accepted sin body. Nuestro helper lanza si !r.ok pero 202 sí es ok.
    // Si el error viene de un status >= 400 lo relanzamos; el 202 ya pasó.
    if (err.status >= 400) throw err;
  });

  // Poll hasta 12s.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const found = await getItemByPath(driveId, targetFilePath);
    if (found) return { id: found.id, name: found.name, webUrl: found.webUrl, alreadyExisted: false };
  }
  // No falla ruidoso — el copy puede tardar más; reportamos pendiente.
  return { id: null, name: targetFileName, webUrl: null, alreadyExisted: false, pending: true };
}

module.exports = {
  isConfigured,
  cfg,
  getDriveId,
  createEmployeeFolder,
  copyTemplateForEmployee,
};
