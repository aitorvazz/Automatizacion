// main.js — Apify SDK v3 + Playwright
// Euskadi: Suministros + Abierto -> tabla #tableExpedientePublicado
// Campos: expediente, fechaPrimeraPublicacion, fechaUltimaPublicacion,
//         tipoContrato, estadoTramitacion, plazoPresentacion,
//         fechaLimitePresentacion, presupuestoSinIva,
//         poderAdjudicador, entidadImpulsora, urlLicitacionElectronica (href)

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function acceptCookies(page) {
    try {
        const btn = page.getByRole('button', { name: /Aceptar|Aceptar todas|Onartu|Aceptar cookies/i });
        if (await btn.count()) await btn.first().click({ timeout: 3000 });
    } catch {}
}

/** Busca selects que contengan una opción por texto y la selecciona */
async function selectByOptionTextAnywhere(page, optionRegex) {
    const selects = page.locator('select');
    const n = await selects.count();
    for (let i = 0; i < n; i++) {
        const sel = selects.nth(i);
        const options = sel.locator('option');
        const m = await options.count();
        let idx = -1;
        for (let j = 0; j < m; j++) {
            const t = (await options.nth(j).textContent())?.trim() || '';
            if (optionRegex.test(t)) { idx = j; break; }
        }
        if (idx >= 0) {
            try {
                await sel.selectOption({ label: optionRegex });
                return true;
            } catch {
                const val = await options.nth(idx).getAttribute('value').catch(() => null);
                if (val) {
                    await sel.selectOption(val).catch(() => {});
                    return true;
                }
            }
        }
    }
    return false;
}

/** Clic en Buscar dentro del contenedor del formulario de filtros */
async function clickSearch(page) {
    // Prioriza botones en el mismo contenedor que los selects
    const formContainer = await (async () => {
        const firstSelect = page.locator('select').first();
        if (await firstSelect.count()) {
            const handle = await firstSelect.elementHandle();
            if (handle) {
                // sube hasta un contenedor tipo form/section
                return page.locator('form:has(select), section:has(select), div:has(select)').first();
            }
        }
        return page.locator('body');
    })();

    const candidates = [
        formContainer.getByRole('button', { name: /Buscar|Filtrar|Bilatu|Aplicar/i }),
        formContainer.locator('input[type="submit"][value*="Buscar" i]'),
        formContainer.locator('input[type="submit"][value*="Bilatu" i]'),
    ];
    for (const c of candidates) {
        if (await c.count()) {
            await c.first().click();
            await page.waitForLoadState('networkidle');
            return true;
        }
    }
    return false;
}

/** Espera a que la tabla principal esté cargada y con filas (o confirme 0) */
async function waitForTableReady(page, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const infoTxt = (await page.locator('#tableExpedientePublicado_info').innerText().catch(() => '')) || '';
        const rows = await page.locator('#tableExpedientePublicado tbody tr').count().catch(() => 0);
        if (rows > 0) return { rows, infoTxt };
        if (/Mostrando 0.*de 0/i.test(infoTxt)) return { rows: 0, infoTxt };
        await page.waitForTimeout(300);
    }
    const rows = await page.locator('#tableExpedientePublicado tbody tr').count().catch(() => 0);
    const infoTxt = (await page.locator('#tableExpedientePublicado_info').innerText().catch(() => '')) || '';
    return { rows, infoTxt };
}

/** Obtiene link de expediente en la fila (si existe) */
async function getExpedienteLinkFromRow(row, pageUrl) {
    // Suele estar en la primera columna; si no, toma el primer <a> de la fila
    const a = row.locator('td a[href]').first();
    if (await a.count()) {
        const href = await a.getAttribute('href').catch(() => null);
        if (href && href !== '#' && !/^javascript:/i.test(href)) {
            try { return new URL(href, pageUrl).href; } catch {}
        }
    }
    return null;
}

/** Lee celdas por encabezados cuando haya <th> en THEAD */
async function mapRowByHeaders(page, row) {
    const headers = [];
    const ths = page.locator('#tableExpedientePublicado thead th');
    const hCount = await ths.count();
    for (let i = 0; i < hCount; i++) {
        const h = (await ths.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        headers.push(h);
    }
    const cells = row.locator('td');
    const cCount = await cells.count();
    const obj = {};
    for (let i = 0; i < Math.min(hCount, cCount); i++) {
        const key = headers[i] || `col_${i}`;
        const val = (await cells.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        obj[key] = val;
    }
    return obj;
}

/** Helpers de extracción por etiqueta dentro de la ficha */
async function getValueByLabel(page, labelRegex) {
    const rows = page.locator('table tr');
    for (let i = 0, n = await rows.count(); i < n; i++) {
        const row = rows.nth(i);
        const th = row.locator('th, td strong, td b').first();
        const label = (await th.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (label && labelRegex.test(label)) {
            const valCell = row.locator('td').last();
            const valTxt = (await valCell.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (valTxt) return valTxt;
        }
    }
    const dts = page.locator('dt');
    for (let i = 0, n = await dts.count(); i < n; i++) {
        const dt = dts.nth(i);
        const t = (await dt.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (t && labelRegex.test(t)) {
            const dd = dt.locator('xpath=following-sibling::dd[1]');
            const val = (await dd.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (val) return val;
        }
    }
    const blocks = page.locator('p, div, li');
    for (let i = 0, n = await blocks.count(); i < n; i++) {
        const el = blocks.nth(i);
        const txt = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (txt && labelRegex.test(txt)) {
            const parts = txt.split(':');
            if (parts.length > 1) return parts.slice(1).join(':').trim();
            return txt.replace(labelRegex, '').trim();
        }
    }
    return '';
}

async function getLinkHrefByLabel(page, labelRegex) {
    const rows = page.locator('table tr');
    for (let i = 0, n = await rows.count(); i < n; i++) {
        const row = rows.nth(i);
        const th = row.locator('th, td strong, td b').first();
        const label = (await th.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (label && labelRegex.test(label)) {
            const link = row.locator('a[href]').first();
            const href = await link.getAttribute('href').catch(() => null);
            if (href) return new URL(href, page.url()).href;
        }
    }
    const dts = page.locator('dt');
    for (let i = 0, n = await dts.count(); i < n; i++) {
        const dt = dts.nth(i);
        const t = (await dt.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (t && labelRegex.test(t)) {
            const dd = dt.locator('xpath=following-sibling::dd[1]');
            const link = dd.locator('a[href]').first();
            const href = await link.getAttribute('href').catch(() => null);
            if (href) return new URL(href, page.url()).href;
        }
    }
    const blocks = page.locator('p, div, li');
    for (let i = 0, n = await blocks.count(); i < n; i++) {
        const el = blocks.nth(i);
        const txt = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (txt && labelRegex.test(txt)) {
            const link = el.locator('a[href]').first();
            const href = await link.getAttribute('href').catch(() => null);
            if (href) return new URL(href, page.url()).href;
        }
    }
    return '';
}

/** Extrae SOLO los campos relevantes desde la ficha */
async function extractFieldsFromDetail(page) {
    return {
        expediente: await getValueByLabel(page, /Expediente/i),
        fechaPrimeraPublicacion: await getValueByLabel(page, /Fecha primera publicaci[oó]n/i),
        fechaUltimaPublicacion: await getValueByLabel(page, /Fecha [uú]ltima publicaci[oó]n/i),
        tipoContrato: await getValueByLabel(page, /Tipo de contrato/i),
        estadoTramitacion: await getValueByLabel(page, /Estado de la tramitaci[oó]n|Estado/i),
        plazoPresentacion: await getValueByLabel(page, /Plazo de presentaci[oó]n/i),
        fechaLimitePresentacion: await getValueByLabel(page, /Fecha l[ií]mite.*presentaci[oó]n/i),
        presupuestoSinIva: await getValueByLabel(page, /Presupuesto.*sin.*IVA|Presupuesto del contrato sin IVA/i),
        poderAdjudicador: await getValueByLabel(page, /Poder adjudicador/i),
        entidadImpulsora: await getValueByLabel(page, /Entidad impulsora/i),
        urlLicitacionElectronica: await getLinkHrefByLabel(page, /Direcci[oó]n web de licitaci[oó]n electr[oó]nica|Licitaci[oó]n electr[oó]nica/i),
        urlFicha: page.url(),
    };
}

/** Itera filas de la tabla principal y saca datos; entra a detalle si hace falta */
async function scrapeCurrentTablePage(page, context) {
    const rows = page.locator('#tableExpedientePublicado tbody tr');
    const count = await rows.count();
    let total = 0;

    for (let i = 0; i < count; i++) {
        const row = rows.nth(i);
        // Intenta mapear por cabeceras (por si Expediente/Fechas están en listado)
        const rowObj = await mapRowByHeaders(page, row);

        // Intenta link a ficha
        const href = await getExpedienteLinkFromRow(row, page.url());
        let data;

        if (href) {
            // Abrir ficha en nueva pestaña
            try {
                const detail = await context.newPage();
                await detail.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await acceptCookies(detail);
                await detail.waitForLoadState('networkidle').catch(() => {});
                data = await extractFieldsFromDetail(detail);
                await detail.close();
            } catch (err) {
                log.warning(`Detalle KO: ${href} :: ${err?.message || err}`);
                continue;
            }
        } else {
            // Sin link claro: intenta extraer del propio listado (best-effort)
            data = {
                expediente: rowObj['Expediente'] || rowObj['expediente'] || '',
                fechaPrimeraPublicacion: rowObj['Fecha primera publicación'] || '',
                fechaUltimaPublicacion: rowObj['Fecha última publicación'] || '',
                tipoContrato: rowObj['Tipo de contrato'] || '',
                estadoTramitacion: rowObj['Estado de la tramitación'] || '',
                plazoPresentacion: rowObj['Plazo de presentación'] || '',
                fechaLimitePresentacion: rowObj['Fecha límite de presentación'] || '',
                presupuestoSinIva: rowObj['Presupuesto del contrato sin IVA'] || '',
                poderAdjudicador: rowObj['Poder adjudicador'] || '',
                entidadImpulsora: rowObj['Entidad impulsora'] || '',
                urlLicitacionElectronica: '', // normalmente solo está en ficha
                urlFicha: '',
            };
        }

        // Fallback: si desde ficha faltan campos, rellena con listado cuando haya
        const merged = {
            expediente: data.expediente || rowObj['Expediente'] || '',
            fechaPrimeraPublicacion: data.fechaPrimeraPublicacion || rowObj['Fecha primera publicación'] || '',
            fechaUltimaPublicacion: data.fechaUltimaPublicacion || rowObj['Fecha última publicación'] || '',
            tipoContrato: data.tipoContrato || rowObj['Tipo de contrato'] || '',
            estadoTramitacion: data.estadoTramitacion || rowObj['Estado de la tramitación'] || '',
            plazoPresentacion: data.plazoPresentacion || rowObj['Plazo de presentación'] || '',
            fechaLimitePresentacion: data.fechaLimitePresentacion || rowObj['Fecha límite de presentación'] || '',
            presupuestoSinIva: data.presupuestoSinIva || rowObj['Presupuesto del contrato sin IVA'] || '',
            poderAdjudicador: data.poderAdjudicador || rowObj['Poder adjudicador'] || '',
            entidadImpulsora: data.entidadImpulsora || rowObj['Entidad impulsora'] || '',
            urlLicitacionElectronica: data.urlLicitacionElectronica || '',
            urlFicha: data.urlFicha || href || '',
        };

        await Actor.pushData(merged);
        total += 1;
        await sleep(120 + Math.random() * 200);
    }

    return total;
}

/** Pasa a la siguiente página del DataTable principal */
async function gotoNextTablePage(page) {
    const nextWrap = page.locator('#tableExpedientePublicado_next');
    if (!(await nextWrap.count())) return false;
    const isDisabled = /disabled/i.test((await nextWrap.getAttribute('class').catch(() => '')) || '');
    if (isDisabled) return false;
    const nextLink = nextWrap.locator('a');
    if (!(await nextLink.count())) return false;
    await nextLink.first().click();
    // Espera a que cambien las filas (observa la primera celda)
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(300);
    return true;
}

await Actor.main(async () => {
    const input = await Actor.getInput();
    const maxPages = Number(input?.maxPages ?? 5);
    const headless = input?.headless !== undefined ? !!input.headless : true;

    log.info(`Inicio -> ${BASE_URL}`);
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36 ApifyPlaywright',
    });
    const page = await context.newPage();

    try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await acceptCookies(page);

        // Aplicar filtros por interacción real
        const okTipo = await selectByOptionTextAnywhere(page, /Suministros/i);
        const okEstado = await selectByOptionTextAnywhere(page, /Abierto/i);
        if (!okTipo) log.warning('No se pudo fijar Tipo de contrato = Suministros');
        if (!okEstado) log.warning('No se pudo fijar Estado = Abierto');

        const clicked = await clickSearch(page);
        if (!clicked) log.warning('No se pudo hacer clic en Buscar/Filtrar');

        // Esperar a la tabla principal
        const ready = await waitForTableReady(page, 20000);
        log.info(`#tableExpedientePublicado -> ${ready.infoTxt || `filas: ${ready.rows}`}`);
        if (ready.rows === 0) log.warning('Sin filas tras la búsqueda (¿filtros no aplicados o sin resultados?).');

        let total = 0;
        for (let p = 0; p < maxPages; p++) {
            log.info(`Página de tabla ${p + 1}/${maxPages}`);
            const added = await scrapeCurrentTablePage(page, context);
            log.info(` - Registros extraídos en esta página: ${added}`);
            total += added;

            const hasNext = await gotoNextTablePage(page);
            if (!hasNext) {
                log.info('No hay más páginas en la tabla principal.');
                break;
            }
        }

        await browser.close();
        log.info(`Scraping completado. Total al Dataset: ${total}`);
    } catch (err) {
        log.error(`Fallo scraping: ${err?.message || err}`);
        try { await browser.close(); } catch {}
        throw err;
    }
});
