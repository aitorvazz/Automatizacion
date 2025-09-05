// main.js — Actor Apify (SDK v3) + Playwright
// Filtra: Tipo de contrato = Suministros, Estado = Abierto
// Extrae: título, estado, objeto, tipo contrato, procedimiento, tramitación,
//         presupuesto sin IVA, valor estimado, CPV, lugar de ejecución,
//         órgano de contratación, método/presentación, fecha límite, pliegos.
// Salida: Actor.pushData(...)  -> Dataset del actor

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function acceptCookies(page) {
    try {
        // Botones típicos de euskadi.eus
        const btn = page.getByRole('button', { name: /Aceptar|Aceptar todas|Onartu|Aceptar cookies/i });
        if (await btn.count()) await btn.first().click({ timeout: 3000 });
    } catch (_) {}
}

async function setFilters(page) {
    // Tipo de contrato = Suministros
    try {
        await page.getByLabel(/Tipo de contrato/i).selectOption({ label: /Suministros/i });
    } catch {
        try {
            await page.locator('select[name*="tipoContrato"], select#tipoContrato')
                .selectOption({ label: /Suministros/i });
        } catch {
            log.warning('No pude fijar "Tipo de contrato" por label ni por fallback. Revisa selectores.');
        }
    }

    // Estado = Abierto
    try {
        await page.getByLabel(/Estado/i).selectOption({ label: /Abierto/i });
    } catch {
        try {
            await page.locator('select[name*="estado"], select#estado')
                .selectOption({ label: /Abierto/i });
        } catch {
            log.warning('No pude fijar "Estado" por label ni por fallback. Revisa selectores.');
        }
    }

    // Botón Buscar / Filtrar
    try {
        await page.getByRole('button', { name: /Buscar|Filtrar|Bilatu/i }).click();
    } catch {
        const submit = page.locator('input[type="submit"][value*="Buscar" i], input[type="submit"][value*="Bilatu" i]');
        if (await submit.count()) await submit.first().click();
    }

    await page.waitForLoadState('networkidle');
}

async function parseListingPage(page) {
    // Devuelve [{ title, href }] para cada resultado visible
    const items = [];
    const links = await page.locator('a').all();
    for (const a of links) {
        const href = await a.getAttribute('href');
        if (!href) continue;
        const text = (await a.innerText().catch(() => '')).trim();
        if (!text) continue;

        // Heurística: enlaces internos del módulo de anuncios
        if (/ac70cPublicidadWar|anuncio|ficha/i.test(href) && text.length > 6) {
            items.push({ title: text, href: new URL(href, page.url()).href });
        }
    }

    // Dedup por href
    const seen = new Set();
    return items.filter(it => (seen.has(it.href) ? false : (seen.add(it.href), true)));
}

async function extractDetail(page) {
    // Utilidad para buscar "Etiqueta: Valor" aunque cambie el contenedor
    const getTextByLabel = async (labelRegex) => {
        const nodes = page.locator('tr, li, p, div');
        const count = await nodes.count();
        for (let i = 0; i < count; i++) {
            const el = nodes.nth(i);
            const txt = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (!txt) continue;
            if (labelRegex.test(txt)) {
                const m = txt.split(':');
                if (m.length > 1) return m.slice(1).join(':').trim();
                return txt.replace(labelRegex, '').trim();
            }
        }
        return '';
    };

    const data = {
        titulo: (await page.locator('h1, h2').first().innerText().catch(() => '')).trim(),
        url: page.url(),
        estado: await getTextByLabel(/Estado/i),
        objeto: await getTextByLabel(/Objeto del contrato|Objeto/i),
        tipoContrato: await getTextByLabel(/Tipo de Contrato|Tipo de contrato/i),
        procedimiento: await getTextByLabel(/Procedimiento/i),
        tramitacion: await getTextByLabel(/Tramitaci[oó]n/i),
        presupuestoSinIVA: await getTextByLabel(/Presupuesto base de licitaci[oó]n sin impuestos|Sin IVA/i),
        valorEstimado: await getTextByLabel(/Valor estimado del contrato/i),
        cpv: await getTextByLabel(/C[oó]digo CPV|CPV/i),
        lugarEjecucion: await getTextByLabel(/Lugar de Ejecuci[oó]n|Lugar de ejecución/i),
        organo: await getTextByLabel(/Órgano de Contrataci[oó]n|Órgano/i),
        presentacion: await getTextByLabel(/M[eé]todo de presentaci[oó]n|Presentaci[oó]n/i),
        fechaLimite: await getTextByLabel(/Fecha l[ií]mite.*presentaci[oó]n|Plazo de presentaci[oó]n/i),
    };

    // Enlaces a pliegos
    const pliegos = [];
    const anchors = await page.locator('a').all();
    for (const a of anchors) {
        const txt = (await a.innerText().catch(() => '')).trim();
        const href = await a.getAttribute('href');
        if (!href) continue;
        if (/Pliego|PCAP|PPT|Condiciones|Pliegos/i.test(txt)) {
            pliegos.push({ texto: txt, url: new URL(href, page.url()).href });
        }
    }
    data.pliegos = pliegos;

    // Heurística simple de flags/elegibilidad (revisión humana posterior)
    const flags = [];
    if (!/Suministros/i.test(data.tipoContrato || '')) flags.push('Tipo de contrato ≠ Suministros');
    if (!(data.fechaLimite && (/\d{2}\/\d{2}\/\d{4}/.test(data.fechaLimite) || /\d{4}-\d{2}-\d{2}/.test(data.fechaLimite))))
        flags.push('Sin fecha límite detectable');
    if (!pliegos.length) flags.push('Sin enlaces a pliegos (revisar solvencia/clasificación)');
    data.banderas = flags;
    data.puedePresentarse = flags.length === 0;

    return data;
}

async function goToNextPage(page, pageIndex) {
    // Intenta "Siguiente"
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
        const nextPageNum = pageIndex + 2; // si estamos en 1-based visible
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

                    const data = await extractDetail(detail);
                    if (!data.titulo) data.titulo = item.title;

                    await Actor.pushData(data);
                    total += 1;

                    await detail.close();
                    await sleep(200 + Math.random() * 400);
                } catch (err) {
                    log.warning(`Error leyendo detalle: ${item.href} :: ${err?.message || err}`);
                }
            }

            const hasNext = await goToNextPage(page, p);
            if (!hasNext) {
                log.info('No hay más páginas.');
                break;
            }
            await sleep(500 + Math.random() * 800);
        }

        await browser.close();
        log.info(`Scraping completado. Registros enviados al Dataset: ${total}`);
    } catch (err) {
        log.error(`Fallo en scraping: ${err?.message || err}`);
        try { await browser.close(); } catch {}
        throw err;
    }
});
