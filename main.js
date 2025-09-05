import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';
// ⚠️ URL con filtros aplicados directamente (tipo contrato = Suministros, estado = Abierto)
const FILTERED_URL = `${BASE_URL}&tipoContrato=SUMINISTROS&estado=ABIERTO`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acceptCookies(page) {
    try {
        const btn = page.getByRole('button', { name: /Aceptar|Onartu/i });
        if (await btn.count()) await btn.first().click({ timeout: 3000 });
    } catch (_) {}
}

async function getValueByLabel(page, labelRegex) {
    const rows = page.locator('table tr');
    for (let i = 0, n = await rows.count(); i < n; i++) {
        const row = rows.nth(i);
        const th = row.locator('th, td strong, td b').first();
        const label = (await th.innerText().catch(() => '')).trim();
        if (label && labelRegex.test(label)) {
            const valCell = row.locator('td').last();
            const valTxt = (await valCell.innerText().catch(() => '')).trim();
            if (valTxt) return valTxt;
        }
    }
    return '';
}

async function getLinkHrefByLabel(page, labelRegex) {
    const rows = page.locator('table tr');
    for (let i = 0, n = await rows.count(); i < n; i++) {
        const row = rows.nth(i);
        const th = row.locator('th, td strong, td b').first();
        const label = (await th.innerText().catch(() => '')).trim();
        if (label && labelRegex.test(label)) {
            const link = row.locator('a[href]').first();
            const href = await link.getAttribute('href').catch(() => null);
            if (href) return new URL(href, page.url()).href;
        }
    }
    return '';
}

async function extractRelevantFields(page) {
    return {
        expediente: await getValueByLabel(page, /Expediente/i),
        fechaPrimeraPublicacion: await getValueByLabel(page, /Fecha primera publicaci/i),
        fechaUltimaPublicacion: await getValueByLabel(page, /Fecha última publicaci/i),
        tipoContrato: await getValueByLabel(page, /Tipo de contrato/i),
        estadoTramitacion: await getValueByLabel(page, /Estado de la tramitaci/i),
        plazoPresentacion: await getValueByLabel(page, /Plazo de presentaci/i),
        fechaLimitePresentacion: await getValueByLabel(page, /Fecha l[ií]mite/i),
        presupuestoSinIva: await getValueByLabel(page, /Presupuesto.*sin.*IVA/i),
        poderAdjudicador: await getValueByLabel(page, /Poder adjudicador/i),
        entidadImpulsora: await getValueByLabel(page, /Entidad impulsora/i),
        urlLicitacionElectronica: await getLinkHrefByLabel(page, /Licitaci[oó]n electr/i),
        urlFicha: page.url(),
    };
}

async function scrapeListingPage(page, context) {
    const links = page.locator('a:has-text("Expediente"), a:has-text("Ficha"), a:has([href*="ac70cPublicidadWar"])');
    const count = await links.count();
    log.info(` - Resultados detectados: ${count}`);

    let scraped = 0;
    for (let i = 0; i < count; i++) {
        const href = await links.nth(i).getAttribute('href');
        if (!href) continue;
        const url = new URL(href, page.url()).href;
        try {
            const detail = await context.newPage();
            await detail.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await acceptCookies(detail);
            const data = await extractRelevantFields(detail);
            await Actor.pushData(data);
            scraped++;
            await detail.close();
            await sleep(200);
        } catch (err) {
            log.warning(`Error detalle: ${url} :: ${err?.message}`);
        }
    }
    return scraped;
}

await Actor.main(async () => {
    const input = await Actor.getInput();
    const maxPages = Number(input?.maxPages ?? 3);
    const headless = input?.headless !== undefined ? !!input.headless : true;

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        log.info(`Navegando a URL filtrada: ${FILTERED_URL}`);
        await page.goto(FILTERED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await acceptCookies(page);

        let total = 0;
        for (let p = 0; p < maxPages; p++) {
            const scraped = await scrapeListingPage(page, context);
            total += scraped;
            // intentar siguiente página
            const next = page.locator('a:has-text("Siguiente")');
            if (await next.count()) {
                await next.click();
                await page.waitForLoadState('domcontentloaded');
            } else break;
        }

        await browser.close();
        log.info(`Scraping terminado. Total registros: ${total}`);
    } catch (err) {
        log.error(`Fallo scraping: ${err?.message}`);
        await browser.close();
        throw err;
    }
});
