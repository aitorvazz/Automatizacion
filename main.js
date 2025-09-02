import { Actor, log } from "apify";
import { chromium } from "playwright";

const URL = "https://www.contratacion.euskadi.eus/webkpe00-kpeperfi/es/ac70cPublicidadWar/busquedaAnuncios?locale=es";

await Actor.main(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  const waitIdle = async () => {
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}
  };

  log.info("Abriendo búsqueda…");
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await waitIdle();

  // --- Cookies ---
  try {
    const cookiesBtn = page.getByRole("button", { name: /(aceptar|aceptar todas|onartu)/i });
    if (await cookiesBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cookiesBtn.click();
      log.info("Cookies aceptadas");
      await waitIdle();
    }
  } catch {}

  // Helper: setear <select> por texto visible vía JS
  async function setSelectByLabelJS(labelText, visibleText) {
    return page.evaluate(({ labelText, visibleText }) => {
      function findSelectNearLabel(labelTxt) {
        // 1) label[for]
        const labels = Array.from(document.querySelectorAll("label"));
        let targetSelect = null;
        for (const lb of labels) {
          if (!lb.textContent) continue;
          if (lb.textContent.normalize().toLowerCase().includes(labelTxt.toLowerCase())) {
            const forId = lb.getAttribute("for");
            if (forId) {
              const byFor = document.getElementById(forId);
              if (byFor && byFor.tagName === "SELECT") { targetSelect = byFor; break; }
            }
            // 2) primer select en los siguientes hermanos
            const sel = lb.parentElement?.querySelector("select") || lb.nextElementSibling?.querySelector?.("select");
            if (sel) { targetSelect = sel; break; }
            // 3) buscar en el documento (fallback)
            const allSelects = Array.from(document.querySelectorAll("select"));
            for (const s of allSelects) {
              if (s.id?.toLowerCase().includes("tipo") && labelTxt.toLowerCase().includes("tipo")) { targetSelect = s; break; }
              if (s.id?.toLowerCase().includes("estado") && labelTxt.toLowerCase().includes("estado")) { targetSelect = s; break; }
            }
          }
        }
        return targetSelect;
      }
      const sel = findSelectNearLabel(labelText);
      if (!sel) return false;
      const opts = Array.from(sel.options);
      const found = opts.find(o => (o.textContent || "").trim().toLowerCase().includes(visibleText.toLowerCase()));
      if (!found) return false;
      sel.value = found.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { labelText, visibleText });
  }

  // Helper: RUP combo (combobox) — click, escribir y Enter
  async function setComboByLabel(label, text) {
    try {
      // localizar combobox accesible cercano a la etiqueta
      const combo = page.locator(`xpath=//label[contains(normalize-space(.),'${label}')]/following::*[@role='combobox' or contains(@class,'rup_combo')][1]`);
      if (!(await combo.first().isVisible({ timeout: 3000 }).catch(() => false))) return false;
      await combo.first().click();
      // si hay input editable dentro
      const innerInput = combo.locator("input, .ui-autocomplete-input").first();
      if (await innerInput.isVisible().catch(() => false)) {
        await innerInput.fill("");
        await innerInput.type(text, { delay: 50 });
        await page.keyboard.press("Enter");
        return true;
      } else {
        // abrir desplegable y escoger por lista
        await page.keyboard.type(text, { delay: 50 });
        await page.keyboard.press("Enter");
        return true;
      }
    } catch {
      return false;
    }
  }

  // Helper principal para aplicar filtro con 3 intentos
  async function applyFilter(label, valueText) {
    // 1) intentamos getByLabel().selectOption()
    try {
      const ctrl = page.getByLabel(label, { exact: false });
      if (await ctrl.isVisible({ timeout: 1000 }).catch(() => false)) {
        await ctrl.selectOption({ label: valueText }, { timeout: 5000 });
        return true;
      }
    } catch {}
    // 2) intentamos JS directo sobre <select>
    const okJS = await setSelectByLabelJS(label, valueText);
    if (okJS) return true;
    // 3) intentamos combo RUP
    const okCombo = await setComboByLabel(label, valueText);
    if (okCombo) return true;

    return false;
  }

  // --- Aplicar filtros robustos ---
  const okTipo = await applyFilter("Tipo de contrato", "Suministros");
  const okEstado = await applyFilter("Estado", "Abierto");
  log.info(`Filtros aplicados: tipo=${okTipo} estado=${okEstado}`);
  await waitIdle();

  // --- Buscar ---
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Click en buscar");
  } catch {}
  await waitIdle();
  await page.waitForTimeout(1500);

  // --- Resultados (intenta varias estructuras) ---
  let rows = page.locator("table tbody tr");
  let count = await rows.count().catch(() => 0);
  if (!count) {
    rows = page.locator(".resultado, .filaResultado, [data-anuncio]");
    count = await rows.count().catch(() => 0);
  }
  if (!count) {
    // último recurso: lista de anchors hacia detalle
    rows = page.locator("a[href*='ac70cPublicidadWar'][href*='ver'], a[href*='PublicidadWar']");
    count = await rows.count().catch(() => 0);
  }
  log.info(`Resultados en la primera página: ${count}`);

  // Utilidad: leer valor por etiqueta en ficha
  const readField = async (detailPage, labelText) => {
    try {
      // prueba exacta
      let node = detailPage.locator(`text="${labelText}"`).first();
      if (!(await node.isVisible().catch(() => false))) {
        // prueba contiene
        node = detailPage.locator(`xpath=//*[contains(normalize-space(.),'${labelText}')]`).first();
      }
      if (!(await node.isVisible().catch(() => false))) return null;
      const block = await node.locator("xpath=..").innerText().catch(() => "");
      if (!block) return null;
      return block.replace(/\s+/g, " ").trim();
    } catch {
      return null;
    }
  };

  for (let i = 0; i < count; i++) {
    // Obtener enlace y título desde la fila/anchor detectado
    let anchor;
    if (await rows.nth(i).locator("a").count().catch(() => 0)) {
      anchor = rows.nth(i).locator("a").first();
    } else {
      anchor = rows.nth(i);
    }
    const titulo = (await anchor.innerText().catch(() => "")).trim();
    const href = await anchor.getAttribute("href").catch(() => null);
    const enlace = href ? new URL(href, page.url()).toString() : null;
    if (!enlace) continue;

    // Ir al detalle
    await page.goto(enlace, { waitUntil: "domcontentloaded" });
    await waitIdle();

    const organoTxt = await readField(page, "Órgano");
    const procedimientoTxt = await readField(page, "Procedimiento");
    const presupuestoTxt = await readField(page, "Presupuesto");
    const valorEstimadoTxt = await readField(page, "Valor estimado");
    const presentacionTxt = await readField(page, "Presentación de ofertas");
    const cpvTxt = await readField(page, "CPV");

    const cpv = cpvTxt ? (cpvTxt.match(/\b\d{8}\b/) || [null])[0] : null;
    const presupuesto = presupuestoTxt ? (presupuestoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const valorEstimado = valorEstimadoTxt ? (valorEstimadoTxt.match(/([\d\.\s]+,\d{2})\s*€?/) || [null, null])[1] : null;
    const fechaLimite = presentacionTxt ? (presentacionTxt.match(/\b\d{2}\/\d{2}\/\d{4}\b/) || [null])[0] : null;

    const item = {
      titulo: titulo || null,
      enlace,
      organo: organoTxt || null,
      procedimiento: procedimientoTxt || null,
      presupuesto,
      valorEstimado,
      fechaLimite,
      cpv
    };
    log.info(`→ ${item.titulo || enlace}`);
    await Actor.pushData(item);

    // Volver a la lista
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await waitIdle();
  }

  await browser.close();
  log.info("Hecho. Revisa el Dataset de la ejecución.");
});
