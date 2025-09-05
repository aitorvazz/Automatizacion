// main.js — Actor Apify (SDK v3) + Playwright
// Filtros: Tipo de contrato = Suministros, Estado = Abierto
// Campos extraídos (solo los solicitados):
//   - Expediente
//   - Fecha primera publicación
//   - Fecha última publicación
//   - Tipo de contrato (Suministros)
//   - Estado de la tramitación
//   - Plazo de presentación / Fecha límite de presentación
//   - Presupuesto del contrato sin IVA
//   - Poder adjudicador
//   - Entidad impulsora
//   - Dirección web de licitación electrónica (href)
// Salida: Actor.pushData(...) -> Dataset del actor

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Acepta cookies si aparece el banner */
async function acceptCookies(page) {
    try {
        const btn = page.getByRole('button', { name: /Aceptar|Aceptar todas|Onartu|Aceptar cookies/i });
        if (await btn.count()) await btn.first().click({ timeout: 3000 });
    } catch (_) {}
}

/** Selecciona una opción por su texto visible en cualquier <select> cuya lista de <option> contenga ese texto */
async function selectByOptionTextAnywhere(page, optionRegex, { debugName }) {
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
        const sel = selects.nth(i);
        const opts = await sel.locator('option').allTextContents();
        const has = opts.some((t) => optionRegex.test(t));
        if (has) {
            try {
                await sel.selectOption({ label: optionRegex });
                log.info(`Filtro aplicado (${debugName}) en <select> #${i}`);
                return true;
            } catch (e) {
                // intenta por value si label falla
                const values = [];
                for (const t of opts) {
                    if (optionRegex.test(t)) {
                        // averigua su value concreto
                        const optEl = sel.locator('option', { hasText: t });
                        const v = await optEl.first().getAttribute('value').catch(() => null);
                        if (v) values.push(v);
                    }
                }
                if (values.length) {
                    await sel.selectOption(values[0]).catch(() => {});
                    log.info(`Filtro aplicado por value (${debugName}) en <select> #${i}`);
                    return true;
                }
            }
        }
    }
    return false;
}

/** Pulsa el botón Buscar / Filtrar */
async function clickSearch(page) {
    const candidates = [
        page.getByRole('button', { name: /Buscar|Filtrar|Bilatu|Aplicar/i }),
        page.locator('input[type="submit"][value*="Buscar" i]'),
        page.locator('input[type="submit"][value*="Bilatu" i]'),
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

/** Aplica filtros: Tipo = Suministros, Estado = Abierto */
async function setFilters(page) {
    // Primero intentamos por <label> (si existieran)
    let okTipo = false;
    let okEstado = false;
    try {
        await page.getByLabel(/Tipo de contrato/i).selectOption({ label: /Suministros/i });
        okTipo = true;
    } catch (_) {}

    try {
        await page.getByLabel(/Estado/i).selectOption({ label: /Abierto/i });
        okEstado = true;
    } catch (_) {}

    // Fallback: escanear todos los selects por opción visible
    if (!okTipo) {
        okTipo = await selectByOptionTextAnywhere(page, /Suministros/i, { debugName: 'Tipo de contrato = Suministros' });
        if (!okTipo) log.warning('No pude fijar "Tipo de contrato = Suministros" (revisa selectores).');
    }
    if (!okEstado) {
        okEstado = await selectByOptionTextAnywhere(page, /Abierto/i, { debugName: 'Estado = Abierto' });
        if (!okEstado) log.warning('No pude fijar "Estado = Abierto" (revisa selectores).');
    }

    // Pulsar Buscar
    const clicked = await clickSearch(page);
    if (!clicked) log.warning('No pude encontrar el botón de Buscar/Filtrar.');
}

/** Lista: devuelve [{ title, href }] de los anuncios detectados */
async function parseListingPage(page) {
    // Heurística: enlaces internos del módulo de anuncios
    const items = [];
    const anchors = await page.locator('a').all();
    for (const a of anchors) {
        const href = await a.getAttribute('href');
        if (!href) continue;
        const text = (await a.innerText().catch(() => '')).trim();
        if (!text) continue;
        if (/ac70cPublicidadWar|anuncio|ficha/i.test(href) && text.length > 6) {
            const url = new URL(href, page.url()).href;
            items.push({ title: text, href: url });
        }
    }
    // Deduplicar por href
    const seen = new Set();
    return items.filter((it) => (seen.has(it.href) ? false : (seen.add(it.href), true)));
}

/** Extrae el valor textual a la derecha/abajo de una etiqueta (tabla, lista o párrafo) */
async function getValueByLabel(page, labelRegex) {
    // 1) Tablas th/td
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

    // 2) Listas dt/dd
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

    // 3) Párrafos/div: "Etiqueta: Valor"
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

/** Devuelve el href del enlace situado junto a la etiqueta */
async function getLinkHrefByLabel(page, labelRegex) {
    // Tabla
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
    // Listas dt/dd
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
    // Párrafos/div cercanos
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

/** Extrae SOLO los campos relevantes */
async function extractRelevantFields(page) {
    const data = {
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

    // Normalizaciones pequeñas
    if (data.tipoContrato && !/suministros/i.test(data.tipoContrato)) {
        // a veces la ficha puede mostrar otra cosa; lo dejamos, pero marcamos
        data.avisoTipoContrato = 'Tipo de contrato ≠ Suministros (revisar filtros o ficha).';
    }

    return data;
}

/** Intenta pasar a la siguiente página de resultados */
async function goToNextPage(page, pageIndex) {
    const candidates = [
        page.getByRole('link', { name: /Siguiente|Hurrengoa|Next/i }),
        page.getByRole('button', { name: /Siguiente|Hurrengoa|Next/i }),
        page.locator('a[rel="next"]'),
        page.locator('a:has-text("Siguiente")'),
    ];
    for (const c of candidates) {
        try {
            if (await c.count()) {
                await c.first().click();
                await page.waitForLoadState('load');
                await sleep(400);
                return true;
            }
        } catch (_) {}
    }

    // Fallback por número de página
    try {
        const nextPageNum = pageIndex + 2; // visible 1-based
        const link = page.locator(`a:has-text("${nextPageNum}")`);
        if (await link.count()) {
            await link.first().click();
            await page.waitForLoadState('load');
            await sleep(400);
            return true;
        }
    } catch (_) {}

    return false;
}

await Actor.main(async () => {
    const input = await Actor.getInput();
    const maxPages = Number(input?.maxPages ?? 5);
    const headless = input?.headless !== undefined ? !!input.headless : true;

    log.info(`Iniciando scraping -> ${BASE_URL}`);
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36 ApifyPlaywright',
    });
    const page = await context.newPage();

    try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await acceptCookies(page);

        // Aplica filtros (robustos)
        await setFilters(page);

        let total = 0;

        for (let p = 0; p < maxPages; p++) {
            log.info(`Página ${p + 1} / ${maxPages}`);
            const list = await parseListingPage(page);
            log.info(` - Enlaces detectados: ${list.length}`);

            for (const item of list) {
                try {
                    const detail = await context.newPage();
                    await detail.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await acceptCookies(detail);
                    await detail.waitForLoadState('networkidle');

                    const data = await extractRelevantFields(detail);
                    await Actor.pushData(data);
                    total += 1;

                    await detail.close();
                    await sleep(150 + Math.random() * 300);
                } catch (err) {
                    log.warning(`Error leyendo detalle: ${item.href} :: ${err?.message || err}`);
                }
            }

            const hasNext = await goToNextPage(page, p);
            if (!hasNext) {
                log.info('No hay más páginas.');
                break;
            }
            await sleep(400 + Math.random() * 700);
        }

        await browser.close();
        log.info(`Scraping completado. Registros enviados al Dataset: ${total}`);
    } catch (err) {
        log.error(`Fallo en scraping: ${err?.message || err}`);
        try { await browser.close(); } catch {}
        throw err;
    }
});
