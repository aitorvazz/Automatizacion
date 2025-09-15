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
    // Busca select por label
    await page.locator("label:has-text('Tipo de contrato')").locator(".. select").selectOption({ label: /Suministros/i });
    await page.locator("label:has-text('Estado')").locator(".. select").selectOption({ label: /Abierto/i });
    log.info("Filtros aplicados");
  } catch (e) {
    log.warning("No se pudieron aplicar los filtros: " + e.message);
  }

  // Botón Buscar
  try {
    const btn = page.getByRole("button", { name: /buscar/i });
    if (await btn.isVisible().catch(() => false)) await btn.click();
    else await page.click("button[type='submit']").catch(() => {});
    log.info("Click en buscar");
  } catch {}

  await page.waitForTimeout(5000); // da tiempo a que cargue resultados

  // --- LISTA DE RESULTADOS ---
  const rows = page.locator("table tbody tr, .resultado, .filaResultado");
  const count = await rows.count().catch(() => 0);
  log.info(Resultados en la primera página: ${count});
