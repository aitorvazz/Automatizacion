import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const waitIdle = async (ms = 10000) => { try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {} };

  // --- Abrir buscador ---
  log.info("Abriendo buscador…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();

  // Aceptar cookies si salen
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cookiesBtn.click(); 
      await waitIdle();
    }
  } catch {}

  // --- Filtros ---
  try {
    await page.selectOption("select[name*='tipoContrato']", { label: /Suministros/i }).catch(() => {});
    await page.selectOption("select[name*='estado']", { label: /Abierto/i }).catch(() => {});
    log.info("Filtros aplicados.");
  } catch (e) {
    log.error("Error al aplicar filtros", e);
  }

  // --- Buscar ---
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Buscar disparado");
  } catch {}
  await waitIdle();

  // --- Obtener filas de resultados ---
  const rows = page.locator(".filaResultado, .resultado, [data-anuncio]");
  const count = await rows.count().catch(() => 0);
  log.info(`Filas detectadas: ${count}`);

  if (!count) {
    await Actor.setValue("debug_no_rows.png", await page.screenshot({ fullPage: true }), { contentType: "image/png" });
    log.error("No se detectaron resultados.");
    await browser.close();
    return;
  }

  // --- Funciones de lectura en detalle ---
  const readBlockByLabel = async (ctx, labels) => {
    for (const lbl of labels) {
      try {
        const node = ctx.locator(`xpath=//*[contains(normalize-space(.),'${lbl}')]`).first();
        if (await node.isVisible().catch(() => false)) {
          const block = await node.locator("xpath=..").innerText().catch(() => "");
          if (block) return block.replace(/\s+/g, " ").trim();
        }
      } catch {}
    }
    return null;
  };

  const readHrefByLabel = async (ctx, labels) => {
    for (const lbl of labels) {
      try {
        const link = ctx.locator(`xpath=//*[contains(normalize-space(.),'${lbl}')]/following::a[1]`).first();
        if (await link.isVisible().catch(() => false)) {
          const href = await link.getAttribute("href").catch(() => null);
          if (href) return new URL(href, ctx.url()).toString();
        }
      } catch {}
    }
    return null;
  };

  const extractDate = (txt) => txt?.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || null;

  // --- Recorrer resultados ---
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const link = await row.locator("a").first().getAttribute("href").catch(() => null);
    if (!link) continue;

    const url = new URL(link, page.url()).toString();
    log.info(`Procesando → ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitIdle();

    const titulo = (await page.locator("h1").first().innerText().catch(() => "")).trim();

    const expediente        = await readBlockByLabel(page, ["Expediente"]);
    const fechaPrimera      = extractDate(await readBlockByLabel(page, ["Fecha primera publicación"]));
    const fechaUltima       = extractDate(await readBlockByLabel(page, ["Fecha última publicación"]));
    const tipoContrato      = await readBlockByLabel(page, ["Tipo de contrato"]);
    const estadoTram        = await readBlockByLabel(page, ["Estado de la tramitación"]);
    const plazoPresentacion = await readBlockByLabel(page, ["Plazo de presentación"]);
    const fechaLimite       = extractDate(await readBlockByLabel(page, ["Fecha límite de presentación"]));
    const presupuestoSinIVA = await readBlockByLabel(page, ["Presupuesto del contrato sin IVA"]);
    const poderAdjudicador  = await readBlockByLabel(page, ["Poder adjudicador"]);
    const entidadImpulsora  = await readBlockByLabel(page, ["Entidad Impulsora"]);
    const urlLicitacion     = await readHrefByLabel(page, ["Dirección web de licitación electrónica"]);

    await Actor.pushData({
      titulo, url,
      expediente,
      fechaPrimeraPublicacion: fechaPrimera,
      fechaUltimaPublicacion : fechaUltima,
      tipoContrato,
      estadoTramitacion      : estadoTram,
      plazoPresentacion,
      fechaLimitePresentacion: fechaLimite,
      presupuestoSinIVA,
      poderAdjudicador,
      entidadImpulsora,
      direccionLicitacionElectronica: urlLicitacion,
    });
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
