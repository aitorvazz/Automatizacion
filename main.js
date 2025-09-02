import { Actor, log } from "apify";
import { chromium } from "playwright";

const URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  log.info("Abriendo búsqueda…");
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // --- APLICA FILTROS (ajusta si el name/label cambia) ---
  await page.selectOption("select[name='tipoContrato']", { label: /Suministros/i }).catch(()=>{});
  await page.selectOption("select[name='estado']", { label: /Abierto/i }).catch(()=>{});
  // Botón Buscar (por rol o por CSS genérico)
  const btn = page.getByRole("button", { name: /buscar/i });
  if (await btn.isVisible().catch(()=>false)) await btn.click();
  else await page.click("button[type='submit']").catch(()=>{});
  await page.waitForLoadState("networkidle");

  // --- LISTA DE RESULTADOS (ajusta el contenedor si hiciera falta) ---
  const rows = page.locator("[data-anuncio], .anuncio, .filaResultado, .resultado");
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
