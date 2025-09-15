import { Actor, log } from 'apify';
import { chromium } from 'playwright';

const BASE_URL = 'https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function acceptCookies(page) {
    try {
        const btn = await page.locator('button:has-text("Aceptar")');
        if (await btn.count()) {
            await btn.click({ timeout: 3000 });
        }
    } catch (error) {
        log.warning('No se pudo aceptar cookies:', error);
    }
}

/** Aplicar el filtro "Tipo de contrato" */
async function applyFilter(page, filterName, filterValue) {
    const select = page.locator(`select[name="${filterName}"]`);
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

/** Espera hasta que la tabla esté completamente cargada */
async function waitForTableReady(page, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const rows = await page.locator('#tableExpedientePublicado tbody tr').count();
        if (rows > 0) {
            return true;
        }
        await sleep(500);
    }
    log.warning('La tabla no está lista después del tiempo de espera.');
    return false;
}

/** Extrae los datos de una fila */
async function extractRowData(row) {
    const cells = await row.locator('td').allTextContents();
    return {
        expediente: cells[0] || '',
        tipoContrato: cells[1] || '',
        estadoTramitacion: cells[2] || '',
        fechaPublicacion: cells[3] || '',
        presupuestoSinIva: cells[4] || '',
    };
}

/** Extrae todos los resultados de la tabla */
async function extractTableData(page) {
    const rows = page.locator('#tableExpedientePublicado tbody tr');
    const rowCount = await rows.count();
    const data = [];

    for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i);
        const rowData = await extractRowData(row);
        data.push(rowData);
    }

    return data;
}

/** Scrapea la página actual */
async function scrapeCurrentPage(page) {
    const data = await extractTableData(page);
    log.info(`Registros extraídos: ${data.length}`);
    return data;
}

/** Pasa a la siguiente página de la tabla */
async function goToNextPage(page) {
    const nextButton = page.locator('#tableExpedientePublicado_next a');
    if (await nextButton.count()) {
        await nextButton.click();
        await page.waitForLoadState('networkidle');
        return true;
    }
    return false;
}

/** Principal */
await Actor.main(async () => {
    const input = await Actor.getInput();
    const maxPages = input?.maxPages || 5;
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

        // Esperar a que la tabla esté cargada
        const isTableReady = await waitForTableReady(page);
        if (!isTableReady) {
            throw new Error('La tabla no se cargó correctamente');
        }

        let totalRecords = 0;
        for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
            log.info(`Procesando página ${pageNumber}...`);
            const data = await scrapeCurrentPage(page);
            totalRecords += data.length;
            await Actor.pushData(data);

            const hasNextPage = await goToNextPage(page);
            if (!hasNextPage) break;
        }

        log.info(`Scraping completado. Total de registros: ${totalRecords}`);
        await browser.close();
    } catch (error) {
        log.error('Error durante el scraping:', error);
        await browser.close();
        throw error;
    }
});
