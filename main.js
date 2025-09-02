import { Actor, log } from "apify";
import { chromium } from "playwright";

const URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  log.info("Abriendo búsqueda…");
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // --- Aceptar cookies (si aparece) ---
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible()) {
      await cookiesBtn.click();
      log.info("Cookies aceptadas");
    }
  } catch {}

  // --- APLICA FILTROS ---
  try {
    await page.locator("label:has-text('Tipo de contrato')").locator(".. select")
      .selectOption({ label: "Suministros" });
    await page.locator("label:has-text('Estado')").locator(".. select")
      .selectOption({ label: "Abierto" });
    log.info("Filtros aplicados");
  } catch (e) {
    log.warning("No se pudieron aplicar los filtros: " + e.message);
  }

  // --- Buscar ---
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Click en buscar");
  } catch {}

  await page.waitForTimeout(5000); // margen para render

  // --- RESULTADOS (primera página) ---
  const rows = page.locator("table tbody tr, .resultado, .filaResultado");
  const count = await rows.count().catch(() => 0);
  log.info(`Resultados en la primera página: ${count}`);

  // Utilidad: leer valor de campo por etiqueta (en ficha)
  const readField = async (detailPage, labelText) => {
    try {
      // Busca un nodo que contenga el texto del campo y lee su línea/parent
      const node = detailPage.locator(`text=${labelText}`).first();
      if (!(await node.isVisible().catch(() => false))) return null;
      // Sube un nivel y coge el texto del contenedor
      const block = await node.locator("xpath=..").innerText().catch(() => "");
      if (!block) return null;
      // Limpia saltos de línea y devuelve todo (el consumidor extraerá números/fechas)
      return block.replace(/\s+/g, " ").trim();
    } catch {
      return null;
    }
  };

  // Itera resultados, entra a cada detalle y extrae campos clave
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const a = row.locator("a").first();
    const titulo = (await a.innerText().catch(() => "")).trim();
    const href = await a.getAttribute("href").catch(() => null);
    const enlace = href ? new URL(href, page.url()).toString() : null;
    if (!titulo || !enlace) continue;

    // Abre detalle en la misma pestaña para ahorrar recursos
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    // Campos básicos
    const organoTxt = await readField(page, "Órgano");
    const procedimientoTxt = await readField(page, "Procedimiento");
    const presupuestoTxt = await readField(page, "Presupuesto");
    const valorEstimadoTxt = await readField(page, "Valor estimado");
    const presentacionTxt = await readField(page, "Presentación de ofertas");
    const cpvTxt = await readField(page, "CPV");

    // Parsers ligeros
    const cpv = cpvTxt ? (cpvTxt.match(/\b\d{8}\b/) || [null])[0] : null;
    const presupuesto = presupuestoTxt ? (presupuestoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const valorEstimado = valorEstimadoTxt ? (valorEstimadoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const fechaLimite =
      presentacionTxt ? (presentacionTxt.match(/\b\d{2}\/\d{2}\/\d{4}\b/) || [null])[0] : null;

    // Empuja item
    const item = {
      titulo,
      enlace,
      organo: organoTxt || null,
      procedimiento: procedimientoTxt || null,
      presupuesto,
      valorEstimado,
      fechaLimite,
      cpv
    };
    log.info(`→ ${titulo}`);
    await Actor.pushData(item);

    // Vuelve a la lista (historial -1) para continuar
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset de la ejecución.");
});
