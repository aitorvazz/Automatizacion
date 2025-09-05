// main.js — Apify SDK v3 + Playwright
// Fuente: https://www.contratacion.euskadi.eus/ac70cPublicidadWar/informacionAmpliadaAnuncios/search
// Objetivo: en cada página del listado, extraer 11 parámetros por anuncio y paginar hasta el final.
//
// Campos a extraer por anuncio:
// 1) expediente
// 2) fechaPrimeraPublicacion
// 3) fechaUltimaPublicacion
// 4) tipoContrato
// 5) estadoTramitacion
// 6) plazoPresentacion
// 7) fechaLimitePresentacion
// 8) presupuestoSinIva
// 9) poderAdjudicador
// 10) entidadImpulsora
// 11) urlLicitacionElectronica
//
// Notas de implementación:
// - No entra en fichas: extrae de cada bloque/row/card del propio listado.
// - Detecta pares etiqueta/valor en <dl>, tablas, y patrones <strong>/<b>Etiqueta:</b> Valor.
// - Paginación robusta: prioriza botones "Siguiente" cercanos al contenedor de resultados,
//   y evita ambigüedad cuando hay varias paginaciones en la página.

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const START_URL = 'https://www.contratacion.euskadi.eus/ac70cPublicidadWar/informacionAmpliadaAnuncios/search';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------- Utilidades -----------------
async function acceptCookies(page) {
    try {
        const btn = page.getByRole('button', { name: /Aceptar|Aceptar todas|Onartu|Aceptar cookies/i });
        if (await btn.count()) await btn.first().click({ timeout: 3000 });
    } catch {}
}

// Extrae pares etiqueta/valor dentro de un contenedor de anuncio
async function extractLabelValuePairs(container) {
    const result = {};

    // 1) Estructura <dl><dt>Etiqueta</dt><dd>Valor</dd>
    const dts = container.locator('dt');
    for (let i = 0, n = await dts.count(); i < n; i++) {
        const dt = dts.nth(i);
        const label = (await dt.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const dd = dt.locator('xpath=following-sibling::dd[1]');
        const value = (await dd.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (value) result[label] = value;
    }

    // 2) Tablas <table><tr><th>Etiqueta</th><td>Valor</td></tr>
    const rows = container.locator('table tr');
    for (let i = 0, n = await rows.count(); i < n; i++) {
        const row = rows.nth(i);
        const th = row.locator('th, td strong, td b').first();
        const label = (await th.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!label) continue;
        const valCell = row.locator('td').last();
        const value = (await valCell.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (value) result[label] = value;
    }

    // 3) Bloques <li|p|div><strong>Etiqueta:</strong> Valor
    const blocks = container.locator('li, p, div');
    for (let i = 0, n = await blocks.count(); i < n; i++) {
        const el = blocks.nth(i);
        const strong = el.locator('strong, b').first();
        if (await strong.count()) {
            const lbl = (await strong.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (!lbl) continue;
            let txt = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (!txt) continue;
            if (txt.toLowerCase().startsWith(lbl.toLowerCase())) {
                txt = txt.slice(lbl.length).replace(/^[:\-\s]+/, '').trim();
            }
            if (txt) result[lbl] = txt;
        }
    }

    return result;
}

// Normaliza nombres a los 11 campos esperados
function normalizeTo11(fields, pageUrl) {
    const get = (...alts) => {
        for (const a of alts) if (fields[a]) return fields[a];
        return '';
    };

    // Algunas webs usan variantes mínimas en etiquetas; cubrimos las más probables
    return {
        expediente: get('Expediente', 'Nº expediente', 'No expediente', 'Número de expediente'),
        fechaPrimeraPublicacion: get('Fecha primera publicación', 'Primera publicación'),
        fechaUltimaPublicacion: get('Fecha última publicación', 'Última publicación', 'Fecha última publicacion'),
        tipoContrato: get('Tipo de contrato', 'Tipo contrato'),
        estadoTramitacion: get('Estado de la tramitación', 'Estado tramitación', 'Estado'),
        plazoPresentacion: get('Plazo de presentación', 'Plazo presentacion'),
        fechaLimitePresentacion: get('Fecha límite de presentación', 'Fecha limite de presentación', 'Fecha límite presentacion'),
        presupuestoSinIva: get('Presupuesto del contrato sin IVA', 'Presupuesto sin IVA'),
        poderAdjudicador: get('Poder adjudicador', 'Órgano de contratación'),
        entidadImpulsora: get('Entidad impulsora', 'Entidad convocante'),
        urlLicitacionElectronica: get('Dirección web de licitación electrónica', 'Licitación electrónica', 'URL licitación'),
        // opcional: urlFicha si el bloque tiene enlace a detalle
        urlFicha: get('URL de la ficha', 'Enlace a ficha', 'Ficha', 'Más información') || pageUrl || '',
    };
}

// Encuentra el contenedor principal de resultados en esta ruta
async function findResultsContainer(page) {
    const selectors = [
        // contenedores típicos del buscador “informacionAmpliadaAnuncios”
        '#resultados, .resultados, .lista-resultados',
        'section:has(article), .cards:has(article)',
        'div.search-results, .search-results, .panel-resultados',
        'table:has(tbody tr)',
        'main',
    ];
    for (const sel of selectors) {
        const loc = page.locator(sel);
        if (await loc.count()) return loc.first();
    }
    return page.locator('body');
}

// Lista de items (anuncios) dentro del contenedor
async function listItemsInContainer(container) {
    const itemSelectors = [
        'article',
        'ul > li',
        'tbody > tr',
        '.resultado',
        '.card',
        '.row:has(.campo), .row:has(dt), .row:has(table)',
    ];
    for (const sel of itemSelectors) {
        const loc = container.locator(sel);
        if (await loc.count()) return loc;
    }
    return container.locator('div'); // fallback
}

// Busca y pulsa el “Siguiente” más cercano al contenedor (evita ambigüedad)
async function clickNextNearContainer(page, container) {
    const candidates = [
        container.locator('nav[aria-label] a[rel="next"]'),
        container.locator('.pagination .page-link:has-text("Siguiente"):not(.disabled)'),
        container.locator('.dataTables_paginate .next:not(.disabled) a, .paginate_button.next:not(.disabled) a'),
        container.locator('[id$="_next"]:not(.disabled) a'),
        // último recurso:
        page.locator('a:has-text("Siguiente")').filter({ hasNot: page.locator('.disabled') }),
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

// Scrapea todos los anuncios de la página corriente
async function scrapeListingPage(page) {
    const container = await findResultsContainer(page);
    const items = await listItemsInContainer(container);
    const count = await items.count();

    log.info(`Anuncios detectados en página: ${count}`);

    let pushed = 0;
    for (let i = 0; i < count; i++) {
        const node = items.nth(i);

        // Extrae pares etiqueta/valor
        const pairs = await extractLabelValuePairs(node);

        // “urlFicha” si aparece un enlace claro dentro del bloque
        if (!pairs['URL de la ficha'] && !pairs['Enlace a ficha'] && !pairs['Ficha'] && !pairs['Más información']) {
            const href = await node.locator('a[href]').first().getAttribute('href').catch(() => null);
            if (href && !/^javascript:/i.test(href) && href !== '#') {
                try { pairs['URL de la ficha'] = new URL(href, page.url()).href; } catch {}
            }
        }

        const normalized = normalizeTo11(pairs, page.url());
        await Actor.pushData(normalized);
        pushed++;
        await sleep(40);
    }

    return { pushed, container };
}

// ----------------- MAIN -----------------
await Actor.main(async () => {
    const headless = true; // en Apify con xvfb-run, mejor mantener true

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36 ApifyPlaywright',
    });
    const page = await context.newPage();

    try {
        log.info(`Abriendo listado: ${START_URL}`);
        await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await acceptCookies(page);

        let total = 0;
        const MAX_PAGES = 200; // suficiente para ~1500 resultados en páginas de 10

        for (let p = 0; p < MAX_PAGES; p++) {
            log.info(`Página ${p + 1} / ${MAX_PAGES}`);
            const { pushed, container } = await scrapeListingPage(page);
            total += pushed;

            const ok = await clickNextNearContainer(page, container);
            if (!ok) {
                log.info('No hay más páginas (Siguiente no presente/habilitado).');
                break;
            }
        }

        await browser.close();
        log.info(`Terminado. Registros enviados al Dataset: ${total}`);
    } catch (err) {
        log.error(`Error: ${err?.message || err}`);
        try { await browser.close(); } catch {}
        throw err;
    }
});
