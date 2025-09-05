// main.js — Apify SDK v3 + Playwright
// URL: https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es
// Flujo: abrir -> aplicar filtros (Suministros + Abierto) -> Buscar -> paginar -> extraer 11 campos desde el listado

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const START_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- UI helpers ---------------- */
async function acceptCookies(page) {
    try {
        const btn = page.getByRole('button', { name: /Aceptar|Aceptar todas|Onartu|Aceptar cookies/i });
        if (await btn.count()) await btn.first().click({ timeout: 3000 });
    } catch {}
}

async function findSearchForm(page) {
    const candidates = [
        'form:has(select):has(button), form:has(select):has(input[type="submit"])',
        'section:has(select):has(button), div:has(select):has(button)',
    ];
    for (const sel of candidates) {
        const f = page.locator(sel).first();
        if (await f.count()) return f;
    }
    return page.locator('form').first();
}

/** Selecciona una opción por su etiqueta visible en cualquier <select> dentro del form */
async function selectOptionInFormByText(form, optionRegex) {
    const selects = form.locator('select');
    const n = await selects.count();
    for (let i = 0; i < n; i++) {
        const sel = selects.nth(i);
        const opts = sel.locator('option');
        const m = await opts.count();
        for (let j = 0; j < m; j++) {
            const label = ((await opts.nth(j).innerText().catch(() => '')) || '').trim();
            if (!label) continue;
            if (optionRegex.test(label)) {
                const value = await opts.nth(j).getAttribute('value').catch(() => null);
                try {
                    await sel.selectOption({ label });
                    return true;
                } catch {}
                if (value) {
                    await sel.selectOption(value).catch(() => {});
                    return true;
                }
            }
        }
    }
    return false;
}

async function submitSearch(form) {
    const candidates = [
        form.getByRole('button', { name: /Buscar|Bilatu|Filtrar|Aplicar/i }),
        form.locator('input[type="submit"][value*="Buscar" i]'),
        form.locator('input[type="submit"][value*="Bilatu" i]'),
    ];
    for (const c of candidates) {
        if (await c.count()) {
            await c.first().click();
            return true;
        }
    }
    return false;
}

/* ------------- Result-list helpers ------------- */

/** Espera a que el listado principal esté listo (DataTables o bloques dt/dd) */
async function waitResultsReady(page, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const infoTxt = (await page.locator('#tableExpedientePublicado_info').innerText().catch(() => '')) || '';
        const rows = await page.locator('#tableExpedientePublicado tbody tr').count().catch(() => 0);
        if (rows > 0 || /0\s*-\s*0\s*de\s*0/i.test(infoTxt)) return;
        const blocks = await page.locator('dt').count().catch(() => 0);
        if (blocks > 0) return;
        await page.waitForTimeout(250);
    }
}

/** Devuelve el contenedor principal del listado */
async function findResultsContainer(page) {
    const selectors = [
        '#tableExpedientePublicado_wrapper',
        '#tableExpedientePublicado',
        '#resultados, .resultados, .lista-resultados, .search-results, .panel-resultados',
        'main:has(table), section:has(table)',
        'section:has(article), .cards:has(article)',
    ];
    for (const sel of selectors) {
        const loc = page.locator(sel);
        if (await loc.count()) return loc.first();
    }
    const anyTable = page.locator('table:has(tbody tr)');
    if (await anyTable.count()) return anyTable.first();
    return page.locator('body');
}

/** Lista los items (anuncios) dentro del contenedor */
async function listItems(container) {
    const itemSelectors = [
        '#tableExpedientePublicado tbody > tr',
        'article',
        'ul > li',
        '.resultado, .card, .media, .item',
        'div:has(dt):has(dd)',
    ];
    for (const sel of itemSelectors) {
        const loc = container.locator(sel);
        if (await loc.count()) return loc;
    }
    return container.locator('div:has(dt):has(dd), tbody > tr');
}

/** Extrae pares etiqueta/valor de un bloque o fila */
async function extractLabelValuePairs(block) {
    const out = {};

    // dt/dd
    const dts = block.locator('dt');
    for (let i = 0, n = await dts.count(); i < n; i++) {
        const dt = dts.nth(i);
        const label = ((await dt.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const dd = dt.locator('xpath=following-sibling::dd[1]');
        const value = ((await dd.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (value) out[label] = value;
    }

    // table th/td (si el listado viene en tabla)
    const rows = block.locator('table tr');
    for (let i = 0, n = await rows.count(); i < n; i++) {
        const row = rows.nth(i);
        const th = row.locator('th, td strong, td b').first();
        const label = ((await th.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const valCell = row.locator('td').last();
        const value = ((await valCell.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
        if (value) out[label] = value;
    }

    // li/p/div con <strong>/<b>Etiqueta:</b> Valor
    const blocks = block.locator('li, p, div');
    for (let i = 0, n = await blocks.count(); i < n; i++) {
        const el = blocks.nth(i);
        const strong = el.locator('strong, b').first();
        if (await strong.count()) {
            const lbl = ((await strong.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
            if (!lbl) continue;
            let txt = ((await el.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
            if (!txt) continue;
            if (txt.toLowerCase().startsWith(lbl.toLowerCase())) {
                txt = txt.slice(lbl.length).replace(/^[:\-\s]+/, '').trim();
            }
            if (txt) out[lbl] = txt;
        }
    }

    // Posible link de licitación electrónica en el bloque
    if (!out['Dirección web de licitación electrónica']) {
        const link = await block.locator('a[href]').filter({
            hasText: /Licitaci|contract|electr/i,
        }).first().getAttribute('href').catch(() => null);
        if (link && link !== '#' && !/^javascript:/i.test(link)) {
            try { out['Dirección web de licitación electrónica'] = new URL(link, (await block.page()).url()).href; } catch {}
        }
    }

    return out;
}

/** Normaliza a los 11 campos pedidos */
function normalizeTo11(fields) {
    const get = (...alts) => {
        for (const a of alts) if (fields[a]) return fields[a];
        return '';
    };
    return {
        expediente: get('Expediente', 'Nº expediente', 'Número de expediente', 'No expediente'),
        fechaPrimeraPublicacion: get('Fecha primera publicación', 'Primera publicación'),
        fechaUltimaPublicacion: get('Fecha última publicación', 'Última publicación', 'Fecha ultima publicación'),
        tipoContrato: get('Tipo de contrato', 'Tipo contrato'),
        estadoTramitacion: get('Estado de la tramitación', 'Estado tramitación', 'Estado'),
        plazoPresentacion: get('Plazo de presentación', 'Plazo presentacion'),
        fechaLimitePresentacion: get('Fecha límite de presentación', 'Fecha limite de presentación', 'Fecha límite presentacion'),
        presupuestoSinIva: get('Presupuesto del contrato sin IVA', 'Presupuesto sin IVA'),
        poderAdjudicador: get('Poder adjudicador', 'Órgano de contratación'),
        entidadImpulsora: get('Entidad impulsora', 'Entidad convocante'),
        urlLicitacionElectronica: get('Dirección web de licitación electrónica', 'Licitación electrónica', 'URL licitación'),
    };
}

/** Paginación: usa exclusivamente la de la tabla principal para evitar ambigüedad */
async function gotoNextTablePage(page) {
    // DataTables estándar del portal
    const wrap = page.locator('#tableExpedientePublicado_next');
    if (!(await wrap.count())) return false;
    const cls = (await wrap.getAttribute('class').catch(() => '')) || '';
    if (/disabled/i.test(cls)) return false;
    await wrap.locator('a').first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(350);
    return true;
}

/** Si no existiera la tabla, intenta un “Siguiente” cercano al contenedor */
async function clickNextNearContainer(page, container) {
    const candidates = [
        container.locator('.dataTables_paginate .next:not(.disabled) a, .paginate_button.next:not(.disabled) a'),
        container.locator('[id$="_next"]:not(.disabled) a'),
        container.locator('nav[aria-label] a[rel="next"]'),
        container.locator('.pagination a.page-link:has-text("Siguiente"):not(.disabled)'),
    ];
    for (const c of candidates) {
        if (await c.count()) {
            await c.first().click();
            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await sleep(350);
            return true;
        }
    }
    return false;
}

/* ---------------- MAIN ---------------- */
await Actor.main(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36 ApifyPlaywright',
    });
    const page = await context.newPage();

    try {
        log.info(`Abriendo: ${START_URL}`);
        await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await acceptCookies(page);

        // 1) Localiza formulario y aplica filtros (Suministros + Abierto)
        const form = await findSearchForm(page);

        const okTipo = await selectOptionInFormByText(form, /Suministros/i);
        if (!okTipo) log.warning('No se pudo fijar Tipo de contrato = Suministros (revisa selectores si cambia la UI).');

        const okEstado = await selectOptionInFormByText(form, /Abierto/i);
        if (!okEstado) log.warning('No se pudo fijar Estado = Abierto (revisa selectores si cambia la UI).');

        const clicked = await submitSearch(form);
        if (!clicked) log.warning('No se encontró botón Buscar en el formulario (revisa selectores).');

        // 2) Espera a que se pinte el listado
        await waitResultsReady(page);

        // 3) Iterar páginas y extraer anuncios
        let total = 0;
        const MAX_PAGES = 300; // margen suficiente

        for (let p = 0; p < MAX_PAGES; p++) {
            // Si existe tabla principal, usamos sus filas
            let usedTable = false;
            if (await page.locator('#tableExpedientePublicado').count()) {
                usedTable = true;
                const rows = page.locator('#tableExpedientePublicado tbody > tr');
                const count = await rows.count();
                log.info(`Página ${p + 1}: filas en tabla = ${count}`);

                // Mapear por headers si existen (thead th)
                const headers = [];
                const ths = page.locator('#tableExpedientePublicado thead th');
                const hCount = await ths.count();
                for (let i = 0; i < hCount; i++) {
                    headers.push(((await ths.nth(i).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim());
                }

                for (let i = 0; i < count; i++) {
                    const row = rows.nth(i);
                    const pairs = {};

                    // Si hay thead, mapeamos th->td
                    if (hCount > 0) {
                        const tds = row.locator('td');
                        const cCount = await tds.count();
                        for (let k = 0; k < Math.min(hCount, cCount); k++) {
                            const key = headers[k] || `col_${k}`;
                            const val = ((await tds.nth(k).innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
                            if (val) pairs[key] = val;
                        }
                    }

                    // Además, intenta pares dt/dd dentro de la fila (por si mezclan formatos)
                    const merge = await extractLabelValuePairs(row);
                    Object.assign(pairs, merge);

                    // Normaliza a 11 campos
                    const norm = normalizeTo11(pairs);

                    // Intento de capturar URL de licitación si hay enlace en la fila
                    if (!norm.urlLicitacionElectronica) {
                        const href = await row.locator('a[href]').filter({ hasText: /Licitaci|electr|Contract/i }).first().getAttribute('href').catch(() => null);
                        if (href && href !== '#' && !/^javascript:/i.test(href)) {
                            try { norm.urlLicitacionElectronica = new URL(href, page.url()).href; } catch {}
                        }
                    }

                    await Actor.pushData(norm);
                    total += 1;
                    await sleep(30);
                }

                // Paginación propia de la tabla
                const nextOk = await gotoNextTablePage(page);
                if (!nextOk) {
                    log.info('No hay más páginas en la tabla principal.');
                    break;
                }
                // siguiente iteración
                continue;
            }

            // Si no hay tabla, usa un contenedor genérico (dt/dd/cards)
            const container = await findResultsContainer(page);
            const items = await listItems(container);
            const count = await items.count();
            log.info(`Página ${p + 1}: anuncios detectados (sin tabla) = ${count}`);

            for (let i = 0; i < count; i++) {
                const node = items.nth(i);
                const pairs = await extractLabelValuePairs(node);
                const norm = normalizeTo11(pairs);

                // URL de licitación si hay enlace en el bloque
                if (!norm.urlLicitacionElectronica) {
                    const href = await node.locator('a[href]').filter({ hasText: /Licitaci|electr|Contract/i }).first().getAttribute('href').catch(() => null);
                    if (href && href !== '#' && !/^javascript:/i.test(href)) {
                        try { norm.urlLicitacionElectronica = new URL(href, page.url()).href; } catch {}
                    }
                }

                await Actor.pushData(norm);
                total += 1;
                await sleep(30);
            }

            // Paginación cercana al contenedor
            const ok = await clickNextNearContainer(page, container);
            if (!ok) {
                log.info('No hay más páginas.');
                break;
            }
        }

        await browser.close();
        log.info(`Hecho. Registros enviados: ${total}`);
    } catch (err) {
        log.error(`Error: ${err?.message || err}`);
        try { await browser.close(); } catch {}
        throw err;
    }
});
