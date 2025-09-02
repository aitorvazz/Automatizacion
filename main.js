import { Actor, log } from "apify";
import { chromium } from "playwright";

const URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  log.info("Abriendo búsqueda…");
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // --- Aceptar cookies ---
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|onartu)/i });
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

  // --- Botón Buscar ---
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Click en buscar");
  } catch {}

  await page.waitForTimeout(5000); // espera a que carguen resultados

  // --- LISTA DE RESULTADOS ---
  const rows = page.locator("table tbody tr, .resultado, .filaResultado");
  const count = await rows.count().catch(() => 0);
  log.info(`Resultados en la primera página: ${count}`);

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const anchor = row.locator("a").first();
    const titulo = (await anchor.innerText().catch(() => "")).trim();
    const href = await anchor.getAttribute("href").catch(() => null);
    const enlace = href ? new URL(href, page.url()).toString() : null;

    if (titulo && enlace) {
      log.info(`→ ${titulo}`);
      await Actor.pushData({ titulo, enlace });
    }
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset de la ejecución.");
});
