import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function acceptCookies(page) {
    try {
        const btn = await page.locator('button:has-text("Aceptar")');
        if (await btn.count()) {
            await btn.click({ timeout: 3000 });
            log.info('Cookies aceptadas');
        }
    } catch (error) {
        log.warning('No se pudo aceptar cookies:', error);
    }
}

/** Aplicar el filtro "Tipo de contrato" */
async function applyFilter(page, filterName, filterValue) {
    const select = page.locator(`select[name="${filterName}"]`);
    
    // Esperamos a que el selector sea visible y esté listo para interactuar
    await select.waitFor({ state: 'attached', timeout: 30000 });
    
    // Aplicar el filtro
    await select.selectOption({ label: filterValue });
    log.info(`Filtro aplicado: ${filterName} = ${filterValue}`);
}

/** Clic en el botón "Buscar" */
async function clickSearch(page) {
    const button = page.locator('button:has-text("Buscar")');
    if (await button.count()) {
        await button.click();
        log.info('Se ha hecho clic en Buscar');
        await page.waitForLoadState('networkidle'); // Espera hasta que la página termine de cargar
    } else {
        log.warning('No se encontró el botón de Buscar');
    }
}

/** Extrae los resultados de la búsqueda */
async function extractResults(page) {
    const rows = await page.locator('.searchResultRow');
    const rowCount = await rows.count();
    const data = [];

    for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i);
        const result = {
            expediente: await row.locator('.expediente').innerText(),
            tipoContrato: await row.locator('.tipoContrato').innerText(),
            estadoTramitacion: await row.locator('.estadoTramitacion').innerText(),
            fechaPublicacion: await row.locator('.fechaPublicacion').innerText(),
            presupuestoSinIva: await row.locator('.presupuestoSinIva').innerText(),
        };
        data.push(result);
    }

    return data;
}

await Actor.main(async () => {
    const input = await Actor.getInput();
    const headless = input?.headless !== undefined ? input.headless : true;

    log.info('Iniciando scraping en: ', BASE_URL);

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();

    try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Aceptar cookies si es necesario
        await acceptCookies(page);

        // Aplicar filtros
        await applyFilter(page, 'tipoContrato', 'Suministros');
        await applyFilter(page, 'estadoTramitacion', 'Abierto');

        // Hacer clic en "Buscar"
        await clickSearch(page);

        // Extraer resultados de la búsqueda
        const results = await extractResults(page);

        log.info(`Registros extraídos: ${results.length}`);

        // Almacenar los resultados en el dataset
        await Actor.pushData(results);

        log.info(`Scraping completado. Total de registros: ${results.length}`);

        await browser.close();
    } catch (error) {
        log.error('Error durante el scraping:', error);
        await browser.close();
        throw error;
    }
});
