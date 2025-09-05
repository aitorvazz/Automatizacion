import { Actor } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';

async function acceptCookies(page) {
    try {
        await page.getByRole('button', { name: /Aceptar|Onartu|Aceptar cookies/i }).click({ timeout: 3000 });
    } catch (_) {}
}

async function setFilters(page) {
    try {
        await page.getByLabel(/Tipo de contrato/i).selectOption({ label: /Suministros/i });
    } catch (_) {}
    try {
        await page.getByLabel(/Estado/i).selectOption({ label: /Abierto/i });
    } catch (_) {}
    try {
        await page.getByRole('button', { name: /Buscar|Filtrar|Bilatu/i }).click();
    } catch (_) {}
}

async function parseListingPage(page) {
    const items = [];
    const links = await page.locator('a').all();
    for (const a of links) {
        const href = await a.getAttribute('href');
        const text = (await a.innerText()).trim();
        if (href && text && /ac70cPublicidadWar/.test(href)) {
            items.push({ title: text, href: new URL(href, page.url()).href });
        }
    }
    const seen = new Set();
    return items.filter(it => (seen.has(it.href) ? false : (seen.add(it.href), true)));
}

async function extractDetail(page) {
    const data = {
        titulo: (await page.locator('h1, h2').first().innerText().catch(() => '')).trim(),
        url: page.url(),
    };
    return data;
}

async function goToNextPage(page, pageIndex) {
    try {
        const next = page.getByRole('link', { name: /Siguiente|Hurrengoa/i });
        if (await next.count()) {
            await next.click();
            await page.waitForLoadState('domcontentloaded');
            return true;
        }
    } catch (_) {}
    return false;
}

await Actor.main(async () => {
    const input = await Actor.getInput();
    const maxPages = input?.maxPages || 3;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);
    await setFilters(page);
    await page.waitForLoadState('networkidle');

    let results = [];

    for (let p = 0; p < maxPages; p++) {
        const list = await parseListingPage(page);

        for (const item of list) {
            try {
                const detail = await context.newPage();
                await detail.goto(item.href, { waitUntil: 'domcontentloaded' });
                await acceptCookies(detail);

                const data = await extractDetail(detail);
                if (!data.titulo) data.titulo = item.title;

                await Actor.pushData(data);
                results.push(data);

                await detail.close();
            } catch (err) {
                Actor.log.warning(`Error en detalle: ${item.href}`);
            }
        }

        const hasNext = await goToNextPage(page, p);
        if (!hasNext) break;
    }

    await browser.close();
    Actor.log.info(`Scraping completado. Registros: ${results.length}`);
});
