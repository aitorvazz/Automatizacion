import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function acceptCookies(page) {
    try {
        // Esperamos que el botón de cookies esté disponible
        const cookiesButton = page.locator('button:has-text("Aceptar")');
        if (await cookiesButton.count()) {
            await cookiesButton.click({ timeout: 5000 });
            log.info('Cookies aceptadas');
        }
    } catch (error) {
        log.warning('No se pudo aceptar las cookies:', error);
    }
}

/** Aplica el filtro "Tipo de contrato" (Suministros) */
async function applyTipoContratoFilter(page) {
    const tipoContratoSelect = page.locator('select[name="tipoContrato"]');
    await tipoContratoSelect.waitFor({ state: 'visible', timeout: 30000 });  // Esperar a que esté visible
    await tipoContratoSelect.selectOption({ label: 'Suministros' });
    log.info('Filtro aplicado: Tipo de contrato = Suministros');
}

/** Aplica el filtro "Estado de tramitación" (Abierto) */
async function applyEstadoTramitacionFilter(page) {
    const estadoTramitacionSelect = page.locator('select[name="estadoTramitacion"]');
    await estadoTramitacionSelect.waitFor({ state: 'visible', timeout: 30000 });  // Esperar a que esté visible
    await estadoTramitacionSelect.selectOption({ label: 'Abierto' });
    log.info('Filtro aplicado: Estado de tramitación = Abierto');
}

/** Hace clic en el botón "Buscar" */
async function clickSearch(page) {
    const searchButton = page.locator('button:has-text("Buscar")');
    if (await searchButton.count()) {
        await searchButton.click();
        log.info('Se ha hecho clic en Buscar');
        await page.waitForLoadState('networkidle');  // Espera a que la página termine de cargar
    } else {
        log.warning('No se encontró el botón de Buscar');
    }
}

/** Extrae todos los resultados de la búsqueda */
async function extractResults(page) {
    const rows = page.locator('.searchResultRow');  // Asegúrate de que esta clase esté en la tabla de resultados
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

        // Aplicar los filtros:
        await applyTipoContratoFilter(page);  // Filtro "Tipo de contrato" = Suministros
        await applyEstadoTramitacionFilter(page);  // Filtro "Estado de tramitación" = Abierto

        // Hacer clic en "Buscar"
        await clickSearch(page);

        // Extraer los resultados de la búsqueda
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
