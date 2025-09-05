# Automatizacion
Normicro
# Scraper Euskadi – Suministros Abiertos

Este actor de **Apify** automatiza la extracción de **11 parámetros** de los anuncios publicados en [contratacion.euskadi.eus](https://www.contratacion.euskadi.eus/).

## 🔎 ¿Qué datos extrae?
Para cada anuncio en el listado se recogen los siguientes campos:

1. **Expediente**  
2. **Fecha primera publicación**  
3. **Fecha última publicación**  
4. **Tipo de contrato**  
5. **Estado de la tramitación**  
6. **Plazo de presentación**  
7. **Fecha límite de presentación**  
8. **Presupuesto del contrato sin IVA**  
9. **Poder adjudicador**  
10. **Entidad impulsora**  
11. **Dirección web de licitación electrónica**

Cada registro también incluye `urlFicha` si hay un enlace disponible.

## ⚙️ Configuración de entrada
Este actor usa un [`INPUT_SCHEMA.json`](./INPUT_SCHEMA.json), por lo que en la **consola de Apify** verás un formulario con estos campos:

- **URL del listado filtrado (`startUrl`)**  
  Pega aquí la URL de contratación.euskadi.eus con los filtros ya aplicados  
  (ej. Tipo de contrato = *Suministros*, Estado = *Abierto*).  

- **Número máximo de páginas (`maxPages`)**  
  Número de páginas a recorrer. Cada página suele contener 10 anuncios.  
  Valor por defecto: `20`.

- **Headless (`headless`)**  
  Si está activado (true), el navegador se ejecuta en segundo plano (sin ventana visible).  

Ejemplo de input JSON equivalente:
```json
{
  "startUrl": "https://www.contratacion.euskadi.eus/...tu_url_filtrada...",
  "maxPages": 15,
  "headless": true
}
