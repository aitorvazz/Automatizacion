import { Actor, log } from "apify";
import { chromium } from "playwright";

const START_URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async (ms = 12000) => {
    try { await page.waitForLoadState("networkidle", { timeout: ms }); } catch {}
  };

  // 1) Abrir y cookies
  log.info("Abriendo búsqueda…");
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await waitIdle();
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cookiesBtn.click(); await waitIdle();
      log.info("Cookies aceptadas");
    }
  } catch {}

  // Helpers de filtros (combos RUP)
  async function setSelectByLabelJS(labelText, visibleText) {
    return page.evaluate(({ labelText, visibleText }) => {
      function findSelectNearLabel(labelTxt) {
        const labels = Array.from(document.querySelectorAll("label"));
        for (const lb of labels) {
          const t = (lb.textContent || "").trim().toLowerCase();
          if (!t.includes(labelTxt.toLowerCase())) continue;
          const forId = lb.getAttribute("for");
          if (forId) {
            const byFor = document.getElementById(forId);
            if (byFor && byFor.tagName === "SELECT") return byFor;
          }
          const local = lb.parentElement?.querySelector("select") || lb.nextElementSibling?.querySelector?.("select");
          if (local) return local;
        }
        return null;
      }
      const sel = findSelectNearLabel(labelText);
      if (!sel) return false;
      const opts = Array.from(sel.options);
      const found = opts.find(o => (o.textContent || "").trim().toLowerCase() === visibleText.toLowerCase());
      if (!found) return false;
      sel.value = found.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { labelText, visibleText });
  }
  async function setComboByLabel(label, text) {
    try {
      const combo = page.locator(`xpath=//label[contains(normalize-space(.),'${label}')]/following::*[@role='combobox' or contains(@class,'rup_combo')][1]`).first();
      if (!(await combo.isVisible({ timeout: 2000 }).catch(() => false))) return false;
      await combo.click();
      const inner = combo.locator("input, .ui-autocomplete-input").first();
      if (await inner.isVisible().catch(() => false)) {
        await inner.fill("");
        await inner.type(text, { delay: 40 });
        await page.keyboard.press("Enter");
        return true;
      }
      await page.keyboard.type(text, { delay: 40 });
      await page.keyboard.press("Enter");
      return true;
    } catch { return false; }
  }
  async function applyFilter(label, value) {
    // getByLabel directo
    try {
      const ctrl = page.getByLabel(label, { exact: false });
      if (await ctrl.isVisible({ timeout: 500 }).catch(() => false)) {
        await ctrl.selectOption({ label: value }, { timeout: 4000 });
        return true;
      }
    } catch {}
    // JS sobre <select>
    if (await setSelectByLabelJS(label, value)) return true;
    // Combo RUP (buscar, teclear, Enter)
    if (await setComboByLabel(label, value)) return true;
    return false;
  }

  // 2) Filtros + Buscar
  const okTipo = await applyFilter("Tipo de contrato", "Suministros");
  const okEstado = await applyFilter("Estado", "Abierto");
  log.info(`Filtros aplicados: tipo=${okTipo} estado=${okEstado}`);
  const buscar = page.getByRole("button", { name: /buscar/i });
  if (await buscar.isVisible().catch(() => false)) await buscar.click(); else await page.click("button[type='submit']").catch(() => {});
  await waitIdle();
  await page.waitForTimeout(1000);

  // 3) Esperar tabla/lista de resultados y recoger enlaces
  //    — intentamos primero “table tbody tr”
  let rows = page.locator("table tbody tr");
  let total = await rows.count().catch(() => 0);
  if (!total) {
    // alternativa: tarjetas
    rows = page.locator(".resultado, .filaResultado, [data-anuncio]");
    total = await rows.count().catch(() => 0);
  }
  log.info(`Filas detectadas: ${total}`);

  // recoger anchors de detalle desde la tabla
  let detailLinks = await page.evaluate((base) => {
    const anchors = Array.from(document.querySelectorAll("table tbody tr a[href], .resultado a[href], .filaResultado a[href], [data-anuncio] a[href]"));
    const cleaned = anchors
      .map(a => ({ href: a.getAttribute("href") || "", abs: a.href, text: (a.textContent || "").trim() }))
      .filter(x => x.href && !x.href.startsWith("#"))
      .filter(x => !/^javascript:/i.test(x.href))
      .filter(x => !x.abs.startsWith(base)) // descarta buscador
      .filter(x => /(ver|detalle|anuncio|expediente|contrato|idAnuncio|ac70cPublicidadWar)/i.test(x.href + " " + x.text))
      .map(x => x.abs);
    // únicos
    return Array.from(new Set(cleaned));
  }, START_URL);

  // Si sigue vacío, plan B: click en cada fila y leer URL real
  if (!detailLinks.length && total) {
    log.info("No se detectaron enlaces por href, probando clic fila por fila…");
    for (let i = 0; i < Math.min(total, 50); i++) {
      const a = rows.nth(i).locator("a[href]").first();
      if (!(await a.isVisible().catch(() => false))) continue;
      const before = page.url();
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null),
        a.click({ timeout: 8000 })
      ]);
      const after = page.url();
      if (after && after !== before) detailLinks.push(after);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await waitIdle(6000);
    }
    detailLinks = Array.from(new Set(detailLinks));
  }

  log.info(`Enlaces de detalle detectados: ${detailLinks.length}`);
  if (!detailLinks.length) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      await Actor.setValue("debug_sin_links.png", buf, { contentType: "image/png" });
      log.warning("Sin enlaces detectados. Guardada captura debug_sin_links.png");
    } catch {}
  }

  // 4) Utilidades de lectura en ficha
  const readField = async (detailPage, labelTextVariants) => {
    for (const labelText of labelTextVariants) {
      try {
        // exacto
        let node = detailPage.locator(`text="${labelText}"`).first();
        if (!(await node.isVisible().catch(() => false))) {
          // contiene
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

  // 5) Visitar cada detalle y extraer
  for (const enlace of detailLinks) {
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();

    const titulo = (await page.locator("h1, .titulo, .cabecera h1").first().innerText().catch(() => "")).trim() || null;

    const organoTxt = await readField(page, ["Órgano", "Órgano de contratación"]);
    const procedimientoTxt = await readField(page, ["Procedimiento"]);
    const presupuestoTxt = await readField(page, ["Presupuesto", "Presupuesto base de licitación"]);
    const valorEstimadoTxt = await readField(page, ["Valor estimado"]);
    const presentacionTxt = await readField(page, [
      "Presentación de ofertas",
      "Fecha fin de presentación",
      "Fin de plazo de presentación"
    ]);
    const cpvTxt = await readField(page, ["CPV", "Códigos CPV"]);

    const cpv = cpvTxt ? (cpvTxt.match(/\b\d{8}\b/) || [null])[0] : null;
    const presupuesto = presupuestoTxt ? (presupuestoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const valorEstimado = valorEstimadoTxt ? (valorEstimadoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const fechaLimite = presentacionTxt ? (presentacionTxt.match(/\b\d{2}\/\d{2}\/\d{4}\b/) || [null])[0] : null;

    await Actor.pushData({
      titulo, enlace,
      organo: organoTxt || null,
      procedimiento: procedimientoTxt || null,
      presupuesto,
      valorEstimado,
      fechaLimite,
      cpv
    });
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset.");
});
