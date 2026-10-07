require('dotenv/config');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3001;

// ============= CONFIGURACIÓN HELPPIUPAY =============
const HELPPIU_KEY_ID = process.env.HELPPIU_KEY_ID;
const HELPPIU_SECRET = process.env.HELPPIU_SECRET;
const HELPPIU_API_URL = process.env.HELPPIU_API_URL || 'https://helppiupay.com/api/v1/checkout-sessions';

app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy-Report-Only', "default-src * 'unsafe-inline' 'unsafe-eval'");
  next();
});
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============= POOL DE NAVEGADORES =============
let browserPool = [];
const MAX_PAGES = 5;
const POOL_SIZE = 3;
let activeConsultations = 0;
const consultationQueue = [];

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function initializeBrowserPool() {
  console.log('[POOL] Inicializando pool de navegadores...');
  for (let i = 0; i < Math.min(POOL_SIZE, 1); i++) {
    const b = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    browserPool.push(b);
  }
  console.log(`[POOL] Pool iniciado con ${browserPool.length} navegador(es)`);
}

async function getBrowserFromPool() {
  if (browserPool.length > 0) {
    return browserPool.pop();
  }
  if (activeConsultations < MAX_PAGES) {
    return await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  }
  return new Promise((resolve) => {
    consultationQueue.push(resolve);
  });
}

function returnBrowserToPool(b) {
  if (browserPool.length < POOL_SIZE) {
    browserPool.push(b);
  }
  if (consultationQueue.length > 0) {
    const resolve = consultationQueue.shift();
    resolve(b);
  }
}

async function consultarZonaPagos(documento, placa) {
  activeConsultations++;
  let browserInstance = null;

  try {
    console.log(`[API] Consultando (${activeConsultations} activas) - Documento: ${documento}, Placa: ${placa}`);

    browserInstance = await getBrowserFromPool();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    console.log('[API] PASO 1: Navegando a PreLoginPage...');
    await page.goto('https://zonapagos.com/NV_PagosN3/Views/preLogin/PreLoginPage.aspx?ico=33968', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await esperar(2000);

    console.log('[API] PASO 2: Esperando formulario...');
    await page.waitForSelector('input', { timeout: 15000 });
    await esperar(1000);

    console.log('[API] PASO 3: Llenando documento...');
    const inputs = await page.$$('input[type="text"]');
    if (inputs.length >= 1) {
      await inputs[0].click();
      await inputs[0].type(documento, { delay: 30 });
    }

    console.log('[API] PASO 4: Llenando placa...');
    if (inputs.length >= 2) {
      await inputs[1].click();
      await inputs[1].type(placa, { delay: 30 });
    }

    console.log('[API] PASO 5: Haciendo click en Continuar...');
    const btn = await page.$('button[type="submit"], input[type="submit"]');
    if (btn) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
          btn.click()
        ]);
        console.log('[API] Navegación completada');
      } catch (e) {
        console.log('[API] Navegación no detectada:', e.message);
        await esperar(5000);
      }
    }

    console.log('[API] PASO 6: Esperando tabla de facturas...');
    try {
      await page.waitForSelector('table', { timeout: 15000 });
      console.log('[API] Tabla detectada');
    } catch (e) {
      console.log('[API] No apareció tabla, puede ser un mensaje de error');
    }

    await esperar(1500);

    console.log('[API] PASO 7: Extrayendo datos con tabla...');

    let datosExtraidos = [];
    try {
      datosExtraidos = await page.evaluate(() => {
        const datos = [];
        const tablas = document.querySelectorAll('table');

        for (let tabla of tablas) {
          const rows = tabla.querySelectorAll('tr');
          for (let row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length > 5) {
              const rowData = {
                numeroCredito: cells[1]?.textContent?.trim() || '',
                tipoIdentificacion: cells[3]?.textContent?.trim() || '',
                identificacion: cells[4]?.textContent?.trim() || '',
                nombre: cells[5]?.textContent?.trim() || '',
                apellido: cells[6]?.textContent?.trim() || '',
                email: cells[7]?.textContent?.trim() || '',
                telefono: cells[8]?.textContent?.trim() || '',
                placa: cells[10]?.textContent?.trim() || '',
                fechaVencimiento: cells[14]?.textContent?.trim() || '',
                valorSugerido: cells[15]?.textContent?.trim() || ''
              };
              if (rowData.numeroCredito || rowData.placa) {
                datos.push(rowData);
              }
            }
          }
        }

        return datos;
      });
    } catch (e) {
      console.log('[API] Error en evaluate, reintentando...', e.message);
      await esperar(2000);
      try {
        datosExtraidos = await page.evaluate(() => {
          const datos = [];
          const tablas = document.querySelectorAll('table');
          for (let tabla of tablas) {
            const rows = tabla.querySelectorAll('tr');
            for (let row of rows) {
              const cells = row.querySelectorAll('td');
              if (cells.length > 5) {
                const rowData = {
                  numeroCredito: cells[1]?.textContent?.trim() || '',
                  tipoIdentificacion: cells[3]?.textContent?.trim() || '',
                  identificacion: cells[4]?.textContent?.trim() || '',
                  nombre: cells[5]?.textContent?.trim() || '',
                  apellido: cells[6]?.textContent?.trim() || '',
                  email: cells[7]?.textContent?.trim() || '',
                  telefono: cells[8]?.textContent?.trim() || '',
                  placa: cells[10]?.textContent?.trim() || '',
                  fechaVencimiento: cells[14]?.textContent?.trim() || '',
                  valorSugerido: cells[15]?.textContent?.trim() || ''
                };
                if (rowData.numeroCredito || rowData.placa) {
                  datos.push(rowData);
                }
              }
            }
          }
          return datos;
        });
      } catch (e2) {
        console.log('[API] Segundo intento falló:', e2.message);
      }
    }

    console.log('[API] Datos extraídos:', datosExtraidos);
    await page.close();

    if (datosExtraidos.length > 0) {
      console.log('[API] ✅ Consulta exitosa');
      return {
        estado: 'exitoso',
        documento: documento,
        placa: placa,
        facturas: datosExtraidos,
        timestamp: new Date().toISOString()
      };
    } else {
      console.log('[API] ⚠️ No se encontraron facturas');
      return {
        error: 'No se encontraron facturas',
        estado: 'no_encontrado',
        documento: documento,
        placa: placa
      };
    }

  } catch (error) {
    console.error('[API ERROR]', error.message);
    throw error;
  } finally {
    activeConsultations--;
    if (browserInstance) {
      returnBrowserToPool(browserInstance);
    }
  }
}

app.post('/api/consultar', async (req, res) => {
  try {
    const { documento, placa } = req.body;

    if (!documento || !placa) {
      return res.status(400).json({
        error: 'Documento y placa son requeridos',
        estado: 'error'
      });
    }

    const resultado = await consultarZonaPagos(documento, placa);

    if (resultado.estado === 'exitoso') {
      res.json(resultado);
    } else {
      res.status(404).json(resultado);
    }

  } catch (error) {
    console.error('[API ERROR]', error.message);
    res.status(500).json({
      error: 'Error al consultar: ' + error.message,
      estado: 'error'
    });
  }
});

// ============= ENDPOINT: PAGAR CON HELPPIUPAY (CHECKOUT SESSIONS) =============
app.post('/api/pagar-helppiupay', async (req, res) => {
  try {
    const {
      credito,
      valor,
      nombre,
      apellido,
      email,
      telefono,
      identificacion
    } = req.body;

    if (!credito || !valor) {
      return res.status(400).json({ error: 'Faltan credito o valor' });
    }

    if (!HELPPIU_KEY_ID || !HELPPIU_SECRET) {
      return res.status(500).json({ error: 'Faltan llaves de HelppiuPay en el servidor' });
    }

    const valorLimpio = String(valor).replace(/[^\d]/g, '');
    const amount = parseInt(valorLimpio, 10);

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'El valor no es válido: ' + valor });
    }

    if (amount < 1000) {
      return res.status(400).json({ error: 'El monto mínimo es 1000 COP' });
    }

    const nombreCompleto = `${nombre || ''} ${apellido || ''}`.trim();

    // Body para Checkout Sessions
    const body = {
      reference: `GM-${credito}-${Date.now()}`,
      amount: amount,
      currency: 'COP',
      description: `Pago crédito GM Financial #${credito}`,
      success_url: 'https://tusitio.com/pago-exitoso',
      cancel_url: 'https://tusitio.com/pago-cancelado',
      customer_email: email || '',
      customer_name: nombreCompleto,
      payment_method_types: ['pse']
    };

    console.log('[HELPPIU] Checkout Session - Crédito:', credito, '- Monto:', amount);

    const authHeader = `Bearer ${HELPPIU_KEY_ID}:${HELPPIU_SECRET}`;

    const response = await fetch(HELPPIU_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(body)
    });

    const textoRespuesta = await response.text();
    let data;

    try {
      data = JSON.parse(textoRespuesta);
    } catch (e) {
      console.error('[HELPPIU] Respuesta no es JSON:', textoRespuesta.substring(0, 500));
      return res.status(response.status).json({
        error: 'HelppiuPay devolvió una respuesta no válida',
        statusCode: response.status,
        detalle: textoRespuesta.substring(0, 500)
      });
    }

    if (!response.ok) {
      console.error('[HELPPIU ERROR]', data);
      return res.status(response.status).json({
        error: data.message || data.error || 'Error al crear la sesión',
        detalle: data
      });
    }

    const checkoutUrl = data.url || data.checkout_url;

    if (!checkoutUrl) {
      console.error('[HELPPIU] No se recibió url. Respuesta:', data);
      return res.status(500).json({
        error: 'HelppiuPay no devolvió una URL de pago',
        detalle: data
      });
    }

    console.log('[HELPPIU] URL generada:', checkoutUrl);
    res.json({ url: checkoutUrl });

  } catch (error) {
    console.error('[HELPPIU ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeConsultations: activeConsultations,
    browserPoolSize: browserPool.length,
    queuedRequests: consultationQueue.length,
    helppiupayConfigured: !!(HELPPIU_KEY_ID && HELPPIU_SECRET),
    helppiuUrl: HELPPIU_API_URL
  });
});

app.use(express.static('.'));

app.get('/', (req, res) => {
  res.send('<h1>API GM Financial</h1>');
});

async function start() {
  try {
    await initializeBrowserPool();

    app.listen(PORT, () => {
      console.log(`✅ Servidor en puerto ${PORT}`);
      console.log(`🔗 POST http://localhost:${PORT}/api/consultar`);
      console.log(`🔗 POST http://localhost:${PORT}/api/pagar-helppiupay`);
      console.log(`📍 Pool: ${POOL_SIZE} navegadores, máx ${MAX_PAGES} consultas`);
      console.log(`💳 HelppiuPay configurado: ${!!(HELPPIU_KEY_ID && HELPPIU_SECRET)}`);
      console.log(`🌐 HelppiuPay URL: ${HELPPIU_API_URL}`);
    });
  } catch (error) {
    console.error('Error al iniciar:', error);
    process.exit(1);
  }
}

start();