import { Actor, log } from "apify";
import { chromium } from "playwright";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const RSS_URL = "https://www.contratacion.euskadi.eus/w32-kpeperfi/eu/r01PubWar/rssFeed?anuncios=true"; 
// ⚠️ Ajusta esta URL al feed RSS correcto de suministros abiertos, ahora pongo un ejemplo genérico

await Actor.main(async () => {
  // 1) Descargar y parsear el RSS
  log.info("Descargando RSS...");
  const res = await fetch(RSS_URL);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const rss = parser.parse(xml);

  const items = rss?.rss?.channel?.item || [];
  log.info(`Items RSS detectados: ${items.length}`);

  // 2) Lanzar navegador
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async () => { try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {} };

  // Helpers para leer ficha
  const readBlockByLabel = async (detailPage, variants) => {
    for (const labelText of variants) {
      try {
        let node = detailPage.locator(`text="${labelText}"`).first();
        if (!(await node.isVisible().catch(() => false))) {
          node = detailPage.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]`).first();
        }
        if (!(await node.isVisible().catch(() => false))) continue;
        const block = await node.locator("xpath=..").innerText().catch(() => "");
        if (!block) continue;
        return block.replace(/\s+/g, " ").trim();
      } catch {}
    }
    return null;
  };

  const readHrefByLabel = async (detailPage, variants) => {
    for (const labelText of variants) {
      try {
        const linkNear = detailPage.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]/following::a[1]`).first();
        if (await linkNear.isVisible().catch(() => false)) {
          const href = await linkNear.getAttribute("href").catch(() => null);
          if (href) return new URL(href, detailPage.url()).toString();
        }
      } catch {}
    }
    return null;
  };

  const extractFirstDate = (txt) => {
    if (!txt) return null;
    const m = txt.match(/\b\d{2}\/\d{2}\/\d{4}\b/);
    return m ? m[0] : null;
  };

  // 3) Procesar cada anuncio
  for (const it of items) {
    const enlace = it.link;
    const titulo = it.title;

    if (!enlace) continue;
    log.info(`Procesando → ${titulo}`);

    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();

    const expedienteTxt = await readBlockByLabel(page, ["Expediente", "Nº de expediente"]);
    const fechaPrimeraTxt = await readBlockByLabel(page, ["Fecha primera publicación"]);
    const fechaUltimaTxt = await readBlockByLabel(page, ["Fecha última publicación"]);
    const tipoContratoTxt = await readBlockByLabel(page, ["Tipo de contrato"]);
    const estadoTramTxt = await readBlockByLabel(page, ["Estado de la tramitación", "Estado"]);
    const plazoPresentacionTxt = await readBlockByLabel(page, ["Plazo de presentación"]);
    const fechaLimiteTxt = await readBlockByLabel(page, ["Fecha límite de presentación"]);
    const presupuestoSinIvaTxt = await readBlockByLabel(page, ["Presupuesto del contrato sin IVA"]);
    const poderAdjudicadorTxt = await readBlockByLabel(page, ["Poder adjudicador"]);
    const entidadImpulsoraTxt = await readBlockByLabel(page, ["Entidad Impulsora"]);
    const urlLicitacion = await readHrefByLabel(page, ["Dirección web de licitación electrónica"]);

    const item = {
      titulo,
      enlace,
      expediente: expedienteTxt,
      fechaPrimeraPublicacion: extractFirstDate(fechaPrimeraTxt),
      fechaUltimaPublicacion: extractFirstDate(fechaUltimaTxt),
      tipoContrato: tipoContratoTxt,
      estadoTramitacion: estadoTramTxt,
      plazoPresentacion: plazoPresentacionTxt,
      fechaLimitePresentacion: extractFirstDate(fechaLimiteTxt),
      presupuestoSinIVA: presupuestoSinIvaTxt,
      poderAdjudicador: poderAdjudicadorTxt,
      entidadImpulsora: entidadImpulsoraTxt,
      direccionLicitacionElectronica: urlLicitacion,
    };

    await Actor.pushData(item);
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
